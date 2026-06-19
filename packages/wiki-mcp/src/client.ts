/**
 * Tiny fetch wrapper over the running meOS HTTP API.
 *
 * Base URL comes from `MEOS_SERVER_URL` (default `http://127.0.0.1:4321`).
 * Every function targets a `/api/wiki/agent/*` endpoint and returns parsed JSON.
 * Network failures (e.g. ECONNREFUSED — the meOS app isn't running) are turned
 * into a clear, actionable Error.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:4321";

export type WikiMaintenanceMode = "in-app" | "external" | "hybrid";

function baseUrl(): string {
  const raw = process.env.MEOS_SERVER_URL?.trim();
  const url = raw && raw.length > 0 ? raw : DEFAULT_BASE_URL;
  // Drop a trailing slash so path joins stay clean.
  return url.replace(/\/+$/, "");
}

function unreachable(url: string, cause: unknown): Error {
  const message =
    `meOS server not reachable at ${url} — is the meOS app running? ` +
    `(set MEOS_SERVER_URL to override)`;
  const err = new Error(message);
  if (cause !== undefined) (err as { cause?: unknown }).cause = cause;
  return err;
}

async function request<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl()}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // fetch rejects on network errors (connection refused, DNS, etc.).
    throw unreachable(baseUrl(), cause);
  }

  const text = await res.text();

  if (!res.ok) {
    // Surface server-side errors with whatever detail the API returned.
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      detail = parsed.message ?? parsed.error ?? text;
    } catch {
      // keep raw text
    }
    throw new Error(`meOS API ${method} ${path} failed (${res.status}): ${detail}`);
  }

  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

export function getSearch(q: string): Promise<unknown> {
  return request("GET", `/api/search?q=${encodeURIComponent(q)}`);
}

export function getQueue(): Promise<unknown> {
  return request("GET", "/api/wiki/agent/queue");
}

export function getContext(slug: string): Promise<unknown> {
  return request("GET", `/api/wiki/agent/context/${encodeURIComponent(slug)}`);
}

export function postCheck(slugs?: string[]): Promise<unknown> {
  return request("POST", "/api/wiki/agent/check", slugs ? { slugs } : {});
}

export function postWrite(slug: string, body: string): Promise<unknown> {
  return request("POST", "/api/wiki/agent/write", { slug, body });
}

export function postCommit(slugs?: string[], message?: string): Promise<unknown> {
  const payload: { slugs?: string[]; message?: string } = {};
  if (slugs) payload.slugs = slugs;
  if (message !== undefined) payload.message = message;
  return request("POST", "/api/wiki/agent/commit", payload);
}

export function getMode(): Promise<unknown> {
  return request("GET", "/api/wiki/agent/mode");
}

export function putMode(mode: WikiMaintenanceMode): Promise<unknown> {
  return request("PUT", "/api/wiki/agent/mode", { mode });
}

// --- Option 2: agent-supplied extraction ------------------------------

export function getSources(): Promise<unknown> {
  return request("GET", "/api/wiki/agent/sources");
}

export function getExtractContext(sourceId: number): Promise<unknown> {
  return request("GET", `/api/wiki/agent/extract-context/${encodeURIComponent(String(sourceId))}`);
}

export function postFacts(sourceId: number, extraction: unknown): Promise<unknown> {
  return request("POST", "/api/wiki/agent/facts", { sourceId, extraction });
}
