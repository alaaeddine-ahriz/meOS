import { connectors as connectorsSchema } from "@meos/contracts";
import type { ConnectorCatalog } from "@meos/contracts";
import { connectorRegistry } from "@meos/core";
import type { ConnectorRegistry } from "@meos/core";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { routeSchema } from "../route-schema.js";

const tags = ["connectors"];

/**
 * The connector catalog: the secret-free projection of the registry that the web
 * app reads to render every connector view. Defaults are RESOLVED here (kind logo
 * falls back to the connector logo; noun falls back to the display name; `private`
 * defaults to true) so the frontend consumes fully-populated values. This is the
 * single bridge that lets a newly-registered connector light up the UI with no
 * frontend edits.
 */
export function buildConnectorCatalog(
  registry: ConnectorRegistry = connectorRegistry,
): ConnectorCatalog {
  return {
    connectors: registry.list().map((conn) => {
      const m = conn.manifest;
      return {
        id: m.id,
        displayName: m.displayName,
        logo: m.logo,
        summary: m.summary,
        brandColor: m.brandColor,
        auth:
          m.auth.kind === "oauth2"
            ? { kind: "oauth2" as const, scopes: [...m.auth.scopes] }
            : { kind: "basic" as const, fields: m.auth.fields.map((f) => ({ ...f })) },
        kinds: m.kinds.map((k) => ({
          kind: k.kind,
          sourceType: k.sourceType,
          displayName: k.displayName,
          logo: k.logo ?? m.logo,
          noun: k.noun ?? { one: k.displayName, many: k.displayName },
          blurb: k.blurb,
          contentMode: k.contentMode,
          private: k.private !== false,
          defaultIntervalMinutes: k.defaultIntervalMinutes,
          capabilities: k.capabilities ?? {},
        })),
      };
    }),
  };
}

/**
 * `GET /api/connectors/catalog` — every registered connector, secret-free. Stable
 * across connect state (it describes what CAN be connected), so the web app can
 * fetch it once and decorate the live status/health payloads from it.
 */
export function registerConnectorCatalogRoute(app: FastifyInstance, _ctx: AppContext): void {
  app.get(
    "/api/connectors/catalog",
    {
      schema: routeSchema({
        tags,
        summary: "List every available connector (identity, kinds, capabilities, auth).",
        response: connectorsSchema.ConnectorCatalogSchema,
        // Exposed over MCP so an agent can discover what connectors exist + their capabilities.
        mcp: { expose: true, name: "connectors_catalog", safety: "read" },
      }),
    },
    async () => buildConnectorCatalog(),
  );
}
