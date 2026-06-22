import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentRunInput,
  CodingAgentDefinition,
} from "../src/coding-agent/types.js";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { WikiWriter } from "../src/wiki/writer.js";
import { failingFallback } from "./fixtures/index.js";

/**
 * CONTRACT (offline, ungated) — the wiki maintainer (`WikiWriter.regenerate`,
 * `runAgent`, wiki group) (re)writes an entity page through the routed client on
 * BOTH backends.
 *
 * runAgent is the sandbox-bridge method. WikiWriter NEVER ships an empty page: if
 * the agent doesn't write the file it falls back to a deterministic synthesized
 * body. So to prove the AGENT actually wrote the page (not the fallback), each
 * test asserts the persisted body contains the agent's OWN unique marker:
 *  - api  — a StubLlmClient whose onAgent writes the marker into the sandbox.
 *  - agent — CodingAgentLlmClient over a scripted agent that writes the marker to
 *    its real cwd; the bridge must mirror that file back into the sandbox.
 */

/** A scripted coding agent for runAgent: writes the page + SUMMARY into its cwd. */
class WikiWritingAgent implements CodingAgentDefinition {
  id = "claude" as const;
  label = "Scripted Wiki";
  bin = "scripted";
  installHint = "";
  models = [{ value: "scripted-model", label: "Scripted" }];
  defaultModel = "scripted-model";
  streaming = true;
  supportsResume = false;

  constructor(
    private readonly body: string,
    private readonly summary: string,
  ) {}

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const relPath = input.prompt.match(/target file is "([^"]+)"/)?.[1];
    if (!relPath) throw new Error("wiki prompt did not name a target file");
    const dest = path.join(input.cwd, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, this.body);
    fs.writeFileSync(path.join(input.cwd, "SUMMARY.txt"), this.summary);
    yield {
      type: "result",
      sessionId: "wiki",
      isError: false,
      subtype: "success",
      text: "done",
      costUsd: 0,
      numTurns: 1,
      durationMs: 0,
    };
  }
}

/** Seed a page-worthy entity (≥3 non-private facts clears the page-worthiness bar). */
function seedAda(store: KnowledgeStore): number {
  const entity = store.createEntity({ type: "person", name: "Ada Lovelace" });
  store.insertObservation({
    entityId: entity.id,
    text: "Ada wrote the first algorithm.",
    confidence: 0.9,
  });
  store.insertObservation({
    entityId: entity.id,
    text: "Ada collaborated with Charles Babbage on the Analytical Engine.",
    confidence: 0.9,
  });
  store.insertObservation({
    entityId: entity.id,
    text: "Ada was a 19th-century English mathematician.",
    confidence: 0.9,
  });
  return entity.id;
}

describe("wiki maintainer — backend parity (contract)", () => {
  let db: MeosDatabase;
  let store: KnowledgeStore;
  let tmpDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new KnowledgeStore(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-parity-"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("api backend: the agent writes the page through a conforming client", async () => {
    const marker = "API-WIKI-MARKER: she pioneered general-purpose computation.";
    const api = new StubLlmClient({
      onAgent: async (request) => {
        const relPath = request.prompt.match(/target file is "([^"]+)"/)?.[1];
        if (!relPath) throw new Error("no target file");
        await request.sandbox.writeFiles([
          { path: relPath, content: marker },
          { path: "SUMMARY.txt", content: "A pioneer of computing." },
        ]);
        return "done";
      },
    });
    const entityId = seedAda(store);
    const wiki = new WikiWriter(store, api, path.join(tmpDir, "api"));

    const change = await wiki.regenerate(entityId);

    expect(change?.kind).toBe("created");
    // The agent's OWN body was persisted (not the deterministic fallback).
    expect(store.wikiPageBody(entityId)?.body).toContain("API-WIKI-MARKER");
  });

  it("agent backend: the agent writes the page; the sandbox bridge mirrors it back (no fallback)", async () => {
    const marker = "AGENT-WIKI-MARKER: she pioneered general-purpose computation.";
    const agent = new CodingAgentLlmClient({
      agent: new WikiWritingAgent(marker, "A pioneer of computing."),
      scratchDir: path.join(tmpDir, "scratch"),
      fallback: failingFallback(),
    });
    const entityId = seedAda(store);
    const wiki = new WikiWriter(store, agent, path.join(tmpDir, "agent"));

    const change = await wiki.regenerate(entityId);

    expect(change?.kind).toBe("created");
    // The file the scripted agent wrote in its cwd was mirrored back through the
    // runAgent sandbox bridge and persisted — proving the agent body, not synthesis.
    expect(store.wikiPageBody(entityId)?.body).toContain("AGENT-WIKI-MARKER");
  });
});
