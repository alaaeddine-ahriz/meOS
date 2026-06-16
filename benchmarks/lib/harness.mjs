import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Import the BUILT @meos/core. Benchmarks deliberately exercise the real
 * compiled package (the same artifact the server/desktop ship) rather than the
 * TypeScript sources, so `pnpm build` is a prerequisite of `pnpm bench`.
 */
const coreEntry = path.join(here, "..", "..", "packages", "core", "dist", "index.js");

export async function loadCore() {
  try {
    return await import(coreEntry);
  } catch (error) {
    throw new Error(
      `Failed to import built @meos/core from ${coreEntry}. ` +
        `Run \`pnpm build\` (or \`pnpm --filter @meos/core build\`) first.\n${error}`,
    );
  }
}

/**
 * Seed a fresh in-memory store from the retrieval corpus fixture using the real
 * KnowledgeStore + HashEmbedder. Returns the store, the embedder, and ref->id
 * maps so a query's expected hits (named by ref) can be resolved to live ids.
 */
export async function seedRetrievalStore(core, corpus) {
  const { openDatabase, KnowledgeStore, HashEmbedder } = core;
  const db = openDatabase(":memory:");
  const store = new KnowledgeStore(db);
  const embedder = new HashEmbedder();

  const entityIds = new Map();
  for (const e of corpus.entities) {
    const row = store.createEntity({ type: e.type, name: e.name, summary: e.summary });
    entityIds.set(e.ref, row.id);
    for (const alias of e.aliases ?? []) store.addAlias(row.id, alias);
  }

  const sourceIds = new Map();
  for (const s of corpus.sources) {
    const id = store.createSource({ type: s.type, title: s.title, content: s.content });
    sourceIds.set(s.ref, id);
    // Index the raw source as a single searchable chunk (vector + FTS) so the
    // hybrid path's raw-excerpt stream has something to rank.
    const [vec] = await embedder.embed([s.content]);
    store.addChunks(id, [{ text: s.content, embedding: vec }]);
  }

  for (const o of corpus.observations) {
    const [vec] = await embedder.embed([o.text]);
    store.insertObservation({
      entityId: entityIds.get(o.entity),
      text: o.text,
      sourceId: sourceIds.get(o.source),
      embedding: vec,
      confidence: o.confidence,
    });
  }

  for (const r of corpus.relationships) {
    store.upsertRelationship(entityIds.get(r.from), entityIds.get(r.to), r.label);
  }

  for (const w of corpus.wikiPages) {
    const [vec] = await embedder.embed([w.body]);
    store.upsertWikiPage(entityIds.get(w.entity), w.body, vec);
  }

  return { db, store, embedder, entityIds, sourceIds };
}

/**
 * Build a deterministic StubLlmClient for the ingestion pipeline that:
 *  - returns the current document's canned extraction for "knowledge_extraction"
 *  - answers "contradiction_judgement" from the document's scripted judgement,
 *    matching new/prior observation ids by claim substring so the verdict lands
 *    on the right rows regardless of insertion order.
 * `getDoc()` returns the document currently being ingested (set by the runner).
 */
export function makeIngestionStub(core, getDoc) {
  const { StubLlmClient } = core;
  return new StubLlmClient({
    onStructured: (request) => {
      const doc = getDoc();
      if (request.schemaName === "knowledge_extraction") {
        return doc.extraction;
      }
      if (request.schemaName === "contradiction_judgement") {
        if (!doc.judgement) return { conflicts: [] };
        // The prompt lists "Existing facts" and "New facts" with "id N: text".
        const text = request.messages.map((m) => m.content).join("\n");
        const newId = matchId(text, "New facts:", doc.judgement.claimMatch);
        const existingId = matchId(text, "Existing facts:", doc.judgement.priorMatch);
        if (newId == null || existingId == null) return { conflicts: [] };
        return {
          conflicts: [
            {
              new_id: newId,
              existing_id: existingId,
              kind: doc.judgement.kind,
              note: doc.judgement.note,
            },
          ],
        };
      }
      throw new Error(`Unexpected structured request: ${request.schemaName}`);
    },
    // The wiki writer runs an agent over a sandbox; mimic a model that writes
    // the target page and a one-line summary, deterministically.
    onAgent: async (request) => {
      const relPath = request.prompt.match(/target file is "([^"]+)"/)?.[1];
      if (relPath) {
        await request.sandbox.writeFiles([
          { path: relPath, content: "A deterministic benchmark page." },
          { path: "SUMMARY.txt", content: "A generated one-line summary." },
        ]);
      }
      return "done";
    },
  });
}

/**
 * Find the "id N: ..." line under `section` whose text contains `needle`.
 * Scanning stops at the next "... facts:" header so a needle that also appears
 * in a different section can't match the wrong id.
 */
function matchId(haystack, section, needle) {
  const after = haystack.split(section)[1];
  if (!after) return null;
  for (const line of after.split("\n")) {
    if (/facts:/i.test(line)) break; // reached the next section
    const m = line.match(/id (\d+): (.*)/);
    if (m && m[2].toLowerCase().includes(needle.toLowerCase())) return Number(m[1]);
  }
  return null;
}
