import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/openapi.json — contract smoke test", () => {
  it("serves a valid OpenAPI 3 document with the shared ErrorEnvelope component", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      openapi: string;
      info: unknown;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };

    // A well-formed OpenAPI 3 document.
    expect(body.openapi.startsWith("3.")).toBe(true);
    expect(body.info).toBeDefined();
    expect(body.paths).toBeDefined();

    // The shared error envelope is registered as a reusable component.
    expect(body.components.schemas.ErrorEnvelope).toBeDefined();

    // A representative set of static routes is documented.
    const paths = Object.keys(body.paths);
    for (const expected of [
      "/api/wiki",
      "/api/meetings",
      "/api/connectors",
      "/api/settings/llm",
      "/api/ingest/jobs",
    ]) {
      expect(paths).toContain(expected);
    }

    // At least one route references the ErrorEnvelope component (beyond its own
    // component definition), proving error responses are documented against it.
    const occurrences = JSON.stringify(body).split("ErrorEnvelope").length - 1;
    expect(occurrences).toBeGreaterThan(1);
  });
});
