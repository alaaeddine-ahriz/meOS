---
name: new-connector
description: "Use when adding a new external integration (connector) to meOS — Notion, IMAP, Slack, a local folder, any provider. A step-by-step runbook for AI agents to author a connector: scaffold it, fill the manifest + fetchDelta + auth, optionally add chat-agent tools, drop in a logo, and verify. Trigger: /new-connector."
---

# /new-connector — add a meOS connector

A **connector** is meOS's plugin for an external integration. You declare it once
in a manifest; the platform derives everything else — the settings UI, the health
dashboard, the sources tab, source chips, the chat agent's tools, the privacy
defaults, and the sync schedule — from that manifest. **You never edit a view, a
route, or an enum.** The only hand-made frontend artifact is the brand SVG.

This file is the runbook. Follow the steps in order; each ends with a check.

## TL;DR

```sh
pnpm connector:new notion          # scaffold folder + register it + stub a logo
```

Then in `packages/core/src/connectors/notion/connector.ts`:

1. Fill the **manifest** (identity, kinds, capabilities, auth).
2. Implement **`fetchDelta`** — pull a delta, normalize each item.
3. Wire **auth** — an `OAuthProvider` (oauth2) or declare `fields` (basic).
4. *(optional)* add **`agentTools()` + `promptHint`** for the chat agent.
5. Replace the placeholder SVG in `LOGO_REGISTRY` (`brand-logos.tsx`).

