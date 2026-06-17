import { APICallError, AISDKError, LoadAPIKeyError, NoSuchModelError, RetryError } from "ai";

/**
 * What went wrong with an LLM call, coarse enough to drive a clear message and
 * a sensible UI response (retry vs. fix-your-key vs. add-credits).
 */
export type LlmErrorKind =
  | "auth" // missing or rejected API key
  | "credits" // out of credits / quota / billing
  | "rate_limit" // throttled — retry later
  | "timeout" // request timed out
  | "connection" // couldn't reach the provider (network / local server down)
  | "model" // unknown or unavailable model
  | "bad_response" // empty or unparseable output
  | "bad_request" // 400 we couldn't classify further
  | "server" // provider returned a 5xx
  | "unknown";

/**
 * A provider-agnostic, already-user-facing LLM failure. Every `AiSdkClient`
 * method rejects with one of these (via `normalizeLlmError`) so the chat route,
 * ingest inbox and any other consumer can show the user something actionable
 * instead of a raw SDK stack trace or provider JSON blob.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: LlmErrorKind,
    readonly provider?: string,
    readonly statusCode?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmError";
  }
}

/** Words that mean "you've run out of money/quota" across providers' error bodies. */
const CREDIT_SIGNALS = [
  "insufficient",
  "credit balance",
  "credit_balance",
  "out of credit",
  "quota",
  "billing",
  "exceeded your current",
  "payment",
  "plan and billing",
  "purchase",
];

/** Words that mean "slow down" rather than "you're out of money". */
const RATE_LIMIT_SIGNALS = [
  "rate limit",
  "rate_limit",
  "too many requests",
  "overloaded",
  "try again",
];

function contains(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Pull the provider's own human-readable reason out of an HTTP error so we can
 * append it to our message instead of hiding it behind a canned line. Local
 * servers (Ollama, LM Studio) report precise, actionable causes here — e.g.
 * "llama3:latest does not support tools" — which our generic 400 text masks.
 * Returns a trimmed single line, or undefined when there's nothing useful.
 */
function extractProviderMessage(error: APICallError): string | undefined {
  const fromBody = (body: string): string | undefined => {
    try {
      const parsed = JSON.parse(body) as {
        error?: string | { message?: string };
        message?: string;
      };
      const raw =
        (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? parsed.message;
      if (typeof raw === "string" && raw.trim()) return raw;
    } catch {
      // Not JSON — fall back to the raw body if it's short enough to be a message.
      if (body.length <= 300) return body;
    }
    return undefined;
  };

  const candidate = (error.responseBody && fromBody(error.responseBody)) || error.message;
  const cleaned = candidate?.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned : undefined;
}

/** Pretty provider name for messages, given the raw config provider id. */
export function providerLabel(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google Gemini";
    case "local":
      return "the local model server";
    default:
      return provider;
  }
}

/**
 * Map any thrown value from an AI SDK call onto a `LlmError` with a message the
 * user can act on. Already-normalized errors pass through; unknown shapes
 * degrade to a generic "unknown" rather than leaking internals.
 */
export function normalizeLlmError(error: unknown, provider?: string): LlmError {
  if (error instanceof LlmError) return error;

  const who = provider ? providerLabel(provider) : "the model provider";

  // Retries exhausted: the wrapper carries the underlying failure — classify that.
  if (RetryError.isInstance(error) && error.lastError !== undefined) {
    return normalizeLlmError(error.lastError, provider);
  }

  // No key configured at all (provider factory threw before any HTTP call).
  if (LoadAPIKeyError.isInstance(error)) {
    return new LlmError(
      `No ${who} API key is set. Add one in Settings → Model.`,
      "auth",
      provider,
      undefined,
      { cause: error },
    );
  }

  if (NoSuchModelError.isInstance(error)) {
    const modelId = error.modelId;
    return new LlmError(
      `${who} doesn't recognise the model "${modelId}". Pick a different model in Settings.`,
      "model",
      provider,
      undefined,
      { cause: error },
    );
  }

  if (APICallError.isInstance(error)) {
    const apiError = error;
    const status = apiError.statusCode;
    const haystack = `${apiError.message}\n${apiError.responseBody ?? ""}`.toLowerCase();
    return classifyApiError(apiError, status, haystack, who, provider);
  }

  // Connection failures (local Ollama down, DNS/offline) surface as plain
  // Errors with telltale causes rather than AI SDK error classes.
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    contains(lower, [
      "econnrefused",
      "fetch failed",
      "enotfound",
      "network",
      "socket hang up",
      "und_err",
    ]) ||
    (error instanceof Error &&
      (error.cause as { code?: string } | undefined)?.code === "ECONNREFUSED")
  ) {
    return new LlmError(
      `Couldn't reach ${who}. Check your connection${provider === "local" ? " and that the local server is running at the configured endpoint" : ""}.`,
      "connection",
      provider,
      undefined,
      { cause: error },
    );
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new LlmError(
      `${who} took too long to respond. Try again.`,
      "timeout",
      provider,
      undefined,
      {
        cause: error,
      },
    );
  }

  // Empty / unparseable output: the call succeeded but the answer was unusable.
  if (
    AISDKError.isInstance(error) &&
    contains(lower, [
      "no object generated",
      "empty response",
      "no content",
      "type validation",
      "json",
      "could not parse",
    ])
  ) {
    return new LlmError(
      `${who} returned a response that couldn't be read. Try again, or switch model in Settings.`,
      "bad_response",
      provider,
      undefined,
      { cause: error },
    );
  }

  return new LlmError(
    `Something went wrong talking to ${who}: ${message}`,
    "unknown",
    provider,
    undefined,
    { cause: error },
  );
}

