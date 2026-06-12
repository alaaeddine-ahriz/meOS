import { describe, expect, it } from "vitest";
import { ChatService } from "../src/chat/chat.js";
import { buildContextPack } from "../src/chat/retrieval.js";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";

async function seededStore() {
  const db = openDatabase(":memory:");
  const store = new KnowledgeStore(db);
  const embedder = new HashEmbedder();

  const sourceId = store.createSource({
    type: "text",
    title: "Project notes",
    content: "Orion is the new search infrastructure project led by Dana.",
  });
  const [chunkVector] = await embedder.embed(["Orion is the new search infrastructure project led by Dana."]);
  store.addChunks(sourceId, [
    { text: "Orion is the new search infrastructure project led by Dana.", embedding: chunkVector! },
  ]);

  const orion = store.createEntity({ type: "project", name: "Orion" });
  const [observationVector] = await embedder.embed(["Orion is led by Dana."]);
  store.insertObservation({
    entityId: orion.id,
    text: "Orion is led by Dana.",
    sourceId,
    embedding: observationVector!,
    confidence: 0.8,
  });

  return { store, embedder };
}

describe("buildContextPack", () => {
  it("combines entity facts and chunk excerpts with source attribution", async () => {
    const { store, embedder } = await seededStore();
    const pack = await buildContextPack(store, embedder, "What do I know about Orion?");

    expect(pack.matchedEntities.map((e) => e.name)).toContain("Orion");
    expect(pack.text).toContain("Orion is led by Dana.");
    expect(pack.text).toContain("confidence 0.80");
    expect(pack.sources.map((s) => s.title)).toContain("Project notes");
  });
});

describe("ChatService", () => {
  it("streams a reply, injects context, and persists both turns", async () => {
    const { store, embedder } = await seededStore();
    const llm = new StubLlmClient({ onComplete: () => "Orion is led by Dana." });
    const chat = new ChatService(store, llm, embedder);

    const conversationId = store.createConversation();
    let reply = "";
    let sourceTitles: string[] = [];
    for await (const event of chat.respond(conversationId, "Who leads Orion?")) {
      if (event.type === "delta") reply += event.text;
      else if (event.type === "sources") sourceTitles = event.sources.map((s) => s.title);
    }

    expect(reply).toBe("Orion is led by Dana.");
    // the answer announces which documents it draws on
    expect(sourceTitles).toContain("Project notes");
    const messages = store.listMessages(conversationId);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // citations survive a reload: the assistant message keeps its sources
    expect(messages[1]!.sources.map((s) => s.title)).toContain("Project notes");

    // the model saw the knowledge context, not just the bare question
    const streamed = llm.requests.find((r) => r.kind === "stream")!;
    const lastMessage = streamed.request.messages.at(-1)!;
    expect(lastMessage.content).toContain("<knowledge_context>");
    expect(lastMessage.content).toContain("Who leads Orion?");

    // conversation titled from the first user message
    expect(store.listConversations()[0]!.title).toBe("Who leads Orion?");
  });
});
