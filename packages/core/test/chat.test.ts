import { describe, expect, it } from "vitest";
import { ChatService } from "../src/chat/chat.js";
import { buildChatTools } from "../src/chat/tools.js";
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
  const [chunkVector] = await embedder.embed([
    "Orion is the new search infrastructure project led by Dana.",
  ]);
  store.addChunks(sourceId, [
    {
      text: "Orion is the new search infrastructure project led by Dana.",
      embedding: chunkVector!,
    },
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
  it("drives a tool loop, streams the run, and persists both turns with citations", async () => {
    const { store, embedder } = await seededStore();
    // Script the agent: search the knowledge base (the real tool runs and
    // collects sources), then answer from what it found.
    const llm = new StubLlmClient({
      onAgentStream: () => [
        { type: "reasoning", text: "Let me look up Orion." },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "search_knowledge",
          input: { query: "Orion lead" },
        },
        { type: "text", text: "Orion is led by Dana." },
      ],
    });
    const chat = new ChatService(store, llm, embedder);

    const conversationId = store.createConversation();
    let reply = "";
    let reasoning = "";
    const toolCalls: string[] = [];
    let sawToolResult = false;
    let sourceTitles: string[] = [];
    for await (const event of chat.respond(conversationId, "Who leads Orion?")) {
      if (event.type === "delta") reply += event.text;
      else if (event.type === "reasoning") reasoning += event.text;
      else if (event.type === "tool-call") toolCalls.push(event.toolName);
      else if (event.type === "tool-result") sawToolResult = true;
      else if (event.type === "sources") sourceTitles = event.sources.map((s) => s.title);
    }

    expect(reply).toBe("Orion is led by Dana.");
    expect(reasoning).toContain("look up Orion");
    // the agent's tool call (and its result) surface live
    expect(toolCalls).toContain("search_knowledge");
    expect(sawToolResult).toBe(true);
    // the answer announces which documents the tools drew on
    expect(sourceTitles).toContain("Project notes");

    const messages = store.listMessages(conversationId);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // citations survive a reload: the assistant message keeps its sources
    expect(messages[1]!.sources.map((s) => s.title)).toContain("Project notes");

    // the model was driven through the agent loop with the bare user turn
    const agentRun = llm.requests.find((r) => r.kind === "agentStream")!;
    expect(agentRun.request.messages.at(-1)!.content).toBe("Who leads Orion?");
    expect("tools" in agentRun.request && agentRun.request.tools.search_knowledge).toBeTruthy();

    // conversation titled from the first user message
    expect(store.listConversations()[0]!.title).toBe("Who leads Orion?");
  });
});

describe("KnowledgeStore.exploreSubgraph", () => {
  it("walks multiple hops and returns the connected nodes + labelled edges", async () => {
    const { store } = await seededStore();
    const orion = store.findEntityByName("Orion")!;
    const dana = store.createEntity({ type: "person", name: "Dana" });
    const helix = store.createEntity({ type: "project", name: "Helix" });
    const acme = store.createEntity({ type: "organisation", name: "Acme" });
    store.upsertRelationship(dana.id, orion.id, "leads"); // hop 1 from Orion
    store.upsertRelationship(orion.id, helix.id, "depends on"); // hop 1
    store.upsertRelationship(helix.id, acme.id, "owned by"); // hop 2 (via Helix)

    const oneHop = store.exploreSubgraph(orion.id, 1);
    expect(oneHop.nodes.map((n) => n.name).sort()).toEqual(["Dana", "Helix", "Orion"]);
    expect(oneHop.nodes.some((n) => n.name === "Acme")).toBe(false); // 2 hops away

    const twoHop = store.exploreSubgraph(orion.id, 2);
    expect(twoHop.nodes.map((n) => n.name)).toContain("Acme"); // reached on hop 2
    expect(twoHop.edges).toContainEqual(expect.objectContaining({ label: "owned by" }));
  });
});

describe("buildChatTools — explore_graph", () => {
  it("accumulates the traversed subgraph for the UI to draw", async () => {
    const { store, embedder } = await seededStore();
    const orion = store.findEntityByName("Orion")!;
    const dana = store.createEntity({ type: "person", name: "Dana" });
    store.upsertRelationship(dana.id, orion.id, "leads");

    const { tools, graph } = buildChatTools(store, embedder);
    const output = (await tools.explore_graph!.execute!(
      { name: "Orion", depth: 2 },
      { toolCallId: "t", messages: [] },
    )) as string;

    // the model gets a readable adjacency list...
    expect(output).toContain("Dana leads Orion");
    // ...and the turn-level graph accumulates the nodes/edges for rendering
    expect([...graph.nodes.values()].map((n) => n.name).sort()).toEqual(["Dana", "Orion"]);
    expect([...graph.edges.values()]).toContainEqual(expect.objectContaining({ label: "leads" }));
  });
});