/** Classify an HTTP-level provider error from its status code and body text. */
function classifyApiError(
  error: APICallError,
  status: number | undefined,
  haystack: string,
  who: string,
  provider?: string,
): LlmError {
  const creditsHit = contains(haystack, CREDIT_SIGNALS);

  if (status === 401 || status === 403) {
    return new LlmError(
      `${who} rejected your API key (${status}). Check it in Settings → Model.`,
      "auth",
      provider,
      status,
      { cause: error },
    );
  }
  if (status === 402 || (status === 429 && creditsHit) || creditsHit) {
    return new LlmError(
      `Your ${who} account is out of credits or has hit its quota. Add credits in your ${who} account, or switch provider in Settings.`,
      "credits",
      provider,
      status,
      { cause: error },
    );
  }
  if (status === 429) {
    return new LlmError(
      `${who} is rate-limiting requests. Wait a moment and try again.`,
      "rate_limit",
      provider,
      status,
      { cause: error },
    );
  }
  if (status === 404) {
    return new LlmError(
      `${who} couldn't find that model or endpoint (404). Check the model in Settings.`,
      "model",
      provider,
      status,
      { cause: error },
    );
  }
  if (status === 408) {
    return new LlmError(`${who} timed out. Try again.`, "timeout", provider, status, {
      cause: error,
    });
  }
  if (status !== undefined && status >= 500) {
    return new LlmError(
      `${who} had a server error (${status}). It's not you — try again shortly.`,
      "server",
      provider,
      status,
      { cause: error },
    );
  }
  if (status === 400) {
    const detail = extractProviderMessage(error);
    return new LlmError(
      detail
        ? `${who} rejected the request (400): ${detail}`
        : `${who} rejected the request (400). The content may be too long or malformed.`,
      "bad_request",
      provider,
      status,
      { cause: error },
    );
  }
  const detail = extractProviderMessage(error);
  return new LlmError(
    detail
      ? `${who} returned an error${status ? ` (${status})` : ""}: ${detail}`
      : `${who} returned an error${status ? ` (${status})` : ""}. Try again, or switch provider in Settings.`,
    "unknown",
    provider,
    status,
    { cause: error },
  );
}
