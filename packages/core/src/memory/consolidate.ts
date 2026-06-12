import fs from "node:fs";
import path from "node:path";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { LlmClient } from "../llm/types.js";
import type { WikiWriter } from "../wiki/writer.js";

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
  orphanCount: number;
  digestDate: string;
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
  /** ISO date-time lower bound for "what changed"; defaults to the last 24h. */
  since?: string;
}): Promise<ConsolidationReport> {
  const { store, llm, wiki, digestDir } = deps;
  const since = deps.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);

  const decayed = store.decayStaleConfidence();
  const promoted = store.promoteFacts();
  const staleRegenerated = await wiki.regenerateStale();

  const sources = store.recentSources(since);
  const observations = store.recentObservations(since);
  const superseded = store.recentlySuperseded(since);
  const contradictions = store.unresolvedContradictions();
  const orphans = store.orphanEntities();

  const digestDate = new Date().toISOString().slice(0, 10);
  const content = await llm.complete({
    system: DIGEST_SYSTEM_PROMPT,
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
          `Maintenance: ${decayed} facts decayed, ${promoted} observations promoted to established facts, ${staleRegenerated} wiki pages refreshed.`,
        ].join("\n"),
      },
    ],
  });

  store.saveDigest(digestDate, content);
  fs.mkdirSync(digestDir, { recursive: true });
  fs.writeFileSync(path.join(digestDir, `${digestDate}.md`), content);

  return { decayed, promoted, staleRegenerated, orphanCount: orphans.length, digestDate };
}
