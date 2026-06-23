import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { crystallizeSession } from "../src/memory/crystallize.js";
import { makeAgentClient } from "./fixtures/index.js";

/**
 * CONTRACT (offline, ungated) — session crystallization (`crystallizeSession`,
 * `completeStructured`, background group) returns the correct output through the
 * routed client on BOTH backends. Note this feature makes TWO structured calls in
 * sequence — `session_digest` then `knowledge_extraction` — so the agent backend
 * must satisfy both; the scripted reply branches on the schema name in the prompt.
 * A throwing fallback means a pass = the agent produced valid JSON for BOTH calls.
 */

const sessionDigest = {
  question: "Which backend should we use?",
  conclusion: "Appwrite, for the local-first path.",
  decisions: ["Use Appwrite for the backend."],
  facts: ["Appwrite was chosen for the local-first backend."],
  openQuestions: [],
  lessons: ["Compare local deployment and hosted migration paths when evaluating infra."],
};

const sessionExtraction = {
  entities: [{ name: "Appwrite", type: "concept", aliases: [], summary: "Backend platform." }],
  relationships: [],
  observations: [
    {
      entity: "Appwrite",
      claim: "Appwrite was chosen for the local-first backend.",
      kind: "decision",
      sourceQuote: null,
      validFrom: null,
      validUntil: null,
      confidence: 0.8,
      sensitivity: "normal",
    },
  ],
};

function seedConversation(store: KnowledgeStore): number {
  const convo = store.createConversation();
  store.addMessage(convo, "user", "Which backend should we use?");
  store.addMessage(convo, "assistant", "Appwrite fits the local-first requirement.");
  return convo;
}

function assertCrystal(
  store: KnowledgeStore,
  crystal: Awaited<ReturnType<typeof crystallizeSession>>,
) {
  expect(crystal).toBeDefined();
  expect(store.getSourceType(crystal!.sourceId)).toBe("session");
  expect(store.getSourceContent(crystal!.sourceId)).toContain(
    "Appwrite, for the local-first path.",
  );
  const appwrite = store.findEntityByName("Appwrite")!;
  expect(appwrite).toBeDefined();
  const obs = store.activeObservations(appwrite.id);
  expect(obs.map((o) => o.text)).toContain("Appwrite was chosen for the local-first backend.");
}

describe("session crystallization — backend parity (contract)", () => {
  let db: MeosDatabase;
  let store: KnowledgeStore;
  let scratchDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new KnowledgeStore(db);
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "crystallize-parity-"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("api backend: distils + merges through a conforming structured client", async () => {
    const api = new StubLlmClient({
      onStructured: (request) => {
        if (request.schemaName === "session_digest") return sessionDigest;
        if (request.schemaName === "knowledge_extraction") return sessionExtraction;
        throw new Error(`unexpected schema ${request.schemaName}`);
      },
    });
    const convo = seedConversation(store);

    const crystal = await crystallizeSession({
      store,
      llm: api,
      embedder: new HashEmbedder(),
      conversationId: convo,
    });

    assertCrystal(store, crystal);
  });

  it("agent backend: distils + merges through the real completeStructured path (no fallback)", async () => {
    // crystallizeSession calls session_digest then knowledge_extraction — branch the
    // scripted agent on which schema the prompt asks for so both calls get valid JSON.
    const agent = makeAgentClient(scratchDir, (input) =>
      input.prompt.includes("session_digest")
        ? JSON.stringify(sessionDigest)
        : JSON.stringify(sessionExtraction),
    );
    const convo = seedConversation(store);

    const crystal = await crystallizeSession({
      store,
      llm: agent,
      embedder: new HashEmbedder(),
      conversationId: convo,
    });

    assertCrystal(store, crystal);
  });
});
