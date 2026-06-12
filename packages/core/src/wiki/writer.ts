import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LlmClient } from "../llm/types.js";
import type { EntityRow, KnowledgeStore } from "../knowledge/store.js";

const wikiPageSchema = z.object({
  summary: z.string(),
  body: z.string(),
});

const SYSTEM_PROMPT = `You are the wiki maintainer of MeOS, a personal second brain.
You write and continuously update wiki pages that summarise everything the system knows about an entity.

Rules:
- Write in clear, factual prose, as a thoughtful summary by someone who has read every relevant source.
- Use ONLY the observations and relationships provided. Never add outside knowledge or speculation.
- Observations are listed with a confidence score. State high-confidence facts plainly. Hedge low-confidence ones explicitly ("a single note suggests...", "as of <date>...").
- Link other known entities inline using [[Entity Name]] wiki-link syntax, using their exact names from the known-entities list. Link each entity at most a few times.
- Structure: a short opening paragraph, then "## " sections only if there is enough material to justify them. No top-level title (the page header is rendered separately).
- The summary field is one sentence describing the entity, suitable for a directory listing.`;

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

  async regenerate(entityId: number): Promise<void> {
    const entity = this.store.getEntity(entityId);
    if (!entity) return;

    const observations = this.store.activeObservations(entityId);
    const relationships = this.store.relationshipsFor(entityId);
    const knownEntities = this.store
      .listEntities()
      .filter((e) => e.id !== entityId)
      .map((e) => e.name)
      .slice(0, 300);

    const observationLines = observations.map(
      (o) => `- [confidence ${o.confidence.toFixed(2)}, recorded ${o.created_at}] ${o.text}`,
    );
    const relationshipLines = relationships.map((r) =>
      r.from_entity === entityId ? `- this entity ${r.label} ${r.to_name}` : `- ${r.from_name} ${r.label} this entity`,
    );

    const page = await this.llm.completeStructured({
      system: SYSTEM_PROMPT,
      cacheSystem: true,
      schema: wikiPageSchema,
      schemaName: "wiki_page",
      messages: [
        {
          role: "user",
          content: [
            `Entity: ${entity.name} (type: ${entity.type})`,
            "",
            "Observations:",
            observationLines.join("\n") || "(none)",
            "",
            "Relationships:",
            relationshipLines.join("\n") || "(none)",
            "",
            `Known entities available for [[wiki-links]]: ${knownEntities.join(", ") || "(none)"}`,
          ].join("\n"),
        },
      ],
    });

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
    fs.writeFileSync(file, `${frontmatter}# ${entity.name}\n\n${page.body.trim()}\n`);

    this.store.setEntitySummary(entity.id, page.summary);
    this.store.clearWikiStale(entity.id);
  }

  /**
   * Regenerate every page flagged stale, a few at a time in parallel (each
   * page is an independent LLM call). Loops until no stale pages remain, so
   * entities marked stale mid-pass are picked up too. Returns the number
   * regenerated.
   */
  async regenerateStale(concurrency = 3): Promise<number> {
    let total = 0;
    while (true) {
      const stale = this.store.staleEntities();
      if (stale.length === 0) return total;
      total += stale.length;
      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, stale.length) }, async () => {
        while (next < stale.length) {
          const entity = stale[next++]!;
          await this.regenerate(entity.id);
        }
      });
      await Promise.all(workers);
    }
  }
}
