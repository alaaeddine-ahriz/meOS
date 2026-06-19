import { z } from "zod";

/**
 * External wiki maintenance (#wiki-agent). The endpoints under
 * `/api/wiki/agent/*` let the user's own coding agent (Claude Code / Codex /
 * Claude Desktop, via the `@meos/wiki-mcp` MCP server) drive wiki upkeep over the
 * same files + status ledger as the in-app maintainer. Explicit `z.object`
 * throughout — never `z.record` (Fastify mis-serialises record schemas).
 */

/** How the wiki is maintained. `external` pauses the paid in-app page rewrite. */
export const WikiMaintenanceMode = z.enum(["in-app", "external", "hybrid"]);

// --- GET /api/wiki/agent/queue ----------------------------------------

/** A page the agent could work on — stale (new facts) or never written. */
export const AgentQueueItem = z.object({
  entityId: z.number(),
  slug: z.string(),
  type: z.string(),
  name: z.string(),
  /** Data-dir-relative file, e.g. `wiki/person/ada.md`. */
  path: z.string(),
  stale: z.boolean(),
  /** How many sources made this page stale since it was last written. */
  newSources: z.number(),
  quality: z.number().nullable(),
  updatedAt: z.string().nullable(),
  /** Whether a compiled page already exists (vs a brand-new entity). */
  exists: z.boolean(),
});
export const AgentQueueResponse = z.object({
  mode: WikiMaintenanceMode,
  pages: z.array(AgentQueueItem),
});

// --- GET /api/wiki/agent/context/:slug --------------------------------

/** One backing fact (observation) for grounding the page. */
export const AgentFact = z.object({
  text: z.string(),
  confidence: z.number(),
  kind: z.string(),
  /** Recency tag (date + stale/upcoming marker), or null. */
  when: z.string().nullable(),
  /** The verbatim source sentence behind the claim, if recorded. */
  sourceQuote: z.string().nullable(),
});
export const AgentRelationship = z.object({
  label: z.string(),
  direction: z.enum(["in", "out"]),
  other: z.string(),
});
export const AgentSourceExcerpt = z.object({
  id: z.number(),
  type: z.string(),
  title: z.string(),
  link: z.string().nullable(),
  /** Truncated source content the agent reads to ground prose. */
  excerpt: z.string(),
});
export const AgentContextResponse = z.object({
  entity: z.object({
    id: z.number(),
    type: z.string(),
    name: z.string(),
    slug: z.string(),
    summary: z.string().nullable(),
  }),
  page: z.object({
    path: z.string(),
    body: z.string().nullable(),
    exists: z.boolean(),
  }),
  facts: z.array(AgentFact),
  relationships: z.array(AgentRelationship),
  /** Exact entity names available for `[[wiki-links]]`. */
  linkableNames: z.array(z.string()),
  sources: z.array(AgentSourceExcerpt),
});

// --- POST /api/wiki/agent/check ---------------------------------------

/** Omit `slugs` to check every page that exists on disk. */
export const AgentCheckBody = z.object({ slugs: z.array(z.string()).optional() });
export const AgentPageIssue = z.object({
  code: z.string(),
  severity: z.enum(["auto", "review"]),
  message: z.string(),
});
export const AgentCheckResult = z.object({
  slug: z.string(),
  /** True when nothing blocks a commit (no empty body, broken link, bad frontmatter). */
  ok: z.boolean(),
  quality: z.number(),
  frontmatterOk: z.boolean(),
  exists: z.boolean(),
  issues: z.array(AgentPageIssue),
});
export const AgentCheckResponse = z.object({ results: z.array(AgentCheckResult) });

// --- POST /api/wiki/agent/write (whole-body, for no-filesystem agents) -

export const AgentWriteBody = z.object({ slug: z.string().min(1), body: z.string() });
export const AgentWriteResponse = z.object({
  slug: z.string(),
  path: z.string(),
  written: z.boolean(),
  check: AgentCheckResult,
});

// --- POST /api/wiki/agent/commit --------------------------------------

/** Omit `slugs` to commit every changed page on disk. */
export const AgentCommitBody = z.object({
  slugs: z.array(z.string()).optional(),
  message: z.string().optional(),
});
export const AgentCommitItem = z.object({
  slug: z.string(),
  kind: z.enum(["created", "updated"]),
  quality: z.number(),
});
export const AgentCommitSkip = z.object({
  slug: z.string(),
  reason: z.enum(["unchanged", "missing", "empty", "frontmatter", "not-found"]),
});
export const AgentCommitResponse = z.object({
  committed: z.array(AgentCommitItem),
  skipped: z.array(AgentCommitSkip),
  git: z.object({ hash: z.string().nullable() }),
});

// --- GET / PUT /api/wiki/agent/mode -----------------------------------

export const AgentModeBody = z.object({ mode: WikiMaintenanceMode });
export const AgentModeResponse = z.object({ mode: WikiMaintenanceMode });

export type WikiMaintenanceModeValue = z.infer<typeof WikiMaintenanceMode>;
export type AgentQueue = z.infer<typeof AgentQueueResponse>;
export type AgentContext = z.infer<typeof AgentContextResponse>;
export type AgentCheck = z.infer<typeof AgentCheckResponse>;
export type AgentCommit = z.infer<typeof AgentCommitResponse>;
export type AgentWrite = z.infer<typeof AgentWriteResponse>;
