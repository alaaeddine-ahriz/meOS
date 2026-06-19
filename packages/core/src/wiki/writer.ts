import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createBashTool } from "bash-tool";
import { createLogger } from "../logger.js";
import type { Embedder } from "../embedding/embedder.js";
import { loadSchema, withSchema } from "../knowledge/schema-doc.js";
import { loadProfileContext, withProfile } from "../profile/profile-doc.js";
import type { AgentActivityChunk, LlmClient } from "../llm/types.js";
import type {
  EntityRow,
  KnowledgeStore,
  ObservationRow,
  RelationshipView,
  WikiAuthor,
  WikiChange,
} from "../knowledge/store.js";
import { lintPage, type IssueSeverity } from "./wiki-lint.js";
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

const log = createLogger("wiki");

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
the readFile/writeFile tools to read and update pages. The entity's own indexed
source material — contacts, calendar events, tasks and emails synced from connected
services — is seeded under "sources/" so you can read it the same way (cat, grep).

Rules:
- Write in clear, factual prose, as a thoughtful summary by someone who has read every relevant source.
- Use the observations and relationships provided — and the indexed files under "sources/" — as your material. Read the sources to ground the page in what actually happened (who was met, what was discussed, what is due). Never add outside knowledge or speculation beyond this material.
- The "sources/" files may contain private contact details (email addresses, phone numbers, postal addresses). Use them only to understand context, relationships and events; never transcribe those private details into the page — it is git-synced and meant to be shareable.
- Observations are listed with a confidence score. State high-confidence facts plainly. Hedge low-confidence ones explicitly ("a single note suggests...", "as of <date>...").
- Link other known entities inline using [[Entity Name]] wiki-link syntax, using their exact names from the known-entities list (grep the wiki to confirm a name before linking). Link each entity at most a few times; never link a page to itself.
- Structure: a short opening paragraph, then "## " sections only if there is enough material to justify them. No top-level title and no frontmatter (those are added by the system — write body prose only).
- When a user profile lens is provided, frame the page around the user's world: emphasise how this entity connects to their projects, work, goals, and decisions, rather than writing a generic encyclopedia entry. Never invent that connection — only draw it from the observations and relationships given.
- Prefer EDITING the existing page: keep prose that is still accurate, weave in new facts, and only rewrite parts the new observations change. If the page does not exist yet, write it from scratch.`;

const MAX_KNOWN_ENTITIES = 300;
const SUMMARY_FILE = "SUMMARY.txt";
/** Cap how many indexed sources are seeded into the sandbox per page (bounded prompt). */
const MAX_SOURCE_FILES = 60;
/** Truncate each seeded source's content so one large item can't blow the budget. */
const MAX_SOURCE_BYTES = 4000;

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

/**
 * Read the system-owned identity (entity_id, slug) out of a page's frontmatter,
 * if any. Used to verify an externally-edited page still points at its entity —
 * the agent must never rewrite these.
 */
function parseFrontmatterIdentity(markdown: string): {
  hasFrontmatter: boolean;
  entityId?: number;
  slug?: string;
} {
  if (!markdown.startsWith("---")) return { hasFrontmatter: false };
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return { hasFrontmatter: false };
  const block = markdown.slice(3, end);
  const idMatch = block.match(/(?:^|\n)\s*entity_id:\s*(\d+)/);
  const slugMatch = block.match(/(?:^|\n)\s*slug:\s*"?([^"\n]+?)"?\s*(?:\n|$)/);
  return {
    hasFrontmatter: true,
    entityId: idMatch ? Number(idMatch[1]) : undefined,
    slug: slugMatch ? slugMatch[1]!.trim() : undefined,
  };
}

/** One issue found while validating an externally-edited page. */
export interface WikiPageIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
}

/** The result of validating a page on disk (lint + frontmatter integrity). */
export interface WikiPageCheck {
  slug: string;
  /** True when nothing blocks a commit (no empty body, broken link, or bad frontmatter). */
  ok: boolean;
  quality: number;
  frontmatterOk: boolean;
  issues: WikiPageIssue[];
}

/** Why an external commit left a page untouched. */
export type WikiReconcileSkip = "missing" | "empty" | "frontmatter" | "unchanged";

/** Outcome of reconciling one externally-edited page into the knowledge store. */
export interface WikiReconcileResult {
  change: WikiChange | null;
  skipped: WikiReconcileSkip | null;
  check: WikiPageCheck;
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
   * Names available for [[wiki-links]] — only entities that actually have a page
   * (wiki-eligible backing), so prose never links out to a pageless, connector-only
   * person. Capped to keep the prompt/linkifier bounded.
   */
  private linkableEntityNames(): string[] {
    const withPages = this.store.wikiPageEntityIds();
    return this.store
      .listEntities()
      .filter((e) => withPages.has(e.id))
      .map((e) => e.name)
      .slice(0, MAX_KNOWN_ENTITIES);
  }

  /**
   * Public view of the [[wiki-link]] candidate names (entities that have a page),
   * so the external-maintenance endpoints can hand the same list to the user's
   * coding agent that the in-app maintainer uses.
   */
  linkableNames(): string[] {
    return this.linkableEntityNames();
  }

  /**
   * Validate a page on disk WITHOUT writing — the feedback loop an external agent
   * runs before committing. Deterministic lint (broken links, grounding,
   * staleness, vagueness) plus a frontmatter-integrity check: the system owns
   * `entity_id`/`slug`, so an edited-away or mismatched identity blocks the commit.
   * `ok` is false on the three blocking conditions (empty body, broken link, bad
   * frontmatter); softer issues are reported as warnings.
   */
  checkPage(entity: EntityRow): WikiPageCheck {
    const existing = this.readPage(entity);
    const body = existing ? stripFrontmatter(existing) : "";
    const lint = lintPage(this.store, entity.id, body);
    const issues: WikiPageIssue[] = lint.issues.map((i) => ({
      code: i.code,
      severity: i.severity,
      message: i.detail,
    }));

    const fm = existing ? parseFrontmatterIdentity(existing) : { hasFrontmatter: false };
    const frontmatterOk =
      !fm.hasFrontmatter ||
      ((fm.entityId === undefined || fm.entityId === entity.id) &&
        (fm.slug === undefined || fm.slug === entity.slug));
    if (!frontmatterOk) {
      issues.push({
        code: "frontmatter",
        severity: "review",
        message:
          "Frontmatter entity_id/slug must match this entity — do not edit it (meOS owns it).",
      });
    }

    const blocking = issues.some(
      (i) => i.code === "empty" || i.code === "broken_link" || i.code === "frontmatter",
    );
    return { slug: entity.slug, ok: !blocking, quality: lint.quality, frontmatterOk, issues };
  }

  /**
   * Write a whole prose body to the page file with system-owned frontmatter,
   * WITHOUT reconciling to the DB — the disk-write helper for agents that can't
   * edit files directly (e.g. Claude Desktop). The agent then runs check/commit
   * like a file-native agent. Any frontmatter/title the agent included is stripped
   * (meOS owns those). Returns the data-dir-relative path.
   */
  stageBody(entity: EntityRow, body: string): string {
    const prose = stripFrontmatter(body) || body.trim();
    const observations = this.store.visibleObservations(entity.id);
    const file = this.pagePath(entity);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      composePage(entity, prose, observations.length, meanOf(observations), false),
    );
    return path.posix.join("wiki", entity.type, `${entity.slug}.md`);
  }

  /**
   * Reconcile one externally-edited page on disk into the knowledge store — the
   * commit half of the external-maintenance path, mirroring what {@link regenerate}
   * does after the in-app agent writes (re-impose system frontmatter, embed,
   * persist body + body_hash, score, clear stale flags), so both paths share one
   * status ledger. Idempotent: a body whose hash matches the stored page is left
   * untouched (`skipped: "unchanged"`). Refuses to commit an empty body or a page
   * whose frontmatter no longer identifies the entity.
   */
  async reconcileFromDisk(
    entity: EntityRow,
    opts: { authoredBy?: WikiAuthor } = {},
  ): Promise<WikiReconcileResult> {
    const check = this.checkPage(entity);
    const existing = this.readPage(entity);
    if (existing === null) return { change: null, skipped: "missing", check };
    const body = stripFrontmatter(existing);
    if (!body) return { change: null, skipped: "empty", check };
    if (!check.frontmatterOk) return { change: null, skipped: "frontmatter", check };

    // Idempotency: an on-disk body that already matches the persisted page needs
    // no work — the in-app path and the agent never reprocess each other's output.
    const meta = this.store.wikiPageMeta(entity.id);
    const bodyHash = createHash("sha256").update(body).digest("hex");
    if (meta && meta.body_hash === bodyHash) return { change: null, skipped: "unchanged", check };

    const observations = this.store.visibleObservations(entity.id);
    const runSourceIds = this.store.pendingStaleSources(entity.id);
    const created = !meta;

    // Re-impose the system-owned frontmatter so the agent can never corrupt the
    // identity/counters, then persist exactly as the in-app writer does.
    const file = this.pagePath(entity);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      composePage(entity, body, observations.length, meanOf(observations), false),
    );

    const [vector] = this.embedder ? await this.embedder.embed([body]) : [undefined];
    this.store.upsertWikiPage(entity.id, body, vector, opts.authoredBy ?? "agent");
    this.store.setWikiQuality(entity.id, check.quality);

    // Give a never-summarised entity a one-line summary from its own prose.
    if (!entity.summary) {
      const firstSentence = body.split(/(?<=[.!?])\s/)[0]?.trim();
      if (firstSentence) this.store.setEntitySummary(entity.id, firstSentence.slice(0, 280));
    }

    this.store.clearStaleSources(entity.id);
    this.store.clearWikiStale(entity.id);

    return {
      change: {
        entityId: entity.id,
        name: entity.name,
        type: entity.type,
        slug: entity.slug,
        filePath: path.posix.join("wiki", entity.type, `${entity.slug}.md`),
        kind: created ? "created" : "updated",
        sourceIds: runSourceIds,
      },
      skipped: null,
      check,
    };
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

    // Don't create a page for an entity that doesn't warrant one — a person known
    // only from a connector (contact/email/calendar) or a "name only" contact with
    // no facts at all. New entities default to wiki_stale = 1, so this is where that
    // default is cleared without writing a noise page. An existing page is still
    // allowed to regenerate (e.g. once a real source mentions the person).
    if (beforeBody === null && !this.store.entityWarrantsWikiPage(entityId)) {
      this.store.clearStaleSources(entity.id);
      this.store.clearWikiStale(entity.id);
      return null;
    }

    // Wiki pages are portable and git-synced: private/secret claims stay in
    // memory but never reach the page (schema privacy rules).
    const observations = this.store.visibleObservations(entityId);
    const relationships = this.store.relationshipsFor(entityId);
    const names = knownEntities ?? this.linkableEntityNames();

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

    // Seed the entity's own indexed connector items (contacts/events/tasks/emails)
    // into the sandbox under "sources/" so the maintainer reads them as files —
    // by default, every page is written with its source material at hand. Each is
    // truncated and capped in number so the sandbox stays bounded.
    const indexedSources = this.store.indexedSourcesForEntity(entityId).slice(0, MAX_SOURCE_FILES);
    const sourceFiles: Record<string, string> = {};
    for (const src of indexedSources) {
      const fileName = `sources/${src.type.replace(/[^a-z0-9]+/gi, "-")}-${src.id}.md`;
      const header = [
        `# ${src.title}`,
        `Kind: ${src.type}`,
        src.link ? `Link: ${src.link}` : null,
        "",
      ]
        .filter((l) => l !== null)
        .join("\n");
      sourceFiles[fileName] = `${header}${(src.content ?? "").slice(0, MAX_SOURCE_BYTES)}\n`;
    }

    const { tools, sandbox } = await createBashTool({
      uploadDirectory: { source: this.wikiDir, include: "**/*.md" },
      // The entity's indexed source material, readable like any other file.
      files: sourceFiles,
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
          indexedSources.length > 0
            ? `This entity has ${indexedSources.length} indexed source item${indexedSources.length === 1 ? "" : "s"} under "sources/" (contacts, events, tasks, emails). Read them (ls sources/, then cat/grep) to ground the page in what they record, honouring the privacy rule.`
            : "",
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
        log.warn(
          { slug: entity.slug, violation: error.violation, err: error },
          "agentic write aborted (sandbox guard)",
        );
      } else {
        // An LLM failure here (no credits, rate limit, outage) must not abort the
        // ingest: the knowledge is already merged. The agentic write is best-effort
        // anyway, so fall through to the deterministic synthesis below — the page
        // still gets a real body, just without the LLM's prose polish.
        log.warn({ slug: entity.slug, err: error }, "agentic write failed, using synthesized body");
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
        log.warn(
          { slug: entity.slug, violation: diffViolation },
          "agentic page diff exceeds limit, using synthesized body",
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
      const knownEntities = this.linkableEntityNames();
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
    const withPages = this.store.wikiPageEntityIds();
    const knownNames = this.linkableEntityNames();
    const pending: Array<{ entity: EntityRow; body: string }> = [];
    for (const entity of this.store.listEntities()) {
      // Never synthesise a page for a connector-only / private-only entity.
      if (!withPages.has(entity.id)) continue;
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
    const withPages = this.store.wikiPageEntityIds();
    const knownNames = this.linkableEntityNames();
    const updates: Array<{ entity: EntityRow; body: string; count: number; mean: number }> = [];
    for (const entity of this.store.listEntities()) {
      // Skip connector-only / private-only entities: they don't warrant a page.
      if (!withPages.has(entity.id)) continue;
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

  /**
   * Remove pages for entities that no longer warrant one — connector-only people
   * (contacts/calendar/gmail) or private-only entities. Deletes the on-disk
   * Markdown and the persisted retrieval row, and clears any lingering stale
   * flags. Idempotent; safe to run on every backfill to clean up pages created
   * before connectors became reference-only. Returns how many pages were pruned.
   */
  pruneConnectorOnlyPages(): number {
    const withPages = this.store.wikiPageEntityIds();
    let pruned = 0;
    for (const entity of this.store.listEntities()) {
      if (withPages.has(entity.id)) continue;
      const file = this.pagePath(entity);
      const hadFile = fs.existsSync(file);
      const hadRow = this.store.wikiPageBody(entity.id) !== undefined;
      if (!hadFile && !hadRow) continue;
      if (hadFile) fs.rmSync(file, { force: true });
      this.store.deleteWikiPage(entity.id);
      this.store.clearStaleSources(entity.id);
      this.store.clearWikiStale(entity.id);
      pruned++;
    }
    return pruned;
  }
}
