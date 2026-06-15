import { chat, ingest, settings } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaDocument, makeExtractionStub } from "../../core/test/fixtures/index.js";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

/**
 * End-to-end smoke (#21): the core user journeys driven over real HTTP through
 * the production server (`buildServer`), against a throwaway SQLite DB and an
 * offline LLM/embedder. Each step uses `app.inject` — no socket bind, no network.
 *
 * The single deterministic ingest step swaps the context's switchable LLM to the
 * shared {@link makeExtractionStub} for the duration of the run, so the real
 * ingestion pipeline produces knowledge without reaching a model; everything
 * else (search, open-source, settings) flows through the registered routes.
 *
 * Journeys: first-run -> ingest a document -> ask a question -> open a source ->
 * save a setting.
 */
let server: TestServer;
let sourceId: number;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("e2e smoke: core journeys over HTTP", () => {
  it("first-run: the server is healthy and starts empty", async () => {
    const health = await server.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const inbox = await server.app.inject({ method: "GET", url: "/api/inbox" });
    expect(inbox.statusCode).toBe(200);
    const parsed = ingest.InboxResponse.parse(inbox.json());
    expect(parsed.items).toEqual([]);
  });

  it("ingest a document: it becomes knowledge", async () => {
    // Make extraction deterministic + offline for this one run.
    server.ctx.llm.swap(makeExtractionStub());
    const outcome = await server.ctx.pipeline.ingest(adaDocument);
    expect(outcome.status).toBe("done");
    expect(typeof outcome.sourceId).toBe("number");
    sourceId = outcome.sourceId!;

    // The entities the document yielded are now in the store.
    expect(server.ctx.store.findEntityByName("Ada Lovelace")).toBeTruthy();
  });

  it("ask a question: retrieval surfaces the ingested entity", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/search",
      query: { q: "Ada Lovelace" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entities: Array<{ name: string }> };
    expect(body.entities.map((e) => e.name)).toContain("Ada Lovelace");
  });

  it("open a source: its diff/detail is retrievable", async () => {
    const res = await server.app.inject({ method: "GET", url: `/api/sources/${sourceId}/diff` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { source: { id: number }; commits: unknown[] };
    expect(body.source.id).toBe(sourceId);
    expect(Array.isArray(body.commits)).toBe(true);
  });

  it("save a setting: an LLM provider update round-trips", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/settings/llm",
      payload: { provider: "local", model: "smoke-model", baseUrl: "http://localhost:1234/v1" },
    });
    expect(res.statusCode).toBe(200);
    const parsed = settings.LlmSettingsSchema.parse(res.json());
    expect(parsed.provider).toBe("local");
    expect(parsed.providers.local.model).toBe("smoke-model");

    // Persisted: a fresh read returns the saved value.
    const read = await server.app.inject({ method: "GET", url: "/api/settings/llm" });
    expect(settings.LlmSettingsSchema.parse(read.json()).providers.local.model).toBe("smoke-model");
  });

  it("conversations: a chat session can be created and listed", async () => {
    const created = await server.app.inject({ method: "POST", url: "/api/conversations" });
    expect(created.statusCode).toBe(201);
    const { id } = chat.CreateConversationResponse.parse(created.json());

    const list = await server.app.inject({ method: "GET", url: "/api/conversations" });
    const parsed = chat.ListConversationsResponse.parse(list.json());
    expect(parsed.conversations.some((c) => c.id === id)).toBe(true);
  });
});
