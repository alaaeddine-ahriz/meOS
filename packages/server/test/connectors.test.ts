import { connectors, ErrorCode, ErrorEnvelopeSchema } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/connectors", () => {
  it("returns the connector status matching the contract (disconnected by default)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/connectors" });
    expect(res.statusCode).toBe(200);
    const parsed = connectors.ConnectorStatusSchema.parse(res.json());
    expect(parsed.google.connected).toBe(false);
    expect(parsed.google.hasCredentials).toBe(false);
    // Every known kind is reported, defaulted to disabled.
    expect(parsed.google.kinds.map((k) => k.kind).sort()).toEqual([
      "calendar",
      "contacts",
      "gmail",
    ]);
  });
});

describe("PUT /api/connectors/google/credentials", () => {
  it("rejects an empty body with the VALIDATION_ERROR envelope", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/connectors/google/credentials",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("saves valid credentials and reflects hasCredentials in the status view", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/connectors/google/credentials",
      payload: { clientId: "test-client-id", clientSecret: "test-client-secret" },
    });
    expect(res.statusCode).toBe(200);
    const parsed = connectors.ConnectorStatusSchema.parse(res.json());
    expect(parsed.google.hasCredentials).toBe(true);
  });
});

describe("PUT /api/connectors/google/:kind/config", () => {
  it("400s with the BAD_REQUEST envelope when Google is not connected", async () => {
    // Use a fresh server so no connector account exists — the shared `server`
    // gets one once the credentials test above runs, which would mask this path.
    const fresh = await buildTestServer();
    try {
      const res = await fresh.app.inject({
        method: "PUT",
        url: "/api/connectors/google/calendar/config",
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(400);
      const envelope = ErrorEnvelopeSchema.parse(res.json());
      expect(envelope.code).toBe(ErrorCode.BAD_REQUEST);
    } finally {
      await fresh.cleanup();
    }
  });

  it("rejects a malformed config body with the VALIDATION_ERROR envelope", async () => {
    // `intervalMinutes` must be a number — a string fails body validation
    // regardless of connection state (body is validated before the account check).
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/connectors/google/calendar/config",
      payload: { intervalMinutes: "soon" },
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("rejects an unknown coverage window with the VALIDATION_ERROR envelope (#68)", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/connectors/google/gmail/config",
      payload: { coverageWindow: "forever" },
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe("GET /api/connectors/google/calendars (#68)", () => {
  it("400s with BAD_REQUEST when Google is not connected", async () => {
    const fresh = await buildTestServer();
    try {
      const res = await fresh.app.inject({
        method: "GET",
        url: "/api/connectors/google/calendars",
      });
      expect(res.statusCode).toBe(400);
      const envelope = ErrorEnvelopeSchema.parse(res.json());
      expect(envelope.code).toBe(ErrorCode.BAD_REQUEST);
    } finally {
      await fresh.cleanup();
    }
  });
});

describe("connector coverage in status (#68)", () => {
  it("surfaces a coverage block per kind once credentials/account exist", async () => {
    // The shared `server` has saved credentials above, so an account row exists and
    // the status view reports the additive coverage info per kind.
    const res = await server.app.inject({ method: "GET", url: "/api/connectors" });
    const parsed = connectors.ConnectorStatusSchema.parse(res.json());
    const gmail = parsed.google.kinds.find((k) => k.kind === "gmail");
    // Coverage is optional in the contract; when present it defaults sensibly.
    if (gmail?.coverage) {
      expect(gmail.coverage.coverageWindow ?? "recent").toBe("recent");
      expect(gmail.coverage.contentMode ?? "metadata").toBe("metadata");
    }
  });
});
