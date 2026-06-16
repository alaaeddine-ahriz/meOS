import { ErrorCode, ErrorEnvelopeSchema, vault } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/vault", () => {
  it("returns the note list matching the contract (empty on a fresh DB)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/vault" });
    expect(res.statusCode).toBe(200);
    const parsed = vault.ListNotesResponse.parse(res.json());
    expect(parsed.notes).toEqual([]);
  });
});

describe("POST /api/vault/note", () => {
  it("creates a note and returns metadata matching the contract (201)", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/vault/note",
      payload: { path: "test-note.md" },
    });
    expect(res.statusCode).toBe(201);
    const parsed = vault.NoteMetaSchema.parse(res.json());
    expect(parsed.path).toBe("test-note.md");
  });

  it("rejects a missing path with the VALIDATION_ERROR envelope", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/vault/note",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe("GET /api/vault/note", () => {
  it("404s with the NOT_FOUND envelope for a missing note", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/vault/note?path=does-not-exist.md",
    });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });
});
