import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatService } from "../src/chat/chat.js";
import type {
  AgentEvent,
  AgentRunInput,
  CodingAgentDefinition,
} from "../src/coding-agent/types.js";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { failingFallback } from "./fixtures/index.js";

/**
 * CONTRACT (offline, ungated) — agentic chat (`ChatService.respond`, `streamAgent`)
 * streams an agent run through the routed client on BOTH backends.
 *
 * Backend difference (by design): in API mode the in-process AI-SDK `tools` run
 * inside the loop (so source/graph collectors fire). In agent mode the run is an
 * external CLI that reaches meOS tools over MCP — `CodingAgentLlmClient.streamAgent`
 * does NOT execute the in-process tools — so the agent emits its own
 * tool-call/tool-result transcript. Both backends must stream reasoning, the tool
 * call + its result, and the text reply through `respond`, and persist the turn.
 */

/** A scripted coding agent for streamAgent: replays events, then a (content-less) result. */
class ChatScriptedAgent implements CodingAgentDefinition {
  id = "claude" as const;
  label = "Scripted Chat";
  bin = "scripted";
  installHint = "";
  models = [{ value: "scripted-model", label: "Scripted" }];
  defaultModel = "scripted-model";
  streaming = true;
  supportsResume = false;

  constructor(private readonly events: AgentEvent[]) {}

  async *run(_input: AgentRunInput): AsyncIterable<AgentEvent> {
    for (const event of this.events) yield event;
    yield {
      type: "result",
      sessionId: "chat",
      isError: false,
      subtype: "success",
      text: "",
      costUsd: 0,
      numTurns: 1,
      durationMs: 0,
    };
  }
}

async function seededStore() {
  const db: MeosDatabase = openDatabase(":memory:");
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
  return { db, store, embedder };
}

describe("agentic chat — backend parity (contract)", () => {
  let db: MeosDatabase;
  let store: KnowledgeStore;
  let embedder: HashEmbedder;
  let scratchDir: string;

  beforeEach(async () => {
    ({ db, store, embedder } = await seededStore());
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-parity-"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("api backend: drives the tool loop and streams the answer + citations", async () => {
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
    expect(reasoning).toContain("Orion");
    expect(toolCalls).toContain("search_knowledge");
    expect(sawToolResult).toBe(true);
    // In-process tools ran, so the cited document was announced.
    expect(sourceTitles).toContain("Project notes");
    expect(store.listMessages(conversationId).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("agent backend: streams the agent's reasoning, tool transcript, and reply (no fallback)", async () => {
    // The external agent emits its own tool transcript; streamAgent maps each event
    // to a chat chunk. The throwing fallback means a pass = the agent run streamed.
    const agentDef = new ChatScriptedAgent([
      { type: "reasoning", text: "Let me think about Orion.", agentId: null },
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "search_knowledge",
        input: { query: "Orion lead" },
        agentId: null,
      },
      {
        type: "tool-result",
        toolCallId: "t1",
        toolName: "search_knowledge",
        output: "Orion is led by Dana.",
        isError: false,
        agentId: null,
      },
      { type: "text", text: "Orion is led by Dana.", agentId: null },
    ]);
    const llm = new CodingAgentLlmClient({
      agent: agentDef,
      scratchDir,
      fallback: failingFallback(),
    });
    const chat = new ChatService(store, llm, embedder);
    const conversationId = store.createConversation();

    let reply = "";
    let reasoning = "";
    const toolCalls: string[] = [];
    let sawToolResult = false;
    for await (const event of chat.respond(conversationId, "Who leads Orion?")) {
      if (event.type === "delta") reply += event.text;
      else if (event.type === "reasoning") reasoning += event.text;
      else if (event.type === "tool-call") toolCalls.push(event.toolName);
      else if (event.type === "tool-result") sawToolResult = true;
    }

    expect(reply).toBe("Orion is led by Dana.");
    expect(reasoning).toContain("Orion");
    expect(toolCalls).toContain("search_knowledge");
    expect(sawToolResult).toBe(true);
    // The turn was persisted with the agent's streamed reply.
    const messages = store.listMessages(conversationId);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.content).toBe("Orion is led by Dana.");
  });
});
