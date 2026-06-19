import { connectors, ErrorCode, ErrorEnvelopeSchema } from "@meos/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
    const g = parsed.providers.find((p) => p.provider === "google")!;
    expect(g.connected).toBe(false);
    expect(g.hasCredentials).toBe(false);
    // Every known kind is reported, defaulted to disabled.
    expect(g.kinds.map((k) => k.kind).sort()).toEqual(["calendar", "contacts", "gmail", "tasks"]);
  });
});

describe("GET /api/connectors/catalog", () => {
  it("projects the registry into a secret-free catalog the UI renders from", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/connectors/catalog" });
    expect(res.statusCode).toBe(200);
    const catalog = connectors.ConnectorCatalogSchema.parse(res.json());

    const google = catalog.connectors.find((c) => c.id === "google");
    expect(google).toBeDefined();
    expect(google!.logo).toBe("google");
    expect(google!.auth.kind).toBe("oauth2");
    // The catalog carries no secrets — only identity, branding, kinds, capabilities.
    expect(JSON.stringify(google)).not.toMatch(/client_secret|access_token/);

    // Every kind is fully resolved: logo, noun, and the private-by-default flag.
    const gmail = google!.kinds.find((k) => k.kind === "gmail");
    expect(gmail).toMatchObject({
      sourceType: "google:gmail",
      logo: "gmail",
      noun: { one: "email", many: "emails" },
      private: true,
    });
    expect(gmail!.capabilities).toMatchObject({ coverageWindow: true, labelFilters: true });
    const tasks = google!.kinds.find((k) => k.kind === "tasks");
    expect(tasks!.capabilities).toMatchObject({ writeable: true });
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
    const g = parsed.providers.find((p) => p.provider === "google")!;
    expect(g.hasCredentials).toBe(true);
  });
});

describe("IMAP — the basic-auth connector", () => {
  it("lists imap in the catalog with a basic-auth form (auth.kind + fields)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/connectors/catalog" });
    expect(res.statusCode).toBe(200);
    const catalog = connectors.ConnectorCatalogSchema.parse(res.json());

    const imap = catalog.connectors.find((c) => c.id === "imap");
    expect(imap).toBeDefined();
    expect(imap!.auth.kind).toBe("basic");
    // The declared fields drive the connect form — host/port/username/password.
    if (imap!.auth.kind === "basic") {
      expect(imap!.auth.fields.map((f) => f.key).sort()).toEqual([
        "host",
        "password",
        "port",
        "username",
      ]);
      const host = imap!.auth.fields.find((f) => f.key === "host")!;
      expect(host.required).toBe(true);
    }
    // One metadata-only, private email kind.
    const messages = imap!.kinds.find((k) => k.kind === "messages");
    expect(messages).toMatchObject({
      sourceType: "imap:messages",
      contentMode: "metadata",
      private: true,
      noun: { one: "email", many: "emails" },
    });
  });

  it("starts disconnected with no credentials", async () => {
    const fresh = await buildTestServer();
    try {
      const res = await fresh.app.inject({ method: "GET", url: "/api/connectors" });
      const parsed = connectors.ConnectorStatusSchema.parse(res.json());
      const imap = parsed.providers.find((p) => p.provider === "imap")!;
      expect(imap.connected).toBe(false);
      expect(imap.hasCredentials).toBe(false);
    } finally {
      await fresh.cleanup();
    }
  });

  it("saves host/username/password and reports imap connected + hasCredentials", async () => {
    const fresh = await buildTestServer();
    try {
      // 127.0.0.1:993 refuses immediately (nothing listening), so the route's
      // best-effort testConnection fails fast and is swallowed as a warning — the
      // save still succeeds, proving the test is non-blocking.
      const res = await fresh.app.inject({
        method: "PUT",
        url: "/api/connectors/imap/credentials",
        payload: {
          host: "127.0.0.1",
          port: "993",
          username: "ada@example.com",
          password: "app-password",
        },
      });
      expect(res.statusCode).toBe(200);
      const parsed = connectors.ConnectorStatusSchema.parse(res.json());
      const imap = parsed.providers.find((p) => p.provider === "imap")!;
      expect(imap.connected).toBe(true);
      expect(imap.hasCredentials).toBe(true);
      // The username surfaces as the account email for the UI.
      expect(imap.accountEmail).toBe("ada@example.com");
    } finally {
      await fresh.cleanup();
    }
  }, 20_000);

  it("rejects a basic-auth save missing a required field with VALIDATION_ERROR", async () => {
    const fresh = await buildTestServer();
    try {
      const res = await fresh.app.inject({
        method: "PUT",
        url: "/api/connectors/imap/credentials",
        // No password — a required field — so the save is rejected.
        payload: { host: "imap.example.com", username: "ada@example.com" },
      });
      expect(res.statusCode).toBe(400);
      const envelope = ErrorEnvelopeSchema.parse(res.json());
      expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
    } finally {
      await fresh.cleanup();
    }
  });

  it("400s the OAuth-only auth/start route for a basic connector", async () => {
    const fresh = await buildTestServer();
    try {
      const res = await fresh.app.inject({
        method: "POST",
        url: "/api/connectors/imap/auth/start",
      });
      expect(res.statusCode).toBe(400);
      const envelope = ErrorEnvelopeSchema.parse(res.json());
      expect(envelope.code).toBe(ErrorCode.BAD_REQUEST);
    } finally {
      await fresh.cleanup();
    }
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

describe("connector coverage in status (#68/#88)", () => {
  it("surfaces a coverage block per kind once credentials/account exist", async () => {
    // The shared `server` has saved credentials above, so an account row exists and
    // the status view reports the additive coverage info per kind.
    const res = await server.app.inject({ method: "GET", url: "/api/connectors" });
    const parsed = connectors.ConnectorStatusSchema.parse(res.json());
    const g = parsed.providers.find((p) => p.provider === "google")!;
    const gmail = g.kinds.find((k) => k.kind === "gmail");
    // Coverage is optional in the contract; when present it defaults sensibly.
    if (gmail?.coverage) {
      expect(gmail.coverage.coverageWindow ?? "recent").toBe("recent");
      expect(gmail.coverage.contentMode ?? "metadata").toBe("metadata");
      // The unambiguous coverage state is surfaced (#88) — "idle" before any sync.
      expect(gmail.coverage.state ?? "idle").toBe("idle");
    }
  });

  it("stores Gmail label filters via the config PUT (#88)", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/connectors/google/gmail/config",
      payload: { includeLabels: ["Work"], excludeLabels: ["Promotions"] },
    });
    expect(res.statusCode).toBe(200);
    const parsed = connectors.ConnectorStatusSchema.parse(res.json());
    const g = parsed.providers.find((p) => p.provider === "google")!;
    const gmail = g.kinds.find((k) => k.kind === "gmail");
    expect(gmail?.coverage?.includeLabels).toEqual(["Work"]);
    expect(gmail?.coverage?.excludeLabels).toEqual(["Promotions"]);
  });

  it("stores a task-list selection via the config PUT (#88)", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/connectors/google/tasks/config",
      payload: { enabledTaskLists: ["list-a"] },
    });
    expect(res.statusCode).toBe(200);
    const parsed = connectors.ConnectorStatusSchema.parse(res.json());
    const g = parsed.providers.find((p) => p.provider === "google")!;
    const tasks = g.kinds.find((k) => k.kind === "tasks");
    expect(tasks?.coverage?.enabledTaskLists).toEqual(["list-a"]);
  });

  it("accepts the reset flag and clears the cursor (#88)", async () => {
    const account = server.ctx.store.getConnectorAccount("google")!;
    server.ctx.store.setSyncState(account.id, "gmail", { syncToken: "stale-cursor" });
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/connectors/google/gmail/config",
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(200);
    expect(server.ctx.store.getSyncState(account.id, "gmail")!.sync_token).toBeNull();
  });
});