Verify with the commands in [Verify](#verify). Done — it now appears everywhere.

---

## Orientation (read these first)

| File | What it is |
| --- | --- |
| `packages/core/src/connectors/framework.ts` | The `Connector` contract + every manifest type. The source of truth for the shapes below. |
| `packages/core/src/connectors/google/connector.ts` | The reference implementation. Copy its patterns. |
| `packages/core/src/connectors/template.connector.ts` | The annotated skeleton the scaffolder copies. |
| `packages/core/src/connectors/registry.ts` | `connectorRegistry` — where connectors register. |
| `packages/web/src/components/brand-logos.tsx` | `LOGO_REGISTRY` — the one frontend artifact you add. |
| `docs/connectors.md`, `packages/core/src/connectors/README.md` | Prose background. |

If `graphify-out/` exists, run `graphify explain "connector framework"` to orient
before reading source.

---

## Step 1 — Scaffold

```sh
pnpm connector:new <id>     # id is lowercase, e.g. notion, my-imap
```

This:
- creates `packages/core/src/connectors/<id>/connector.ts` from the template,
- adds it to `connectorRegistry` in `registry.ts`,
- stubs a `<id>` entry + placeholder component in the web `LOGO_REGISTRY`.

**Check:** `git status` shows the new connector file + edits to `registry.ts` and
`brand-logos.tsx`.

---

## Step 2 — The manifest (the contract)

Every field below propagates to a real surface. Fill them all — a missing one
degrades the UI (the manifest-hygiene test in `connectors.test.ts` flags incomplete
or duplicate metadata).

```ts
export const NOTION_MANIFEST: ConnectorManifest = {
  id: "notion",                 // stable provider id; keys the registry + account row
  displayName: "Notion",        // shown in Settings / Health headers
  logo: "notion",               // → LOGO_REGISTRY key (Step 5)
  summary: "Index your Notion pages.",  // settings card + empty-state copy
  brandColor: "#000000",        // optional accent
  auth: { kind: "oauth2", scopes: ["read"] },   // see Step 3
  kinds: [
    {
      kind: "pages",                    // stable id, unique within the connector
      displayName: "Pages",
      sourceType: "notion:pages",       // "<provider>:<kind>" — source chip + privacy key
      contentMode: "document",          // "metadata" (light) | "document" (rich)
      defaultIntervalMinutes: 30,
      logo: "notion",                   // chip logo id; falls back to the connector logo
      noun: { one: "page", many: "pages" },   // Sources grouping ("3 pages")
      blurb: "Your Notion pages, indexed as documents.",
      private: true,                    // DEFAULT. true = off the wiki + off sync/export
      capabilities: { /* coverageWindow?, labelFilters?, subResources?, writeable? */ },
    },
  ],
};
```

**`capabilities` light up settings controls without naming the kind** (no
`kind === "gmail"` branches anywhere):
- `coverageWindow: true` → a "how far back to index" selector.
- `labelFilters: true` → include/exclude label inputs.
- `subResources: "calendars"` (or any name) → a picker fed by `listCalendars?()`.
- `writeable: true` → the kind supports create/write (agent + UI).

**`sourceType` must be `"<provider>:<kind>"` and globally unique.** It is the single
key for the source chip *and* the privacy default — there is no separate list to
maintain.

**Check:** `pnpm --filter @meos/core build` compiles.

---

## Step 3 — Auth

### OAuth2 (Google, Notion, Slack…)
Provide an `OAuthProvider` (see `google/oauth.ts` for loopback + PKCE):

```ts
const oauth: OAuthProvider = {
  scopes: ["read"],
  buildAuthUrl: ({ clientId, redirectUri, challenge, state }) => "https://…",
  exchangeCode: async ({ clientId, clientSecret, code, verifier, redirectUri }) => ({ accessToken, refreshToken, expiry, scopes }),
  refreshAccessToken: async ({ clientId, clientSecret, refreshToken }) => ({ accessToken, expiry }),
  revokeToken: async (token) => { /* best-effort; never throw */ },
};
// class member:  readonly oauth = oauth;
```
The routes + settings UI drive this generically. Tokens are stored in
`connector_accounts` and refreshed automatically via `ensureAccessToken`.

### Basic credentials (IMAP, a local server…)
Declare the form instead, and OMIT the `oauth` member:

```ts
auth: { kind: "basic", fields: [
  { key: "host", label: "Host", type: "text", required: true },
  { key: "username", label: "Username", type: "text", required: true },
  { key: "password", label: "Password", type: "password", required: true },
] }
```
The settings UI renders the form from `fields`. **Note:** basic-auth credential
persistence + sync is a guarded TODO in `server/routes/connectors.ts` today — wire
it there if you ship the first basic-auth connector.

---

## Step 4 — `fetchDelta` (normalize items)

Pull changed items since `cursor` (null = initial full pull) and turn each into a
`NormalizedItem`. The orchestrator handles dedup, persistence, materialization, and
the schedule — you only fetch + normalize.

```ts
async fetchDelta(ctx: SyncContext, kind: string, cursor: string | null): Promise<NormalizedDelta> {
  const page = await callProvider(ctx.accessToken, cursor, ctx.config);
  return {
    items: page.changed.map((r): NormalizedItem => ({
      externalId: r.id,                       // stable ledger key (for dedup + revisions)
      title: r.title,
      path: `https://notion.so/${r.id}`,      // deep link back to the item
      rawContent: JSON.stringify(r, null, 2), // verbatim payload (reprocess without re-fetch)
      normalizedContent: `Page: ${r.title}\n${r.text}`,  // terse, label-led text that gets indexed
      extraction: mapNotionPage(r),           // deterministic Extraction (see map/helpers.ts)
    })),
    deletions: page.removedIds,               // external ids gone upstream (soft-deleted locally)
    nextCursor: page.cursor,                  // persisted for the next run
    // fullResync: true   → when the saved cursor expired; orchestrator clears it + re-pulls
    // hasMore: true      → a backfill page remains; the orchestrator re-enqueues
    // nextConfig: {...}   → persist updated per-kind config (backfill cursor, etc.)
  };
}
```

`extraction` is an `Extraction` (`{ entities, relationships, observations }`). Build
it from a **deterministic** mapper — see `connectors/map/helpers.ts` and the Google
mappers in `connectors/map/`. Keep `normalizedContent` terse and label-led so it's
searchable by the phrases a user would type.

**Check:** `pnpm --filter @meos/core test` (the connector + visibility suites pass).

---

## Step 5 — Agent tools (optional)

Give the chat agent tools that use the connected account. They auto-register when
the account is connected — no edit to the chat route or tool factory.

```ts
agentTools(ctx: AgentToolContext): ToolSet {
  if (!ctx.enabledKinds.has("pages")) return {};   // gate on a synced kind, if you like
  return {
    search_notion: tool({
      description: "Search the user's Notion pages for a query.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const token = await ctx.getAccessToken();   // LAZY — minted only when the tool runs
        return searchNotion(token, query);
      },
    }),
  };
}
readonly promptHint = "search_notion: search the user's Notion pages; cite what you find.";
```

`AgentToolContext` gives you `{ store, embedder, enabledKinds, getAccessToken() }`.
`getAccessToken` is lazy on purpose — building the tool costs no network. The
`promptHint` is appended to the system prompt only when the connector is connected.
(Reference: `fetch_email_threads` in `google/connector.ts`.)

---

## Step 6 — The logo

The brand SVG is the one irreducible frontend artifact (it's a React component, so
it can't live in `core`). The scaffolder stubbed a placeholder — replace it:

In `packages/web/src/components/brand-logos.tsx`, swap the generated
`<Id>Logo` component's body for the real multicolor SVG, keyed under your manifest
`logo` id in `LOGO_REGISTRY`. Unknown ids fall back to a generic plug, so the app
never breaks if you defer this — but ship the real SVG for polish.

---

## Verify

```sh
pnpm --filter @meos/core build           # connector compiles + registered
pnpm --filter @meos/web typecheck        # logo + catalog consumption typecheck
pnpm --filter @meos/core exec vitest run test/connectors.test.ts   # manifest hygiene + mappers
pnpm --filter @meos/server exec vitest run test/connectors.test.ts # catalog projection
```

Confirm it reached the catalog (the bridge to every view):
```sh
pnpm --filter @meos/server build
node -e "import('./packages/server/dist/routes/connector-catalog.js').then(m=>console.log(m.buildConnectorCatalog().connectors.map(c=>c.id)))"
# → your connector id appears in the list
```

Finally: `pnpm -r typecheck && pnpm test && pnpm lint && pnpm boundaries`, then
`graphify update .` to refresh the code graph.

---

## What you get for free (do NOT hand-wire these)

Once registered, the platform derives all of this from the manifest:
- **Catalog** (`GET /api/connectors/catalog`) → the web app learns the connector.
- **Settings** card, connect flow, per-kind controls (from `capabilities`).
- **Health** dashboard account block + per-kind health.
- **Sources** tab grouping (from `noun`) + **source chips** (from `sourceType` + `logo`).
- **Privacy defaults** — `register()` injects each `private` kind's `sourceType` into
  `knowledge/visibility.ts` (off-wiki, off-sync, off-export). No list to maintain.
- **Sync schedule** + incremental cursors + content-hash dedup.
- **Routes** `/api/connectors/:provider/...` and the multi-provider status/health shapes.

If you find yourself editing a view, a route, an enum, or `knowledge/visibility.ts`
to make a connector appear — stop; the manifest already drives it.

## Gotchas

- **Don't** add a `kind` to a contracts enum or a frontend map — those are gone; the
  catalog is the source of truth.
- **Don't** resolve the access token eagerly in `agentTools` — use the lazy
  `ctx.getAccessToken()` so a connected-but-unused connector adds no per-turn latency.
- `connector_accounts` is `UNIQUE(provider)` — one account per provider today.
- Keep `fetchDelta` **stateless**: never touch the DB, the schedule, or the
  materialization seam. Return `nextConfig` to persist per-kind state instead.
- A non-OAuth connector must omit `oauth` and use `auth.kind: "basic"`; calling the
  OAuth routes for it returns a clear error until basic-auth persistence is wired.
