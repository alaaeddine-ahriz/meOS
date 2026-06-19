/**
 * Turn a raw backend error string — a provider message, a Node syscall code, a
 * parser complaint — into a plain-English explanation the user can act on. The
 * health and activity views render the friendly version and tuck the raw text
 * behind a "technical detail" disclosure, so a person sees "AI provider out of
 * credit. Add credits…" instead of `401 Unauthorized {"error":{...}}`.
 *
 * `title` is intentionally STABLE per cause: it's also the grouping key, so 200
 * files that all failed for the same reason collapse into one actionable row
 * instead of 200 identical ones.
 */
export type ErrorSeverity = "provider" | "error" | "warning";

export interface ExplainedError {
  /** Short, stable headline + grouping key, e.g. "AI provider out of credit". */
  title: string;
  /** One plain sentence describing what happened. */
  detail: string;
  /** What to do about it, when there's a clear fix. */
  fix?: string;
  /** `provider` = the AI provider is down (needs you); `error`/`warning` shade the UI. */
  severity: ErrorSeverity;
}

type Rule = {
  test: RegExp;
  build: (raw: string) => Omit<ExplainedError, "severity"> & { severity?: ErrorSeverity };
};

// First match wins, so order from most-specific to most-generic. The patterns
// match both the provider-friendly messages meOS already emits (errors.ts) and
// the rawer strings that reach us from parsers and the filesystem.
const RULES: Rule[] = [
  {
    test: /out of credit|credit balance|insufficient|\bquota\b|billing|payment|exceeded your current|purchase/i,
    build: () => ({
      title: "AI provider out of credit",
      detail:
        "Your AI provider has run out of credit or hit its usage quota, so meOS can't read or understand new items.",
      fix: "Add credits to your provider account, or switch provider in Settings → Model.",
      severity: "provider",
    }),
  },
  {
    test: /rejected your api key|unauthorized|invalid[_ ]?api[_ ]?key|\b401\b|\b403\b|no .*api key/i,
    build: () => ({
      title: "AI provider key rejected",
      detail: "Your AI provider didn't accept the API key, so meOS can't reach the model.",
      fix: "Check or paste a valid key in Settings → Model.",
      severity: "provider",
    }),
  },
  {
    test: /recognise the model|unknown model|no such model|find that model|model .*not found|\b404\b/i,
    build: () => ({
      title: "Model not available",
      detail: "The model meOS is configured to use isn't available from your provider.",
      fix: "Pick a different model in Settings → Model.",
      severity: "provider",
    }),
  },
  {
    test: /rate[ _-]?limit|too many requests|\b429\b|overloaded/i,
    build: () => ({
      title: "AI provider is busy",
      detail: "The AI provider is rate-limiting requests. meOS will keep retrying on its own.",
      severity: "warning",
    }),
  },
  {
    test: /timed out|timeout/i,
    build: () => ({
      title: "The AI provider timed out",
      detail: "The provider took too long to respond. meOS will try again.",
      severity: "warning",
    }),
  },
  {
    test: /couldn't reach|econnrefused|fetch failed|enotfound|socket hang up|\bnetwork\b|und_err/i,
    build: (raw) => {
      const local = /local/i.test(raw);
      return {
        title: local ? "Can't reach the local model server" : "Can't reach the AI provider",
        detail: local
          ? "meOS couldn't reach the local model server at the configured endpoint."
          : "meOS couldn't reach the AI provider — most likely a network issue.",
        fix: local
          ? "Make sure your local model server is running."
          : "Check your internet connection.",
        severity: "warning",
      };
    },
  },
  {
    test: /too many open files|emfile/i,
    build: () => ({
      title: "Too many files at once",
      detail: "meOS hit the system limit on open files while reading a burst of changes.",
      fix: "It usually clears on its own; if it keeps happening, restart meOS.",
      severity: "warning",
    }),
  },
  {
    test: /password|encrypted/i,
    build: () => ({
      title: "File is protected",
      detail: "This file is password-protected or encrypted, so meOS couldn't read it.",
      severity: "warning",
    }),
  },
  {
    test: /enoent|no such file|file .*not found/i,
    build: () => ({
      title: "File not found",
      detail: "The file was moved or deleted before meOS could finish reading it.",
      severity: "warning",
    }),
  },
  {
    test: /no extractable text|contains no|unsupported file/i,
    build: () => ({
      title: "Nothing to read",
      detail: "meOS couldn't find any text to read in this item.",
      severity: "warning",
    }),
  },
  {
    test: /couldn't be read|couldn't read|no object generated|could not parse|type validation/i,
    build: () => ({
      title: "Couldn't understand the AI response",
      detail: "The AI provider returned something meOS couldn't use. It will try again.",
      severity: "warning",
    }),
  },
];

/**
 * Explain a raw error string, or return null when there's nothing to explain
 * (empty/whitespace). Unknown causes pass the raw message through as the detail
 * under a generic title, so we never hide information — we just frame it.
 */
export function explainError(raw: string | null | undefined): ExplainedError | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      const built = rule.build(text);
      return { severity: "error", ...built };
    }
  }
  return { title: "Something went wrong", detail: text, severity: "error" };
}
