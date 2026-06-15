import fs from "node:fs";
import path from "node:path";
import { createBashTool } from "bash-tool";
import type { Embedder } from "../embedding/embedder.js";
import { loadSchema, withSchema } from "../knowledge/schema-doc.js";
import { loadProfileContext, withProfile } from "../profile/profile-doc.js";
import type { AgentActivityChunk, LlmClient } from "../llm/types.js";
import type {
  EntityRow,
  KnowledgeStore,
  ObservationRow,
  RelationshipView,
  WikiChange,
} from "../knowledge/store.js";
import {
  DEFAULT_WIKI_SANDBOX_LIMITS,
  RunLimitTracker,
  WikiLimitExceededError,
  WikiPathEscapeError,
  assertInWorkspace,
  guardTools,
  type GuardAuditEvent,
  type WikiSandboxLimits,
} from "./sandbox-guard.js";

export type { WikiSandboxLimits } from "./sandbox-guard.js";
export { DEFAULT_WIKI_SANDBOX_LIMITS } from "./sandbox-guard.js";

/** Identifies the page regeneration a transcript belongs to. */
export interface WikiRunStart {
  entityId: number;
  name: string;
  type: string;
  slug: string;
  /** Documents that made the page stale and triggered this run. */
  sourceIds: number[];
}

/** Receives a run's live transcript: each agent chunk, then a terminal status. */
export interface WikiRunSink {
  event(chunk: AgentActivityChunk): void;
  finish(status: "done" | "failed"): void;
}

/** Opens a sink when a regeneration starts — the seam the server records + fans out on. */
export type WikiRunHook = (start: WikiRunStart) => WikiRunSink;

const SYSTEM_PROMPT = `You are the wiki maintainer of MeOS, a personal second brain.
You maintain wiki pages that summarise everything the system knows about an entity.

You work inside a sandbox holding a copy of the entire wiki, one Markdown file per
entity under <type>/<slug>.md. Use the bash tool to explore it (cat, grep, ls) and
the readFile/writeFile tools to read and update pages.

Rules:
- Write in clear, factual prose, as a thoughtful summary by someone who has read every relevant source.
- Use ONLY the observations and relationships provided. Never add outside knowledge or speculation.
- Observations are listed with a confidence score. State high-confidence facts plainly. Hedge low-confidence ones explicitly ("a single note suggests...", "as of <date>...").
- Link other known entities inline using [[Entity Name]] wiki-link syntax, using their exact names from the known-entities list (grep the wiki to confirm a name before linking). Link each entity at most a few times; never link a page to itself.
- Structure: a short opening paragraph, then "## " sections only if there is enough material to justify them. No top-level title and no frontmatter (those are added by the system — write body prose only).
- When a user profile lens is provided, frame the page around the user's world: emphasise how this entity connects to their projects, work, goals, and decisions, rather than writing a generic encyclopedia entry. Never invent that connection — only draw it from the observations and relationships given.
- Prefer EDITING the existing page: keep prose that is still accurate, weave in new facts, and only rewrite parts the new observations change. If the page does not exist yet, write it from scratch.`;

const MAX_KNOWN_ENTITIES = 300;
const SUMMARY_FILE = "SUMMARY.txt";

