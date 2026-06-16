/**
 * Connector authoring template (#5). Copy this into
 * `connectors/<provider>/connector.ts`, rename, and fill in the four marked
 * spots. It compiles as-is so you can see the exact shapes the framework expects;
 * it is intentionally NOT registered in `registry.ts` — register your real one.
 *
 * See `connectors/README.md` for the full lifecycle and the visibility-defaults
 * note. The reference implementation is `google/connector.ts`.
 */

import type { Extraction } from "../extract/schema.js";
import type { OAuthTokens } from "./types.js";
import type {
  Connector,
  ConnectorManifest,
  NormalizedDelta,
  NormalizedItem,
  OAuthProvider,
  SyncContext,
} from "./framework.js";

// (1) MANIFEST — who this connector is and the kinds it syncs. Each `sourceType`
// drives the per-type visibility defaults (knowledge/visibility.ts) and the chip.
export const TEMPLATE_MANIFEST: ConnectorManifest = {
  id: "example",
  displayName: "Example",
  auth: { kind: "oauth2", scopes: ["read"] },
  kinds: [
    {
      kind: "notes",
      displayName: "Notes",
      sourceType: "example:notes",
      // "metadata" for lightweight items, "document" for richer document-like ones.
      contentMode: "document",
      defaultIntervalMinutes: 30,
    },
  ],
};

// (2) OAUTH — the connect/refresh/revoke surface. Wrap your provider's OAuth
// client here (loopback + PKCE, like google/oauth.ts). Stubbed so this compiles.
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
