import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContextPack } from "../src/chat/retrieval.js";
import { migrations, openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { processMeetingNote } from "../src/ingest/meeting.js";
import { IngestionPipeline } from "../src/ingest/pipeline.js";
import { suggestMeetingLinks } from "../src/knowledge/meeting-links.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { WikiWriter } from "../src/wiki/writer.js";

// A canned meeting extraction: one of each meeting-relevant observation kind
// (decision / task / risk / open_question), plus the entities a meeting links to.
function meetingExtraction() {
  return {
    entities: [
      { name: "Project Orion", type: "project", aliases: ["Orion"], summary: "Search project." },
      { name: "Dana Lee", type: "person", aliases: ["Dana"], summary: "Engineer." },
      { name: "Acme Corp", type: "organisation", aliases: [], summary: "The client." },
    ],
    relationships: [{ from: "Dana Lee", to: "Project Orion", label: "works on" }],
    observations: [
      {
        entity: "Project Orion",
        claim: "The team decided to ship Project Orion in Q3.",
        kind: "decision",
        sourceQuote: "We decided to ship Orion in Q3.",
        validFrom: null,
        validUntil: null,
        confidence: 0.9,
        sensitivity: "normal",
      },
      {
        entity: "Dana Lee",
        claim: "Dana Lee will prepare the rollout plan.",
        kind: "task",
        sourceQuote: "Dana will prepare the rollout plan.",
        validFrom: null,
        validUntil: null,
        confidence: 0.8,
        sensitivity: "normal",
      },
      {
        entity: "Project Orion",
        claim: "There is a risk the migration slips past Q3.",
        kind: "risk",
        sourceQuote: "Risk: migration could slip.",
        validFrom: null,
        validUntil: null,
        confidence: 0.7,
        sensitivity: "normal",
      },
      {
        entity: "Acme Corp",
        claim: "It is unclear whether Acme Corp approved the budget.",
        kind: "open_question",
        sourceQuote: "Open question: did Acme approve the budget?",
        validFrom: null,
        validUntil: null,
        confidence: 0.6,
        sensitivity: "normal",
      },
    ],
  };
}

describe("meeting notes (#26)", () => {
  let db: MeosDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-meeting-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePipeline() {
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const llm = new StubLlmClient({
      onStructured: (request) => {
        if (request.schemaName === "knowledge_extraction") return meetingExtraction();
        throw new Error(`unexpected structured request: ${request.schemaName}`);
      },
    });
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({ store, llm, embedder, wiki });
    return { store, embedder, pipeline };
  }

  const input = {
    title: "Orion sync",
    date: "2026-03-04",
    attendees: ["Dana Lee", "Sam Patel"],
    content: "We decided to ship Orion in Q3. Dana will prepare the rollout plan.",
  };

  it("creates a meeting as a trusted, structured source", async () => {
    const { store, pipeline } = makePipeline();
    const { sourceId, outcome } = await processMeetingNote({ store, pipeline }, input);

    expect(outcome.status).toBe("done");
    // It is a meeting-typed source with fully permissive (trusted) visibility.
    expect(store.getSourceType(sourceId)).toBe("meeting");
    const vis = store.sourceVisibility(sourceId);
    expect(vis.searchable && vis.answerable && vis.wikiEligible).toBe(true);
    // Structured fields persisted.
    const note = store.getMeetingNote(sourceId);
    expect(note?.meeting_date).toBe("2026-03-04");
    expect(note?.attendees).toEqual(["Dana Lee", "Sam Patel"]);
  });

  it("extracts decisions, action items, risks, and open questions", async () => {
    const { store, pipeline } = makePipeline();
    const { sourceId } = await processMeetingNote({ store, pipeline }, input);

    const obs = store.observationsForSource(sourceId);
    const kinds = obs.map((o) => o.kind).sort();
    expect(kinds).toEqual(["decision", "open_question", "risk", "task"]);
    expect(obs.find((o) => o.kind === "decision")?.text).toContain("ship Project Orion");
    expect(obs.find((o) => o.kind === "task")?.text).toContain("rollout plan");
  });

  it("suggests links to projects / people / organisations with rationales", async () => {
    const { store, pipeline } = makePipeline();
    const { sourceId } = await processMeetingNote({ store, pipeline }, input);

    const links = store.meetingLinkSuggestions(sourceId);
    const names = links.map((l) => l.entity_name).sort();
    expect(names).toEqual(["Acme Corp", "Dana Lee", "Project Orion"]);
    for (const link of links) {
      expect(link.rationale.length).toBeGreaterThan(0);
      expect(link.status).toBe("suggested");
    }
  });

  it("reprocess opens a new revision and re-extracts", async () => {
    const { store, pipeline } = makePipeline();
    const { sourceId } = await processMeetingNote({ store, pipeline }, input);
    expect(store.revisionsForSource(sourceId)).toHaveLength(1);

    const { outcome } = await processMeetingNote({ store, pipeline }, input, sourceId);
    expect(outcome.sourceId).toBe(sourceId);
    const revs = store.revisionsForSource(sourceId);
    expect(revs).toHaveLength(2);
    expect(revs[0]!.status).toBe("superseded");
    expect(revs[1]!.status).toBe("active");
  });

  it("a user's link decision survives a reprocess", async () => {
    const { store, pipeline } = makePipeline();
    const { sourceId } = await processMeetingNote({ store, pipeline }, input);
    const link = store.meetingLinkSuggestions(sourceId).find((l) => l.entity_name === "Dana Lee")!;
    expect(store.reviewMeetingLinkSuggestion(link.id, "accepted")).toBe(true);

    await processMeetingNote({ store, pipeline }, input, sourceId);
    const after = store.meetingLinkSuggestions(sourceId).find((l) => l.entity_name === "Dana Lee")!;
    expect(after.status).toBe("accepted");
  });

  it("an answer can cite the meeting note", async () => {
    const { store, embedder, pipeline } = makePipeline();
    await processMeetingNote({ store, pipeline }, input);

    const pack = await buildContextPack(store, embedder, "What did we decide about Orion?");
    expect(pack.sources.map((s) => s.title)).toContain("Orion sync");
  });

  it("migration 26: migrates a v24-shape DB cleanly, adding meeting tables", () => {
    expect(migrations.length).toBe(30);
    const file = path.join(tmpDir, `v24-${Date.now()}.db`);
    // Stand up a DB at exactly user_version 24 (pre-meeting-notes).
    const raw = new Database(file);
    raw.pragma("foreign_keys = ON");
    for (let i = 0; i < 24; i++) raw.exec(migrations[i]!);
    raw.pragma("user_version = 24");
    // Seed a source so we prove existing data survives the upgrade.
    const sourceId = Number(
      raw.prepare("INSERT INTO sources (type, title, content) VALUES ('text','Legacy','hi')").run()
        .lastInsertRowid,
    );
    raw.close();

    // Re-open through the migrator: migration 25 applies and lands at the tip.
    const upgraded = openDatabase(file);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(migrations.length);

    const store = new KnowledgeStore(upgraded);
    // New tables exist and are usable; legacy source untouched.
    store.upsertMeetingNote({ sourceId, meetingDate: "2026-01-01", attendees: ["A"] });
    expect(store.getMeetingNote(sourceId)?.attendees).toEqual(["A"]);
    expect(store.meetingLinkSuggestions(sourceId)).toEqual([]);
    upgraded.close();
  });

  it("link suggestion resolves by alias and explains why", () => {
    const store = new KnowledgeStore(db);
    store.createEntity({ type: "project", name: "Project Orion" });
    store.addAlias(store.findEntityByName("Project Orion")!.id, "Orion");

    const links = suggestMeetingLinks(
      store,
      {
        entities: [{ name: "Orion", type: "project", aliases: [], summary: "" }],
        relationships: [],
        observations: [],
      },
      999,
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.entityName).toBe("Project Orion");
    expect(links[0]!.method).toBe("alias");
    expect(links[0]!.rationale).toMatch(/alias/i);
  });
});
