import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { crystallizeSession } from "../src/memory/crystallize.js";

const extraction = {
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

function stub() {
  return new StubLlmClient({
    onStructured: (req) => {
      if (req.schemaName === "session_digest") {
        return {
          question: "Which backend should we use?",
          conclusion: "Appwrite, for the local-first path.",
          decisions: ["Use Appwrite for the backend."],
          facts: ["Appwrite was chosen for the local-first backend."],
          openQuestions: [],
          lessons: ["Compare local deployment and hosted migration paths when evaluating infra."],
        };
      }
      if (req.schemaName === "knowledge_extraction") return extraction;
      throw new Error(`unexpected schema ${req.schemaName}`);
    },
  });
}

describe("crystallizeSession", () => {
  it("distils a conversation into a session source and merges its knowledge", async () => {
    const store = new KnowledgeStore(openDatabase(":memory:"));
    const convo = store.createConversation();
    store.addMessage(convo, "user", "Which backend should we use?");
    store.addMessage(convo, "assistant", "Appwrite fits the local-first requirement.");

    const crystal = await crystallizeSession({ store, llm: stub(), embedder: new HashEmbedder(), conversationId: convo });

    expect(crystal).toBeDefined();
    // a first-class "session" source was created from the digest
    expect(store.getSourceType(crystal!.sourceId)).toBe("session");
    expect(store.getSourceContent(crystal!.sourceId)).toContain("Appwrite, for the local-first path.");
    // the decision was merged as a typed claim
    const appwrite = store.findEntityByName("Appwrite")!;
    const obs = store.activeObservations(appwrite.id);
    expect(obs.map((o) => o.text)).toContain("Appwrite was chosen for the local-first backend.");
    expect(obs[0]!.kind).toBe("decision");
  });

  it("returns undefined for an empty conversation", async () => {
    const store = new KnowledgeStore(openDatabase(":memory:"));
    const convo = store.createConversation();
    const crystal = await crystallizeSession({ store, llm: stub(), embedder: new HashEmbedder(), conversationId: convo });
    expect(crystal).toBeUndefined();
  });
});
