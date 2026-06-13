import fs from "node:fs";
import path from "node:path";
import type { Embedder } from "../embedding/embedder.js";
import { extractKnowledge } from "../extract/extractor.js";
import { mergeExtraction } from "../knowledge/merge.js";
import { DEFAULT_SCHEMA_MD } from "../knowledge/schema-doc.js";
import type { KnowledgeStore, WikiChange } from "../knowledge/store.js";
import type { LlmClient } from "../llm/types.js";
import type { WikiWriter } from "../wiki/writer.js";
import { detectContradictions } from "./contradictions.js";

const DIGEST_SYSTEM_PROMPT = `You write the daily digest for MeOS, a personal second brain.
The digest is a calm morning briefing the user reads in under two minutes.

- Write in markdown, second person ("you captured...", "your knowledge base now...").
- Lead with what actually matters; skip empty sections entirely.
- Mention contradictions that need the user's attention explicitly — these are the one thing they should act on.
- Reference entities with [[Entity Name]] wiki-link syntax.
- If nothing happened, say so in one friendly sentence. Never pad.`;

export interface ConsolidationReport {
  decayed: number;
  promoted: number;
  staleRegenerated: number;
  /** Pages created/rewritten this pass, for the caller to commit and attribute. */
  wikiChanges: WikiChange[];
  orphanCount: number;
  /** New observations distilled from the user's own chat statements. */
  crystallized: number;
  /** Wiki pages whose [[links]] pointed at unknown entities, queued for repair. */
  brokenLinksRepaired: number;
  digestDate: string;
}

const WIKI_LINK = /\[\[([^\]]+)\]\]/g;

/**
 * Self-healing: a [[link]] to a name no entity answers to is a broken reference.
 * Flag the page stale so the next regeneration greps the wiki and repairs it.
 * Returns how many pages were flagged.
 */
function repairBrokenLinks(store: KnowledgeStore): number {
  let repaired = 0;
  for (const page of store.wikiPageBodies()) {
    const names = new Set<string>();
    for (const match of page.body.matchAll(WIKI_LINK)) names.add(match[1]!.trim());
    const broken = [...names].some((name) => name && !store.findEntityByName(name));
    if (broken) {
      store.markWikiStale(page.entity_id);
      repaired++;
    }
  }
  return repaired;
}

/**
 * Crystallization: treat what the user typed in chat as a knowledge source.
 * Their own statements ("Dana left the company in June") are extracted and
 * merged like any document — assistant replies are deliberately excluded, since
 * those are already derived from the base and re-ingesting them would be
 * circular. Returns the number of new observations distilled.
 */
async function crystallizeChat(deps: {
  store: KnowledgeStore;
  llm: LlmClient;
  embedder: Embedder;
  schema: string;
  since: string;
}): Promise<number> {
  const { store, llm, embedder, schema, since } = deps;
  const messages = store.recentUserMessages(since);
  if (messages.length === 0) return 0;

  const text = messages.map((m) => m.content).join("\n\n");
  const title = `Chat notes (${since.slice(0, 10)})`;
  const extraction = await extractKnowledge(llm, { title, text }, schema);
  if (extraction.entities.length === 0 && extraction.observations.length === 0) return 0;

  const sourceId = store.createSource({ type: "conversation", title, content: text });
  const merge = await mergeExtraction(store, embedder, extraction, sourceId);
  for (const id of merge.staleEntityIds) store.recordStaleSource(id, sourceId);
  await detectContradictions(store, llm, merge.newObservationIds, schema);
  return merge.newObservationIds.length;
}

/**
 * The nightly maintenance pass (§4.5): age unconfirmed knowledge, promote
 * corroborated observations to facts, refresh stale wiki pages, and produce
 * the daily digest. Ignoring the system for weeks leaves it healthier, not
 * degraded.
 */
export async function runConsolidation(deps: {
  store: KnowledgeStore;
  llm: LlmClient;
  wiki: WikiWriter;
  digestDir: string;
  /** When provided, the user's chat statements are crystallized into knowledge. */
  embedder?: Embedder;
  /** The schema document shared by every LLM stage; defaults to the built-in. */
  schema?: string;
  /** ISO date-time lower bound for "what changed"; defaults to the last 24h. */
  since?: string;
}): Promise<ConsolidationReport> {
  const { store, llm, wiki, digestDir } = deps;
  const schema = deps.schema ?? DEFAULT_SCHEMA_MD;
  const since = deps.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);

  const decayed = store.decayStaleConfidence();
  const promoted = store.promoteFacts();
  // Fold in new knowledge and queue repairs *before* regenerating, so this one
  // pass both writes the new pages and fixes the broken links it surfaced.
  const crystallized = deps.embedder
    ? await crystallizeChat({ store, llm, embedder: deps.embedder, schema, since })
    : 0;
  const brokenLinksRepaired = repairBrokenLinks(store);
  const wikiChanges = await wiki.regenerateStale();
  const staleRegenerated = wikiChanges.length;

  const sources = store.recentSources(since);
  const observations = store.recentObservations(since);
  const superseded = store.recentlySuperseded(since);
  const contradictions = store.unresolvedContradictions();
  const orphans = store.orphanEntities();

  const digestDate = new Date().toISOString().slice(0, 10);
  const content = await llm.complete({
    system: `${DIGEST_SYSTEM_PROMPT}\n\n--- SCHEMA ---\n${schema}`,
    cacheSystem: true,
    messages: [
      {
        role: "user",
        content: [
          `Generate the digest for ${digestDate}.`,
          "",
          `New sources ingested since ${since}:`,
          ...(sources.length ? sources.map((s) => `- ${s.title} (${s.type})`) : ["(none)"]),
          "",
          "New knowledge recorded:",
          ...(observations.length
            ? observations.slice(0, 50).map((o) => `- [${o.entity_name}] ${o.text}`)
            : ["(none)"]),
          "",
          "Facts superseded by newer information:",
          ...(superseded.length
            ? superseded.map((s) => `- [${s.entity_name}] "${s.old_text}" -> "${s.new_text}"`)
            : ["(none)"]),
          "",
          "Unresolved contradictions needing the user's attention:",
          ...(contradictions.length
            ? contradictions.map((c) => `- [${c.entity_name}] "${c.text_a}" vs "${c.text_b}"${c.note ? ` (${c.note})` : ""}`)
            : ["(none)"]),
          "",
          "Wiki pages with no connections to the rest of the graph (possible orphans):",
          ...(orphans.length ? orphans.slice(0, 20).map((o) => `- ${o.name} (${o.type})`) : ["(none)"]),
          "",
          `Maintenance: ${decayed} facts decayed, ${promoted} observations promoted to established facts, ${staleRegenerated} wiki pages refreshed, ${crystallized} fact(s) distilled from your chats, ${brokenLinksRepaired} broken link(s) repaired.`,
        ].join("\n"),
      },
    ],
  });

  store.saveDigest(digestDate, content);
  fs.mkdirSync(digestDir, { recursive: true });
  fs.writeFileSync(path.join(digestDir, `${digestDate}.md`), content);

  return {
    decayed,
    promoted,
    staleRegenerated,
    wikiChanges,
    orphanCount: orphans.length,
    crystallized,
    brokenLinksRepaired,
    digestDate,
  };
}
