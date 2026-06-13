import fs from "node:fs";
import path from "node:path";
import { createBashTool } from "bash-tool";
import type { LlmClient } from "../llm/types.js";
import type { EntityRow, KnowledgeStore } from "../knowledge/store.js";

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

export class WikiWriter {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly llm: LlmClient,
    private readonly wikiDir: string,
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
  async regenerate(entityId: number, knownEntities?: string[]): Promise<void> {
    const entity = this.store.getEntity(entityId);
    if (!entity) return;

    const observations = this.store.activeObservations(entityId);
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

    await this.llm.runAgent({
      system: `${SYSTEM_PROMPT}\n\nKnown entities available for [[wiki-links]] (use exact names): ${names.join(", ") || "(none)"}`,
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

    const body = stripFrontmatter(await sandbox.readFile(relPath).catch(() => ""));
    const summary = (await sandbox.readFile(SUMMARY_FILE).catch(() => "")).trim();

    const confidences = observations.map((o) => o.confidence);
    const meanConfidence =
      confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;

    const frontmatter = [
      "---",
      `entity_id: ${entity.id}`,
      `type: ${entity.type}`,
      `name: ${JSON.stringify(entity.name)}`,
      `slug: ${entity.slug}`,
      `observations: ${observations.length}`,
      `mean_confidence: ${meanConfidence.toFixed(2)}`,
      `updated: ${new Date().toISOString()}`,
      "---",
      "",
    ].join("\n");

    const file = this.pagePath(entity);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${frontmatter}# ${entity.name}\n\n${body}\n`);

    if (summary) this.store.setEntitySummary(entity.id, summary);
    this.store.clearWikiStale(entity.id);
  }

  /**
   * Regenerate every page flagged stale, a few at a time in parallel (each
   * page is an independent agent run). Loops until no stale pages remain, so
   * entities marked stale mid-pass are picked up too. Returns the number
   * regenerated.
   */
  async regenerateStale(concurrency = 6): Promise<number> {
    let total = 0;
    while (true) {
      const stale = this.store.staleEntities();
      if (stale.length === 0) return total;
      total += stale.length;
      // Computed once per pass and shared across workers: the roster barely
      // changes between pages.
      const knownEntities = this.store.listEntities().map((e) => e.name).slice(0, MAX_KNOWN_ENTITIES);
      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, stale.length) }, async () => {
        while (next < stale.length) {
          const entity = stale[next++]!;
          await this.regenerate(entity.id, knownEntities);
        }
      });
      await Promise.all(workers);
    }
  }
}
