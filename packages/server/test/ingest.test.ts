import { ErrorCode, ErrorEnvelopeSchema, ingest } from "@meos/contracts";
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
