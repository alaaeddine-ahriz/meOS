import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { runConsolidation } from "../src/memory/consolidate.js";
import { WikiWriter } from "../src/wiki/writer.js";
import { makeAgentClient } from "./fixtures/index.js";

/**
 * CONTRACT (offline, ungated) — the nightly digest (`runConsolidation`'s
 * `llm.complete`, background group, plain-text output) returns correct output
 * through the routed client on BOTH backends. This is the first non-structured
 * `complete` feature.
 *
 * To isolate the digest `complete` call we omit the embedder (skips chat
 * crystallization, which would add structured calls) and pass `regenerateWiki:
 * false` (skips the wiki runAgent) — so the ONLY LLM call is the digest. We assert
 * the routed client's OWN text is what gets persisted as the digest, so a pass
 * means the digest flowed through that backend (the agent fallback throws).
 */

function seed(store: KnowledgeStore): void {
  const entity = store.createEntity({ type: "person", name: "Dana" });
  store.insertObservation({
    entityId: entity.id,
    text: "Dana works as a designer.",
    confidence: 0.7,
  });
}

describe("nightly digest — backend parity (contract)", () => {
  let db: MeosDatabase;
  let store: KnowledgeStore;
  let tmpDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new KnowledgeStore(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-parity-"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("api backend: writes the digest through a conforming client", async () => {
    seed(store);
    const marker = "## Morning digest\n\nYou captured notes about [[Dana]] today.";
    const api = new StubLlmClient({ onComplete: () => marker });
    const wiki = new WikiWriter(store, api, path.join(tmpDir, "wiki"));

    const report = await runConsolidation({
      store,
      llm: api,
      wiki,
      digestDir: path.join(tmpDir, "digests"),
      regenerateWiki: false,
    });

    // The client's own digest text was persisted to the store and to disk.
    expect(store.latestDigest()!.content).toBe(marker);
    const onDisk = fs.readFileSync(
      path.join(tmpDir, "digests", `${report.digestDate}.md`),
      "utf-8",
    );
    expect(onDisk).toBe(marker);
  });

  it("agent backend: writes the digest through the real complete path (no fallback)", async () => {
    seed(store);
    const marker = "## Agent digest\n\nYou captured a note about [[Dana]]'s role.";
    // The scripted agent returns the digest markdown as plain text; complete()
    // surfaces it verbatim. The throwing fallback means a pass = the agent answered.
    const agent = makeAgentClient(path.join(tmpDir, "scratch"), () => marker);
    const wiki = new WikiWriter(store, new StubLlmClient(), path.join(tmpDir, "wiki"));

    const report = await runConsolidation({
      store,
      llm: agent,
      wiki,
      digestDir: path.join(tmpDir, "digests"),
      regenerateWiki: false,
    });

    expect(store.latestDigest()!.content).toBe(marker);
    const onDisk = fs.readFileSync(
      path.join(tmpDir, "digests", `${report.digestDate}.md`),
      "utf-8",
    );
    expect(onDisk).toBe(marker);
  });
});
