import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import type { AgentActivityChunk } from "../src/llm/types.js";
import { WikiWriter, type WikiRunSink, type WikiRunStart } from "../src/wiki/writer.js";

describe("wiki-run transcripts", () => {
  let db: MeosDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-runs-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists runs and ordered events, coalescing nothing at the store layer", () => {
    const store = new KnowledgeStore(db);
    const entity = store.createEntity({ type: "person", name: "Ada Lovelace" });

    const runId = store.createWikiRun({
      entityId: entity.id,
      name: entity.name,
      type: entity.type,
      slug: entity.slug,
      sourceIds: [],
    });
    store.appendWikiRunEvent(runId, { seq: 0, kind: "reasoning", payload: "Let me check the page." });
    store.appendWikiRunEvent(runId, { seq: 1, kind: "tool-call", toolName: "readFile", payload: '{"path":"person/ada.md"}' });
    store.appendWikiRunEvent(runId, { seq: 2, kind: "tool-call", toolName: "writeFile", payload: '{"path":"person/ada.md"}' });
    store.finishWikiRun(runId, "done");

    const runs = store.listWikiRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.finished_at).not.toBeNull();

    const events = store.getWikiRunEvents(runId);
    expect(events.map((e) => e.kind)).toEqual(["reasoning", "tool-call", "tool-call"]);
    expect(events[1]!.tool_name).toBe("readFile");
  });

  it("streams the agent's activity to the run sink and finishes 'done'", async () => {
    const store = new KnowledgeStore(db);
    const entity = store.createEntity({ type: "person", name: "Ada Lovelace" });
    store.insertObservation({ entityId: entity.id, text: "Ada wrote the first algorithm.", confidence: 0.9 });

    // A stub agent that emits reasoning + a tool call, then writes the page.
    const llm = new StubLlmClient({
      onAgent: async (request) => {
        const relPath = request.prompt.match(/target file is "([^"]+)"/)?.[1]!;
        request.onActivity?.({ type: "reasoning", text: "Thinking about Ada…" });
        request.onActivity?.({ type: "tool-call", toolName: "writeFile", input: { path: relPath } });
        await request.sandbox.writeFiles([
          { path: relPath, content: "Ada Lovelace wrote the first algorithm." },
          { path: "SUMMARY.txt", content: "Ada, a mathematician." },
        ]);
        return "done";
      },
    });

    const captured: AgentActivityChunk[] = [];
    let finished: "done" | "failed" | null = null;
    const hook = (_start: WikiRunStart): WikiRunSink => ({
      event: (chunk) => captured.push(chunk),
      finish: (status) => {
        finished = status;
      },
    });

    const wiki = new WikiWriter(store, llm, tmpDir, undefined, hook);
    const change = await wiki.regenerate(entity.id);

    expect(change?.kind).toBe("created");
    expect(finished).toBe("done");
    expect(captured.map((c) => c.type)).toEqual(["reasoning", "tool-call"]);
    expect(captured[0]).toMatchObject({ type: "reasoning", text: "Thinking about Ada…" });
  });

  it("finishes the run 'failed' when the agent throws", async () => {
    const store = new KnowledgeStore(db);
    const entity = store.createEntity({ type: "person", name: "Grace Hopper" });
    store.insertObservation({ entityId: entity.id, text: "Coined 'debugging'.", confidence: 0.9 });

    const llm = new StubLlmClient({
      onAgent: async () => {
        throw new Error("no credits");
      },
    });

    let finished: "done" | "failed" | null = null;
    const wiki = new WikiWriter(store, llm, tmpDir, undefined, () => ({
      event: () => {},
      finish: (status) => {
        finished = status;
      },
    }));

    // The page still gets a deterministic body even though the agent failed.
    const change = await wiki.regenerate(entity.id);
    expect(finished).toBe("failed");
    expect(change?.kind).toBe("created");
  });
});
