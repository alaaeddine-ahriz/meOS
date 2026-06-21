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

/** The HTTP methods the generated MCP tools can map to (a superset of the curated calls). */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Fetch `${base}${path}`, turning a network failure into an {@link unreachable}
 * error and a non-2xx response into one carrying whatever detail the API returned.
 * Returns the raw response body so callers decide how to parse it.
 */
async function fetchText(
  origin: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${origin}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // fetch rejects on network errors (connection refused, DNS, etc.).
    throw unreachable(origin, cause);
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

  return text;
}

async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const text = await fetchText(baseUrl(), method, path, body);
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

// --- Connector agent tools (agent mode) -------------------------------
// Live tools from the user's connected services (Google calendar/tasks/email/
// contacts, …), executed server-side against the account's already-authorized
// OAuth. The MCP server advertises these and proxies calls back to meOS.

/** One connector tool's transport-neutral shape: name, prose, JSON-Schema inputs. */
export interface ConnectorToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

export function getConnectorTools(): Promise<{
  tools: ConnectorToolDescriptor[];
  hints: string[];
}> {
  return request("GET", "/api/agent/connector-tools");
}

export function invokeConnectorTool(
  name: string,
  args: unknown,
): Promise<{ result: string; isError: boolean }> {
  return request("POST", `/api/agent/connector-tools/${encodeURIComponent(name)}`, args);
}

// --- Mid-run questions (agent mode) -----------------------------------
// A headless agent has no terminal to prompt, so to ask the user something it
// calls the `ask_user` tool, which POSTs here. The request LONG-POLLS: meOS
// holds it open until the user answers in chat (or the wait ends), then returns
// their choice — see the server's ask-registry.

export interface AskQuestionInput {
  /** ≤12-char chip label categorising the question. */
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export interface AskAnswerItem {
  question: string;
  answers: string[];
}
export interface AskUserResult {
  status: "answered" | "timeout" | "cancelled" | "unavailable";
  answers: AskAnswerItem[];
}

/** Pose questions to the user and block until they answer (or the wait ends). */
export function askUser(op: string, questions: AskQuestionInput[]): Promise<AskUserResult> {
  return request("POST", "/api/agent/ask", { op, questions });
}

// --- Generated tool surface (the annotated-API projection) ------------------
// The MCP surface mirrors the app's annotated HTTP API: meOS serves a manifest of
// exposed routes, and `registerGeneratedTools` (generated.ts) turns each into a
// live MCP tool. These two helpers are the manifest fetch + the generic request the
// generated tool handlers reuse — they take the base URL explicitly (a generated
// server may target a different meOS than MEOS_SERVER_URL), unlike the curated
// wiki/connector calls above which read the env default.

/** One generated tool's reconstruction recipe, as served by /api/agent/tool-manifest. */
export interface ToolManifestEntry {
  name: string;
  method: string;
  path: string;
  summary: string;
  safety: "read" | "write" | "destructive";
  /** A single JSON-Schema object: the merged path/query/body input the tool accepts. */
  inputSchema: Record<string, unknown>;
}

/** Fetch the generated MCP tool manifest from a specific meOS server. */
export async function getToolManifest(base: string): Promise<ToolManifestEntry[]> {
  const url = `${base.replace(/\/+$/, "")}/api/agent/tool-manifest`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (cause) {
    throw unreachable(base, cause);
  }
  if (!res.ok) {
    throw new Error(`meOS API GET /api/agent/tool-manifest failed (${res.status})`);
  }
  const text = await res.text();
  const parsed = (text.length === 0 ? {} : JSON.parse(text)) as { tools?: ToolManifestEntry[] };
  return parsed.tools ?? [];
}

/**
 * Issue one generated tool's HTTP request against `base` and return the parsed JSON
 * (or raw text when the body isn't JSON). Mirrors the curated {@link request}'s
 * error shaping, but is method-generic and base-explicit so a generated handler can
 * hit any exposed route.
 */
export async function callGenerated(
  base: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const text = await fetchText(base.replace(/\/+$/, ""), method, path, body);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