/** Drop a leading YAML frontmatter block and a top-level "# Title" if present. */
function stripFrontmatter(markdown: string): string {
  let text = markdown;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const after = text.indexOf("\n", end + 1);
      text = after !== -1 ? text.slice(after + 1) : "";
    }
  }
  return text.replace(/^\s*# .*\n+/, "").trim();
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wrap mentions of known entities in [[wiki-link]] markup so deterministic prose
 * links out the way agent-authored pages do. Longest names first (so "Ada
 * Lovelace" wins over "Ada"); each entity is linked at most once to keep the
 * reading smooth; text already inside [[...]] is left alone.
 */
function linkify(text: string, names: string[]): string {
  let out = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (name.length < 3) continue; // skip initials/abbreviations that over-match
    const re = new RegExp(`(?<!\\[\\[)\\b(${escapeRegExp(name)})\\b(?!\\]\\])`, "i");
    out = out.replace(re, "[[$1]]");
  }
  return out;
}

/** Join names into an English list: "A", "A and B", "A, B, and C". */
function joinNames(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * A natural-language Connections passage with a [[backlink]] to each neighbour,
 * so the page reads with its relationships woven into the prose. Edges sharing a
 * label collapse into one clause ("Dana works on [[Orion]] and [[Helix]]").
 */
function describeRelationships(entity: EntityRow, relationships: RelationshipView[]): string {
  const outByLabel = new Map<string, string[]>();
  const inByLabel = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, label: string, name: string) => {
    const list = map.get(label) ?? [];
    list.push(`[[${name}]]`);
    map.set(label, list);
  };
  for (const r of relationships) {
    if (r.from_entity === entity.id) add(outByLabel, r.label, r.to_name);
    else add(inByLabel, r.label, r.from_name);
  }
  const sentences: string[] = [];
  for (const [label, names] of outByLabel)
    sentences.push(`${entity.name} ${label} ${joinNames(names)}.`);
  for (const [label, names] of inByLabel)
    sentences.push(`${joinNames(names)} ${label} ${entity.name}.`);
  return sentences.join(" ");
}

/**
 * Deterministic page body from an entity's knowledge — the safety net used when
 * the agentic writer returns nothing, so a page is never empty and the wiki
 * retrieval stream is always populated. Reads as flowing prose (summary, then
 * facts, then a Connections passage) with [[backlinks]] woven into the text.
 */
function synthesizeBody(
  entity: EntityRow,
  observations: ObservationRow[],
  relationships: RelationshipView[],
  knownNames: string[],
): string {
  const summaryNorm = (entity.summary ?? "").trim().toLowerCase();
  // Each observation as a sentence — skip one that merely restates the summary
  // (common for sparse entities) to avoid an echo, and hedge low-confidence ones.
  const sentences = observations
    .slice(0, 30)
    .filter((o) => o.text.trim().toLowerCase() !== summaryNorm)
    .map((o) => {
      const text = o.text.trim();
      const sentence = /[.!?]$/.test(text) ? text : `${text}.`;
      return o.confidence < 0.4 ? `${sentence} (low confidence)` : sentence;
    });

  const narrative: string[] = [];
  if (entity.summary) narrative.push(entity.summary);
  if (sentences.length > 0) narrative.push(sentences.join(" "));

  // Link out to other entities so the prose reads with its connections inline,
  // never to itself.
  let body = linkify(
    narrative.join("\n\n"),
    knownNames.filter((n) => n !== entity.name),
  );

  const connections = describeRelationships(entity, relationships);
  if (connections) body = body ? `${body}\n\n${connections}` : connections;

  return body.trim() || `${entity.name} is a ${entity.type} in your knowledge base.`;
}

/**
 * The full on-disk page: deterministic frontmatter (owned by code) + title +
 * body. `synthetic` pages carry an `auto_generated` marker so a later format
 * refresh can rewrite them without disturbing agent-authored prose.
 */
function composePage(
  entity: EntityRow,
  body: string,
  observationCount: number,
  meanConfidence: number,
  synthetic: boolean,
): string {
  const frontmatter = [
    "---",
    `entity_id: ${entity.id}`,
    `type: ${entity.type}`,
    `name: ${JSON.stringify(entity.name)}`,
    `slug: ${entity.slug}`,
    `observations: ${observationCount}`,
    `mean_confidence: ${meanConfidence.toFixed(2)}`,
    `updated: ${new Date().toISOString()}`,
    ...(synthetic ? ["auto_generated: true"] : []),
    "---",
    "",
  ].join("\n");
  return `${frontmatter}# ${entity.name}\n\n${body}\n`;
}

function meanOf(observations: ObservationRow[]): number {
  return observations.length === 0
    ? 0
    : observations.reduce((sum, o) => sum + o.confidence, 0) / observations.length;
}

export class WikiWriter {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly llm: LlmClient,
    private readonly wikiDir: string,
    /** When provided, page prose is embedded so chat can retrieve it semantically. */
    private readonly embedder?: Embedder,
    /** When provided, each regeneration's agent transcript is streamed here. */
    private readonly onRun?: WikiRunHook,
    /**
     * Execution + filesystem limits for the agentic run. Generous defaults
     * ({@link DEFAULT_WIKI_SANDBOX_LIMITS}) keep normal multi-page edits working;
     * override to tighten the sandbox.
     */
    private readonly limits: WikiSandboxLimits = DEFAULT_WIKI_SANDBOX_LIMITS,
  ) {}

  /**
   * Append a guarded tool/file event to the governance audit trail. Every agent
   * file mutation, every blocked path-escape, and every limit violation lands
   * here (`op = "wiki.tool"`) so suspicious or failed calls surface in the
   * Activity / debug views alongside other accountable operations.
   */
  private auditToolEvent(slug: string, event: GuardAuditEvent): void {
    const detail = {
      slug,
      tool: event.tool,
      ...(event.targetPath !== undefined ? { path: event.targetPath } : {}),
      success: event.success,
      ...(event.violation ? { violation: event.violation } : {}),
    };
    try {
      this.store.logAudit("wiki.tool", JSON.stringify(detail));
    } catch {
      // Audit logging must never break a regeneration.
    }
  }

  pagePath(entity: EntityRow): string {
    return path.join(this.wikiDir, entity.type, `${entity.slug}.md`);
  }

  readPage(entity: EntityRow): string | null {
    const file = this.pagePath(entity);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  }

  /**
   * Regenerate a single page by letting the model edit it in place over a
   * sandboxed copy of the wiki: it can grep sibling pages for exact link names
   * and context, and merge new facts into the existing prose instead of
   * rewriting from scratch. `knownEntities` is the list of names available for
   * [[wiki-links]]; pass it in to reuse one query across a batch.
   */
  async regenerate(entityId: number, knownEntities?: string[]): Promise<WikiChange | null> {
    const entity = this.store.getEntity(entityId);
    if (!entity) return null;

    // The body the page held before this pass — for created/updated detection
    // and so the caller can attribute the resulting commit to a document.
    const existing = this.readPage(entity);
    const beforeBody = existing ? stripFrontmatter(existing) : null;

    // Wiki pages are portable and git-synced: private/secret claims stay in
    // memory but never reach the page (schema privacy rules).
    const observations = this.store.visibleObservations(entityId);
    const relationships = this.store.relationshipsFor(entityId);
    const names =
      knownEntities ??
      this.store
        .listEntities()
        .map((e) => e.name)
        .slice(0, MAX_KNOWN_ENTITIES);

    const observationLines = observations.map(
      (o) => `- [confidence ${o.confidence.toFixed(2)}, recorded ${o.created_at}] ${o.text}`,
    );
    const relationshipLines = relationships.map((r) =>
      r.from_entity === entityId
        ? `- this entity ${r.label} ${r.to_name}`
        : `- ${r.from_name} ${r.label} this entity`,
    );

    const relPath = `${entity.type}/${entity.slug}.md`;
    fs.mkdirSync(this.wikiDir, { recursive: true });
    const { tools, sandbox } = await createBashTool({
      uploadDirectory: { source: this.wikiDir, include: "**/*.md" },
      // First line of defence: bash-tool's own output cap mirrors our limit.
      maxOutputLength: this.limits.maxOutputBytes,
    });

    // Defence-in-depth over the sandbox: validate + audit every agent file
    // mutation/command against the workspace allowlist and per-run execution
    // limits before it can touch even the in-memory sandbox copy. A blocked
    // path-escape or limit breach throws, aborting the run; we catch it below
    // and fall back to the deterministic body — an out-of-workspace or oversized
    // change is never committed.
    const tracker = new RunLimitTracker(this.limits);
    const guarded = guardTools(tools, tracker, (event) => this.auditToolEvent(entity.slug, event));

    // The documents that made this page stale — credited at the end, but read now
    // so the run's transcript can be attributed to them as it streams.
    const runSourceIds = this.store.pendingStaleSources(entity.id);
    // Open a transcript sink for this regeneration (if the server is recording).
    const sink = this.onRun?.({
      entityId: entity.id,
      name: entity.name,
      type: entity.type,
      slug: entity.slug,
      sourceIds: runSourceIds,
    });

    const dataDir = path.dirname(this.wikiDir);
    const schema = loadSchema(dataDir);
    const profileContext = loadProfileContext(dataDir);
    // Set when the sandbox guard rejects an op (path escape / limit breach), so
    // we discard partial agent output and synthesise deterministically.
    let agentAborted = false;
    // Enforce the wall-clock budget even if the underlying agent never yields to
    // a guarded tool call (e.g. a model that hangs mid-stream).
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = this.llm.runAgent({
        system: `${withProfile(withSchema(SYSTEM_PROMPT, schema), profileContext)}\n\nKnown entities available for [[wiki-links]] (use exact names): ${names.join(", ") || "(none)"}`,
        tools: guarded,
        sandbox,
        onActivity: sink ? (chunk) => sink.event(chunk) : undefined,
        prompt: [
          `Update the wiki page for this entity. The target file is "${relPath}".`,
          "Read it first if it exists, then edit it in place (or create it) per the rules.",
          "When done, write a single-sentence directory summary of the entity to",
          `"${SUMMARY_FILE}".`,
          "",
          `Entity: ${entity.name} (type: ${entity.type})`,
          "",
          "Observations:",
          observationLines.join("\n") || "(none)",
          "",
          "Relationships:",
          relationshipLines.join("\n") || "(none)",
        ].join("\n"),
      });
      // Swallow a late rejection from the losing branch of the race so a
      // post-timeout agent failure never becomes an unhandled rejection.
      run.catch(() => {});
      const timeoutGuard = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new WikiLimitExceededError({
              kind: "limit",
              limit: "runTimeoutMs",
              value: this.limits.runTimeoutMs,
              max: this.limits.runTimeoutMs,
            }),
          );
        }, this.limits.runTimeoutMs);
      });
      await Promise.race([run, timeoutGuard]);
      sink?.finish("done");
    } catch (error) {
      // A guard rejection (path escape) or limit breach means the agent tried
      // something out-of-bounds — record it prominently and abandon the agent
      // body, falling back to the safe deterministic synthesis below.
      if (error instanceof WikiPathEscapeError || error instanceof WikiLimitExceededError) {
        agentAborted = true;
        this.store.logAudit(
          "wiki.tool",
          JSON.stringify({ slug: entity.slug, aborted: true, reason: error.violation }),
        );
        console.warn(
          `wiki: agentic write for ${entity.slug} aborted (sandbox guard):`,
          error.message,
        );
      } else {
        // An LLM failure here (no credits, rate limit, outage) must not abort the
        // ingest: the knowledge is already merged. The agentic write is best-effort
        // anyway, so fall through to the deterministic synthesis below — the page
        // still gets a real body, just without the LLM's prose polish.
        console.warn(
          `wiki: agentic write failed for ${entity.slug}, using synthesized body:`,
          error instanceof Error ? error.message : error,
        );
      }
      sink?.finish("failed");
    } finally {
      clearTimeout(timeoutHandle);
    }

    // The agentic write is best-effort: some models/providers complete the run
    // without reliably writing the file. Never ship an empty page — fall back to
    // a deterministic body assembled from the same observations and
    // relationships, so the compiled-knowledge retrieval stream is always lit.
    // When the run was aborted by the guard, discard any partial agent output and
    // synthesise deterministically instead. Read-back paths are themselves
    // workspace-relative constants, but we assert them too for defence-in-depth.
    assertInWorkspace(relPath);
    assertInWorkspace(SUMMARY_FILE);
    const agentBody = agentAborted
      ? ""
      : stripFrontmatter(await sandbox.readFile(relPath).catch(() => ""));
    let body = agentBody || synthesizeBody(entity, observations, relationships, names);
    const summary = agentAborted
      ? entity.summary || `${entity.name} (${entity.type}).`
      : (await sandbox.readFile(SUMMARY_FILE).catch(() => "")).trim() ||
        entity.summary ||
        `${entity.name} (${entity.type}).`;

    // Final guardrail before committing: an agent body whose diff from the prior
    // page exceeds the cap is treated as abusive — audit it and fall back to the
    // deterministic synthesis (which is bounded by the entity's own knowledge).
    if (agentBody) {
      const diffViolation = tracker.checkPageDiff(beforeBody, body);
      if (diffViolation) {
        this.auditToolEvent(entity.slug, {
          tool: "writeFile",
          targetPath: relPath,
          success: false,
          violation: diffViolation,
        });
        console.warn(
          `wiki: agentic page diff for ${entity.slug} exceeds limit, using synthesized body`,
        );
        body = synthesizeBody(entity, observations, relationships, names);
      }
    }
    const usedSynthesis = !agentBody || body !== agentBody;

    // Only touch the file when the prose actually changed: a no-op rewrite
    // would churn the frontmatter timestamp, dirty git, and surface an empty
    // diff. A page with no prior file is always a real "created" change.
    const created = beforeBody === null;
    const changed = created || beforeBody !== body;
    if (changed) {
      const file = this.pagePath(entity);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        composePage(entity, body, observations.length, meanOf(observations), usedSynthesis),
      );
      // Persist the compiled prose so chat retrieves it directly (and BM25 can
      // index it); embed it when an embedder is available for semantic recall.
      if (body) {
        const [vector] = this.embedder ? await this.embedder.embed([body]) : [undefined];
        this.store.upsertWikiPage(entity.id, body, vector);
      }
    }

    if (summary) this.store.setEntitySummary(entity.id, summary);

    // Credit the documents that made this page stale before clearing them
    // (already read into runSourceIds above, before the transcript opened).
    this.store.clearStaleSources(entity.id);
    this.store.clearWikiStale(entity.id);

    if (!changed) return null;
    return {
      entityId: entity.id,
      name: entity.name,
      type: entity.type,
      slug: entity.slug,
      filePath: path.posix.join("wiki", entity.type, `${entity.slug}.md`),
      kind: created ? "created" : "updated",
      sourceIds: runSourceIds,
    };
  }

  /**
   * Regenerate every page flagged stale, a few at a time in parallel (each
   * page is an independent agent run). Loops until no stale pages remain, so
   * entities marked stale mid-pass are picked up too. Returns the pages that
   * actually changed (created or rewritten), so the caller can commit and
   * attribute them.
   */
  async regenerateStale(concurrency = 6): Promise<WikiChange[]> {
    const changes: WikiChange[] = [];
    while (true) {
      const stale = this.store.staleEntities();
      if (stale.length === 0) return changes;
      // Computed once per pass and shared across workers: the roster barely
      // changes between pages.
      const knownEntities = this.store
        .listEntities()
        .map((e) => e.name)
        .slice(0, MAX_KNOWN_ENTITIES);
      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, stale.length) }, async () => {
        while (next < stale.length) {
          const entity = stale[next++]!;
          const change = await this.regenerate(entity.id, knownEntities);
          if (change) changes.push(change);
        }
      });
      await Promise.all(workers);
    }
  }

  /**
   * Backfill the wiki_pages table from pages already on disk, without calling
   * the LLM. Pages written before persistence (or any upgrade) leave the
   * compiled-knowledge retrieval stream dark; this reads each entity's existing
   * Markdown, strips frontmatter, embeds the prose locally, and stores it so
   * chat can retrieve compiled prose immediately. Only fills entities that have
   * a file but no persisted page yet. Returns how many pages were backfilled.
   */
  async backfillPages(): Promise<number> {
    if (!this.embedder) return 0;
    const persisted = new Set(this.store.allWikiPageVectors().map((p) => p.entity_id));
    const knownNames = this.store
      .listEntities()
      .map((e) => e.name)
      .slice(0, MAX_KNOWN_ENTITIES);
    const pending: Array<{ entity: EntityRow; body: string }> = [];
    for (const entity of this.store.listEntities()) {
      const file = this.readPage(entity);
      let diskBody = file ? stripFrontmatter(file) : "";

      // Fill a blank/missing page on disk from a deterministic synthesis (no LLM)
      // so the visible wiki and git-synced artifact aren't empty — independent of
      // whether the retrieval index already has this entity.
      if (!diskBody) {
        const observations = this.store.visibleObservations(entity.id);
        const relationships = this.store.relationshipsFor(entity.id);
        const body = synthesizeBody(entity, observations, relationships, knownNames);
        if (body) {
          const dest = this.pagePath(entity);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(
            dest,
            composePage(entity, body, observations.length, meanOf(observations), true),
          );
          diskBody = body;
        }
      }

      // Index any entity missing from the retrieval table, so chat can retrieve
      // its compiled prose.
      if (!persisted.has(entity.id) && diskBody) pending.push({ entity, body: diskBody });
    }
    if (pending.length === 0) return 0;
    // Embed in one batch; bulk so it doesn't jump the interactive queue.
    const vectors = await this.embedder.embed(pending.map((p) => p.body));
    pending.forEach((p, i) => this.store.upsertWikiPage(p.entity.id, p.body, vectors[i]));
    return pending.length;
  }

  /**
   * Re-synthesise auto-generated pages so an improvement to the synthesis format
   * propagates to existing data without an LLM. Agent-authored prose is left
   * untouched: synthetic pages now carry an `auto_generated` frontmatter marker,
   * and older ones (which predate the marker) are recognised by the absence of
   * the [[wiki-links]] only agents used to write. Rewrites disk and the retrieval
   * index. Returns how many changed.
   */
  async refreshSyntheticPages(): Promise<number> {
    if (!this.embedder) return 0;
    const knownNames = this.store
      .listEntities()
      .map((e) => e.name)
      .slice(0, MAX_KNOWN_ENTITIES);
    const updates: Array<{ entity: EntityRow; body: string; count: number; mean: number }> = [];
    for (const entity of this.store.listEntities()) {
      const file = this.readPage(entity);
      const current = file ? stripFrontmatter(file) : "";
      const isAuto = file ? /^auto_generated:\s*true/m.test(file) : false;
      // Leave agent prose alone (marker absent, but it links entities with [[...]]).
      if (!isAuto && current.includes("[[")) continue;
      const observations = this.store.visibleObservations(entity.id);
      const relationships = this.store.relationshipsFor(entity.id);
      const body = synthesizeBody(entity, observations, relationships, knownNames);
      if (body === current) continue;
      updates.push({ entity, body, count: observations.length, mean: meanOf(observations) });
    }
    if (updates.length === 0) return 0;
    const vectors = await this.embedder.embed(updates.map((u) => u.body));
    updates.forEach((u, i) => {
      const dest = this.pagePath(u.entity);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, composePage(u.entity, u.body, u.count, u.mean, true));
      this.store.upsertWikiPage(u.entity.id, u.body, vectors[i]);
    });
    return updates.length;
  }
}
