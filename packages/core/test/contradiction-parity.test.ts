import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { detectContradictions } from "../src/memory/contradictions.js";
import { makeAgentClient } from "./fixtures/index.js";

/**
 * CONTRACT (offline, ungated) — contradiction judgement (`detectContradictions`,
 * `completeStructured`, schema `contradiction_judgement`, background group) returns
 * the correct verdict through the routed client on BOTH backends. Unlike meeting
 * detection, this feature does NOT swallow an LLM error — it would propagate — so
 * the throwing fallback on the agent client makes "the agent produced valid JSON"
 * the only way the supersession can be recorded.
 *
 * Setup mirrors `memory.test.ts`: a prior fact ("lives in Paris") and a newer one
 * ("moved to Berlin") — the textbook supersession case.
 */

/** Seed an entity with a prior fact and a newer, superseding fact. Returns their ids. */
async function seedDana(store: KnowledgeStore) {
  const embedder = new HashEmbedder();
  const entity = store.createEntity({ type: "person", name: "Dana" });
  const [v1, v2] = await embedder.embed(["Dana lives in Paris.", "Dana moved to Berlin in May."]);
  const oldId = store.insertObservation({
    entityId: entity.id,
    text: "Dana lives in Paris.",
    embedding: v1!,
    confidence: 0.7,
  });
  const newId = store.insertObservation({
    entityId: entity.id,
    text: "Dana moved to Berlin in May.",
    embedding: v2!,
    confidence: 0.5,
  });
  return { entity, oldId, newId };
}

describe("contradiction judgement — backend parity (contract)", () => {
  let db: MeosDatabase;
  let store: KnowledgeStore;
  let scratchDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new KnowledgeStore(db);
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "contradiction-parity-"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("api backend: records supersession through a conforming structured client", async () => {
    const { entity, oldId, newId } = await seedDana(store);
    const api = new StubLlmClient({
      onStructured: (request) => {
        expect(request.schemaName).toBe("contradiction_judgement");
        return {
          conflicts: [
            { new_id: newId, existing_id: oldId, kind: "supersedes", note: "moved cities" },
          ],
        };
      },
    });

    const summary = await detectContradictions(store, api, [newId]);

    expect(summary.superseded).toBe(1);
    // The superseded fact no longer feeds the active knowledge.
    expect(store.activeObservations(entity.id).map((o) => o.id)).toEqual([newId]);
  });

  it("agent backend: records supersession through the real completeStructured path (no fallback)", async () => {
    const { entity, oldId, newId } = await seedDana(store);
    // The scripted agent emits the judgement as raw JSON, using the real ids the
    // feature put in the prompt. The throwing fallback means a pass = the agent's
    // own JSON satisfied the schema and the supersession was applied.
    const agent = makeAgentClient(scratchDir, () =>
      JSON.stringify({
        conflicts: [
          { new_id: newId, existing_id: oldId, kind: "supersedes", note: "moved cities" },
        ],
      }),
    );

    const summary = await detectContradictions(store, agent, [newId]);

    expect(summary.superseded).toBe(1);
    expect(store.activeObservations(entity.id).map((o) => o.id)).toEqual([newId]);
  });
});
