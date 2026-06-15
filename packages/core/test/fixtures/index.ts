/**
 * Shared, framework-agnostic test fixtures (#21).
 *
 * These are the reusable building blocks the test strategy is built on:
 * documents, knowledge extractions (including conflicting facts), connector
 * deltas, source revisions, and failed jobs. They are pure data plus a couple of
 * tiny factory helpers — no vitest, no I/O — so they can be imported by core unit
 * tests directly and by the server integration/e2e suite via a relative path
 * (`../../core/test/fixtures/index.js`). Keeping the canonical shapes here stops
 * suites from re-declaring the same `sampleExtraction` / source-revision setup.
 */
import { HashEmbedder } from "../../src/embedding/embedder.js";
import { StubLlmClient } from "../../src/llm/stub.js";

// ---------------------------------------------------------------------------
// Documents — raw inputs an ingest run consumes.
// ---------------------------------------------------------------------------

export interface TextDocumentFixture {
  kind: "text";
  title: string;
  text: string;
}

/** A small note that the canonical extraction (below) is written to match. */
export const adaDocument: TextDocumentFixture = {
  kind: "text",
  title: "History notes",
  text: "Notes about Ada Lovelace and the Analytical Engine.",
};

/** A second capture of the same facts — used to assert de-dup / reinforcement. */
export const adaDocumentReprise: TextDocumentFixture = {
  kind: "text",
  title: "More history notes",
  text: "Further notes: Ada Lovelace worked on the Analytical Engine.",
};

// ---------------------------------------------------------------------------
// Knowledge extractions — the structured output a real LLM would return.
// ---------------------------------------------------------------------------

/**
 * The canonical extraction for {@link adaDocument}: two entities, one
 * relationship, two observations. Matches the `knowledge_extraction` schema.
 */
export const adaExtraction = {
  entities: [
    {
      name: "Ada Lovelace",
      type: "person",
      aliases: ["Ada"],
      summary: "Mathematician collaborating on the Analytical Engine.",
    },
    {
      name: "Analytical Engine",
      type: "project",
      aliases: [],
      summary: "A proposed mechanical general-purpose computer.",
    },
  ],
  relationships: [{ from: "Ada Lovelace", to: "Analytical Engine", label: "works on" }],
  observations: [
    {
      entity: "Ada Lovelace",
      claim: "Ada Lovelace wrote the first published algorithm.",
      kind: "fact",
      sourceQuote: "Ada Lovelace wrote the first published algorithm.",
      validFrom: null,
      validUntil: null,
      confidence: 0.5,
      sensitivity: "normal",
    },
    {
      entity: "Analytical Engine",
      claim: "The Analytical Engine uses punched cards for input.",
      kind: "fact",
      sourceQuote: null,
      validFrom: null,
      validUntil: null,
      confidence: 0.5,
      sensitivity: "normal",
    },
  ],
};

/**
 * Two contradictory claims about the same subject — the raw material for merge /
 * contradiction-resolution tests. A later capture asserts the opposite of an
 * earlier one, so the merge layer has to record a contradiction rather than keep
 * both as equally-true facts.
 */
export const conflictingFacts = {
  original: {
    entity: "Ada Lovelace",
    claim: "Ada Lovelace was born in London.",
    kind: "fact" as const,
    confidence: 0.6,
  },
  contradiction: {
    entity: "Ada Lovelace",
    claim: "Ada Lovelace was born in Paris.",
    kind: "fact" as const,
    confidence: 0.6,
  },
};

// ---------------------------------------------------------------------------
// Source revisions — the versioned content a source carries over time (#16).
// ---------------------------------------------------------------------------

export interface SourceRevisionFixture {
  source: { type: string; title: string; content: string };
  revisions: Array<{ normalizedContent: string }>;
}

/**
 * A source whose first revision is later superseded by a second, leaving any
 * fact still hung off revision 1 "stale". Drives `staleBackedObservations`.
 */
export const supersededSource: SourceRevisionFixture = {
  source: { type: "text", title: "Doc", content: "body" },
  revisions: [{ normalizedContent: "v1" }, { normalizedContent: "v2" }],
};

// ---------------------------------------------------------------------------
// Connector deltas — a page of provider changes a connector run consumes.
// ---------------------------------------------------------------------------

export interface ConnectorDeltaItem {
  id: string;
  title: string;
  body: string;
}

/** A delta page with one upsert and one deletion, plus a fresh sync cursor. */
export const connectorDelta = {
  items: [
    { id: "evt-1", title: "Standup", body: "Daily standup with Ada." },
  ] as ConnectorDeltaItem[],
  deletions: ["evt-0"],
  nextSyncToken: "cursor-2",
  fullResync: false,
};

// ---------------------------------------------------------------------------
// Failed jobs — the shape used to seed a dead-lettered ingest job (#13/#18).
// ---------------------------------------------------------------------------

export const failedJob = {
  /** A single-attempt job, so the first failure dead-letters it immediately. */
  create: { kind: "file" as const, maxAttempts: 1 },
  error: "boom",
};

// ---------------------------------------------------------------------------
// Stub factory — a deterministic LLM client wired to the fixtures above.
// ---------------------------------------------------------------------------

/**
 * A {@link StubLlmClient} that returns {@link adaExtraction} for the
 * `knowledge_extraction` structured call and drives the wiki-writer agent to
 * write a deterministic page + summary into its sandbox. Mirrors the inline stub
 * that pipeline tests used to declare, so the full ingest pipeline runs offline.
 */
export function makeExtractionStub(): StubLlmClient {
  return new StubLlmClient({
    onStructured: (request) => {
      if (request.schemaName === "knowledge_extraction") return adaExtraction;
      throw new Error(`Unexpected structured request: ${request.schemaName}`);
    },
    onAgent: async (request) => {
      const relPath = request.prompt.match(/target file is "([^"]+)"/)?.[1];
      if (!relPath) throw new Error("agent prompt did not name a target file");
      await request.sandbox.writeFiles([
        { path: relPath, content: "A page about this entity, related to [[Ada Lovelace]]." },
        { path: "SUMMARY.txt", content: "A generated one-line summary." },
      ]);
      return "done";
    },
  });
}

/** A deterministic, offline embedder for retrieval tests (no native ONNX). */
export function makeEmbedder(): HashEmbedder {
  return new HashEmbedder();
}
