import { ErrorCode, ErrorEnvelopeSchema, ingest, staleFacts } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/inbox", () => {
  it("returns the inbox matching the contract (empty on a fresh DB)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/inbox" });
    expect(res.statusCode).toBe(200);
    const parsed = ingest.InboxResponse.parse(res.json());
    expect(parsed.items).toEqual([]);
    expect(typeof parsed.queuePending).toBe("number");
  });
});

describe("POST /api/ingest/upload", () => {
  it("400s with the BAD_REQUEST envelope when no files are sent", async () => {
    // A multipart request with no file parts is a bad upload request.
    const res = await server.app.inject({
      method: "POST",
      url: "/api/ingest/upload",
      headers: { "content-type": "multipart/form-data; boundary=----meostest" },
      payload: "------meostest--\r\n",
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.BAD_REQUEST);
  });
});

describe("GET /api/sources/:id/diff", () => {
  it("404s with the NOT_FOUND envelope for an unknown source id", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/sources/999999/diff" });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("400s with the VALIDATION_ERROR envelope for a non-numeric source id", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/sources/not-a-number/diff" });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe("GET /api/facts/stale", () => {
  it("returns facts backed only by an obsolete source revision (#16)", async () => {
    const { store } = server.ctx;
    // Seed a source whose revision is then superseded, leaving its fact stale.
    const sourceId = store.createSource({ type: "text", title: "Doc", content: "body" });
    const rev1 = store.createSourceRevision({ sourceId, normalizedContent: "v1" });
    const entity = store.createEntity({ type: "person", name: "Grace Hopper" });
    store.insertObservation({
      entityId: entity.id,
      text: "Grace Hopper coined the term debugging.",
      sourceId,
      sourceRevisionId: rev1,
    });
    // A second revision supersedes the first; the fact now hangs off rev1.
    store.createSourceRevision({ sourceId, normalizedContent: "v2" });

    const res = await server.app.inject({ method: "GET", url: "/api/facts/stale" });
    expect(res.statusCode).toBe(200);
    const parsed = staleFacts.StaleFactsResponse.parse(res.json());
    const hit = parsed.facts.find((f) => f.entityName === "Grace Hopper");
    expect(hit).toBeDefined();
    expect(hit!.status).toBe("superseded");
    expect(hit!.text).toContain("debugging");
  });
});
