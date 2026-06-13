import fs from "node:fs";
import path from "node:path";
import { createBashTool } from "bash-tool";
import type { Embedder } from "../embedding/embedder.js";
import { loadSchema } from "../knowledge/schema-doc.js";
import type { LlmClient } from "../llm/types.js";
import type { EntityRow, KnowledgeStore, ObservationRow, RelationshipView, WikiChange } from "../knowledge/store.js";

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

/**
 * Deterministic page body from an entity's knowledge — the safety net used when
 * the agentic writer returns nothing, so a page is never empty and the wiki
 * retrieval stream is always populated. Plain, factual, link-free prose.
 */
function synthesizeBody(entity: EntityRow, observations: ObservationRow[], relationships: RelationshipView[]): string {
  const parts: string[] = [];
  if (entity.summary) parts.push(entity.summary);

  if (observations.length > 0) {
    const facts = observations.slice(0, 30).map((o) => {
      const hedge = o.confidence < 0.4 ? " (low confidence)" : "";
      return `- ${o.text}${hedge}`;
    });
    parts.push(`## What we know\n${facts.join("\n")}`);
  }

  if (relationships.length > 0) {
    const links = relationships.slice(0, 30).map((r) =>
      r.from_entity === entity.id ? `- ${entity.name} ${r.label} ${r.to_name}` : `- ${r.from_name} ${r.label} ${entity.name}`,
    );
    parts.push(`## Connections\n${links.join("\n")}`);
  }

  return parts.join("\n\n").trim() || `${entity.name} is a ${entity.type} in your knowledge base.`;
}

/** The full on-disk page: deterministic frontmatter (owned by code) + title + body. */
function composePage(entity: EntityRow, body: string, observationCount: number, meanConfidence: number): string {
  const frontmatter = [
    "---",
    `entity_id: ${entity.id}`,
    `type: ${entity.type}`,
    `name: ${JSON.stringify(entity.name)}`,
    `slug: ${entity.slug}`,
    `observations: ${observationCount}`,
    `mean_confidence: ${meanConfidence.toFixed(2)}`,
    `updated: ${new Date().toISOString()}`,
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
  ) {}

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
    const observations = this.store
      .activeObservations(entityId)
      .filter((o) => o.sensitivity === "normal");
    const relationships = this.store.relationshipsFor(entityId);
    const names = knownEntities ?? this.store.listEntities().map((e) => e.name).slice(0, MAX_KNOWN_ENTITIES);

    const observationLines = observations.map(
      (o) => `- [confidence ${o.confidence.toFixed(2)}, recorded ${o.created_at}] ${o.text}`,
    );
    const relationshipLines = relationships.map((r) =>
      r.from_entity === entityId ? `- this entity ${r.label} ${r.to_name}` : `- ${r.from_name} ${r.label} this entity`,
    );

    const relPath = `${entity.type}/${entity.slug}.md`;
    fs.mkdirSync(this.wikiDir, { recursive: true });
    const { tools, sandbox } = await createBashTool({
      uploadDirectory: { source: this.wikiDir, include: "**/*.md" },
    });

    const schema = loadSchema(path.dirname(this.wikiDir));
    await this.llm.runAgent({
      system: `${SYSTEM_PROMPT}\n\n--- SCHEMA ---\n${schema}\n\nKnown entities available for [[wiki-links]] (use exact names): ${names.join(", ") || "(none)"}`,
      tools,
      sandbox,
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

    // The agentic write is best-effort: some models/providers complete the run
    // without reliably writing the file. Never ship an empty page — fall back to
    // a deterministic body assembled from the same observations and
    // relationships, so the compiled-knowledge retrieval stream is always lit.
    const agentBody = stripFrontmatter(await sandbox.readFile(relPath).catch(() => ""));
    const body = agentBody || synthesizeBody(entity, observations, relationships);
    const summary =
      (await sandbox.readFile(SUMMARY_FILE).catch(() => "")).trim() || entity.summary || `${entity.name} (${entity.type}).`;

    // Only touch the file when the prose actually changed: a no-op rewrite
    // would churn the frontmatter timestamp, dirty git, and surface an empty
    // diff. A page with no prior file is always a real "created" change.
    const created = beforeBody === null;
    const changed = created || beforeBody !== body;
    if (changed) {
      const file = this.pagePath(entity);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, composePage(entity, body, observations.length, meanOf(observations)));
      // Persist the compiled prose so chat retrieves it directly (and BM25 can
      // index it); embed it when an embedder is available for semantic recall.
      if (body) {
        const [vector] = this.embedder ? await this.embedder.embed([body]) : [undefined];
        this.store.upsertWikiPage(entity.id, body, vector);
      }
    }

    if (summary) this.store.setEntitySummary(entity.id, summary);

    // Credit the documents that made this page stale before clearing them.
    const sourceIds = this.store.pendingStaleSources(entity.id);
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
      sourceIds,
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
      const knownEntities = this.store.listEntities().map((e) => e.name).slice(0, MAX_KNOWN_ENTITIES);
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
    const pending: Array<{ entity: EntityRow; body: string }> = [];
    for (const entity of this.store.listEntities()) {
      const file = this.readPage(entity);
      let diskBody = file ? stripFrontmatter(file) : "";

      // Fill a blank/missing page on disk from a deterministic synthesis (no LLM)
      // so the visible wiki and git-synced artifact aren't empty — independent of
      // whether the retrieval index already has this entity.
      if (!diskBody) {
        const observations = this.store.activeObservations(entity.id).filter((o) => o.sensitivity === "normal");
        const body = synthesizeBody(entity, observations, this.store.relationshipsFor(entity.id));
        if (body) {
          const dest = this.pagePath(entity);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, composePage(entity, body, observations.length, meanOf(observations)));
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
}
