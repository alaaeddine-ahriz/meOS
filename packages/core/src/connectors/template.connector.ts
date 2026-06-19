/**
 * Connector authoring template (#5). The fastest path is `pnpm connector:new <id>`,
 * which copies this file into `connectors/<id>/connector.ts`, registers it, and
 * stubs a logo. Or copy it by hand and fill in the five marked spots. It compiles
 * as-is so you can see the exact shapes the framework expects; it is intentionally
 * NOT registered in `registry.ts` — register your real one.
 *
 * Once registered, the connector appears AUTOMATICALLY in every view (Health,
 * Settings, Sources, source chips), gets the right privacy defaults, and exposes
 * its agent tools — all driven from the manifest below. The only frontend artifact
 * you add by hand is the brand SVG in `packages/web/src/components/brand-logos.tsx`
 * (`LOGO_REGISTRY`), keyed by the `logo` id you choose here.
 *
 * See `connectors/README.md` for the full lifecycle. The reference implementation
 * is `google/connector.ts`.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Extraction } from "../extract/schema.js";
import type { OAuthTokens } from "./types.js";
import type {
  AgentToolContext,
  Connector,
  ConnectorManifest,
  NormalizedDelta,
  NormalizedItem,
  OAuthProvider,
  SyncContext,
} from "./framework.js";

// (1) MANIFEST — who this connector is, how it looks, and the kinds it syncs. Every
// field below propagates to the UI/catalog automatically. `sourceType` drives the
// per-type visibility defaults (knowledge/visibility.ts) and the source chip; `logo`
// ids resolve to SVGs in the web LOGO_REGISTRY.
export const TEMPLATE_MANIFEST: ConnectorManifest = {
  id: "example",
  displayName: "Example",
  logo: "example", // add an `example` entry to the web LOGO_REGISTRY
  summary: "Index your notes from Example.",
  brandColor: "#6b7280",
  // OAuth2 today. For a credential-based service (e.g. IMAP) declare instead:
  //   auth: { kind: "basic", fields: [
  //     { key: "host", label: "Host", type: "text", required: true },
  //     { key: "username", label: "Username", type: "text", required: true },
  //     { key: "password", label: "Password", type: "password", required: true },
  //   ] }
  // and omit the `oauth` member below.
  auth: { kind: "oauth2", scopes: ["read"] },
  kinds: [
    {
      kind: "notes",
      displayName: "Notes",
      sourceType: "example:notes",
      // "metadata" for lightweight items, "document" for richer document-like ones.
      contentMode: "document",
      defaultIntervalMinutes: 30,
      noun: { one: "note", many: "notes" },
      blurb: "Your notes, indexed as documents.",
      // `private` defaults to true (kept off the wiki + off sync/export). Set false
      // for freely-shareable data. `capabilities` light up settings controls:
      //   capabilities: { coverageWindow: true, writeable: true },
    },
  ],
};

// (2) OAUTH — the connect/refresh/revoke surface. Wrap your provider's OAuth client
// here (loopback + PKCE, like google/oauth.ts). Stubbed so this compiles. Omit this
// whole member for a basic-auth connector.
const oauth: OAuthProvider = {
  scopes: ["read"],
  buildAuthUrl: () => {
    throw new Error("Not implemented: build the provider's consent URL");
  },
  exchangeCode: async (): Promise<OAuthTokens> => {
    throw new Error("Not implemented: exchange the auth code for tokens");
  },
  refreshAccessToken: async (): Promise<OAuthTokens> => {
    throw new Error("Not implemented: mint a fresh access token");
  },
  revokeToken: async () => {
    /* best-effort; must not throw */
  },
};

// (3) NORMALIZE — turn one raw provider record into the local item the pipeline
// materializes: raw payload verbatim, terse label-led text, and a deterministic
// extraction (use map/helpers.ts: personEntity/observation). Build a real mapper.
function normalizeRecord(record: { id: string; title: string; body: string }): NormalizedItem {
  const extraction: Extraction = { entities: [], relationships: [], observations: [] };
  return {
    externalId: record.id,
    title: record.title,
    path: `https://example.com/notes/${record.id}`,
    rawContent: JSON.stringify(record, null, 2),
    normalizedContent: `Note: ${record.title}\n${record.body}`,
    extraction,
  };
}

export class ExampleConnector implements Connector {
  readonly manifest = TEMPLATE_MANIFEST;
  readonly oauth = oauth;

  /**
   * (5) AGENT TOOLS — optional. The tools the chat agent gains when this account is
   * connected; the server resolves a live `accessToken` and merges them into the
   * toolset per turn. Return an empty object (or omit the method) for none.
   */
  agentTools(ctx: AgentToolContext): ToolSet {
    return {
      example_search: tool({
        description: "Search the user's Example notes for a query.",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          void ctx.accessToken; // call your provider API with the live token
          return `No Example results for "${query}" (template).`;
        },
      }),
    };
  }

  /** A one-line hint appended to the chat system prompt when connected. */
  readonly promptHint = "Use example_search to look through the user's Example notes.";

  // (4) FETCH DELTA — call your API with the saved cursor (null = initial pull),
  // normalize each changed record, collect deletions, and return the next cursor.
  // Signal a stale cursor with `fullResync: true` so the orchestrator re-pulls.
  async fetchDelta(
    _ctx: SyncContext,
    _kind: string,
    _cursor: string | null,
  ): Promise<NormalizedDelta> {
    const changedRecords: Array<{ id: string; title: string; body: string }> = [];
    return {
      items: changedRecords.map(normalizeRecord),
      deletions: [],
      nextCursor: null,
    };
  }
}