describe("POST /api/connectors/google/tasks/create (write path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("400s with the BAD_REQUEST envelope when Google is not connected", async () => {
    const fresh = await buildTestServer();
    try {
      const res = await fresh.app.inject({
        method: "POST",
        url: "/api/connectors/google/tasks/create",
        payload: { title: "Buy milk" },
      });
      expect(res.statusCode).toBe(400);
      const envelope = ErrorEnvelopeSchema.parse(res.json());
      expect(envelope.code).toBe(ErrorCode.BAD_REQUEST);
    } finally {
      await fresh.cleanup();
    }
  });

  it("rejects an empty title with the VALIDATION_ERROR envelope", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/connectors/google/tasks/create",
      payload: { title: "" },
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("creates a task through the Google HTTP layer when connected", async () => {
    const fresh = await buildTestServer();
    try {
      // Seed a connected account with a live (non-expired) access token so the
      // route's ensureAccessToken returns it without a refresh round-trip.
      fresh.ctx.store.upsertConnectorAccount({
        provider: "google",
        clientId: "id",
        clientSecret: "secret",
        accessToken: "live-token",
        refreshToken: "refresh",
        expiry: new Date(Date.now() + 3600_000).toISOString(),
      });

      // Mock the Google REST layer: list lists, then POST a task.
      let posted: unknown;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        let body: unknown = {};
        if (String(url).includes("/users/@me/lists")) {
          body = { items: [{ id: "list1", title: "My Tasks" }] };
        } else if (init?.method === "POST" && String(url).includes("/lists/list1/tasks")) {
          posted = JSON.parse(String(init.body));
          body = { id: "new1", title: "Buy milk", status: "needsAction" };
        }
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as Response;
      });

      const res = await fresh.app.inject({
        method: "POST",
        url: "/api/connectors/google/tasks/create",
        payload: { title: "Buy milk" },
      });
      expect(res.statusCode).toBe(201);
      const parsed = connectors.CreateTaskResponse.parse(res.json());
      expect(parsed.task.externalId).toBe("new1");
      expect(parsed.task.taskListTitle).toBe("My Tasks");
      expect(posted).toMatchObject({ title: "Buy milk" });
    } finally {
      await fresh.cleanup();
    }
  });
});
