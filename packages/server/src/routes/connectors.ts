import { connectors as connectorsSchema } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import { connectorRegistry, createPkcePair, fetchSelf } from "@meos/core";
import type { ConnectorKindConfig } from "@meos/core";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["connectors"];

// The Google connector drives this route's auth flow, kinds, and validation —
// the framework owns "what Google is", the route owns the HTTP surface (#5).
const google = connectorRegistry.require("google");
const KINDS: string[] = google.manifest.kinds.map((k) => k.kind);

/**
 * Google connector setup + control. OAuth is loopback + PKCE for an installed
 * "Desktop app" client whose credentials the user pastes in Settings. The
 * one-time PKCE verifier is held in memory keyed by the OAuth `state` (no session
 * plugin needed); tokens are exchanged on the loopback callback and stored in the
 * DB. Tokens are never returned to the client — only connection status.
 */
export function registerConnectorRoutes(app: FastifyInstance, ctx: AppContext): void {
  // state → PKCE verifier, awaiting the callback. Short-lived, single-use.
  const pending = new Map<string, string>();
  const redirectUri = `http://127.0.0.1:${ctx.config.server.port}/api/connectors/google/callback`;

  const statusView = () => {
    const account = ctx.store.getConnectorAccount("google");
    const connected = Boolean(account?.refresh_token || account?.access_token);
    const kinds = google.manifest.kinds.map((manifest) => {
      const kind = manifest.kind;
      const state = account ? ctx.store.getSyncState(account.id, kind) : undefined;
      return {
        kind,
        enabled: state?.enabled === 1,
        intervalMinutes: state?.interval_minutes ?? manifest.defaultIntervalMinutes,
        lastSyncedAt: state?.last_synced_at ?? null,
        lastStatus: state?.last_status ?? null,
        coverage: account ? coverageFor(account.id, kind) : undefined,
      };
    });
    return {
      google: {
        connected,
        accountEmail: account?.account_email ?? null,
        hasCredentials: Boolean(account?.client_id && account?.client_secret),
        kinds,
      },
    };
  };

  /**
   * Build the additive coverage block (#68) for a kind: indexed item count + oldest
   * indexed date from the ledger, the chosen window/content mode, Gmail backfill
   * progress, and per-calendar selection + progress. Makes partial coverage
   * explicit in the status payload so the UI can surface it.
   */
  const coverageFor = (accountId: number, kind: string) => {
    const config = ctx.store.getSyncConfig(accountId, kind);
    const stats = ctx.store.connectorCoverageStats(accountId, kind);
    const base = {
      itemCount: stats.itemCount,
      oldestIndexed: stats.oldestIndexed,
      coverageWindow: config.coverageWindow ?? "recent",
    } as Record<string, unknown>;
    if (kind === "gmail") {
      base.contentMode = config.contentMode ?? "metadata";
      if (config.backfill) {
        base.backfill = {
          indexed: config.backfill.indexed,
          oldestIndexed: config.backfill.oldestIndexed,
          complete: config.backfill.complete,
        };
      }
    }
    if (kind === "calendar") {
      base.enabledCalendars =
        config.enabledCalendars && config.enabledCalendars.length > 0
          ? config.enabledCalendars
          : ["primary"];
      base.calendars = Object.entries(config.calendars ?? {}).map(([id, c]) => ({
        id,
        indexed: c.indexed,
        lastSyncedAt: c.lastSyncedAt,
      }));
    }
    return base;
  };

  app.get(
    "/api/connectors",
    {
      schema: routeSchema({
        tags,
        summary: "Connector status",
        response: connectorsSchema.ConnectorStatusSchema,
      }),
    },
    async () => connectorsSchema.ConnectorStatusSchema.parse(statusView()),
  );

  // Save the user's OAuth client id/secret (no tokens yet).
  app.put<{ Body: { clientId?: string; clientSecret?: string } }>(
    "/api/connectors/google/credentials",
    {
      schema: routeSchema({
        tags,
        summary: "Save Google OAuth credentials",
        body: connectorsSchema.GoogleCredentialsBody,
        response: connectorsSchema.ConnectorStatusSchema,
      }),
    },
    async (request) => {
      const body = parseOrThrow(connectorsSchema.GoogleCredentialsBody, request.body, "body");
      const clientId = body.clientId.trim();
      const clientSecret = body.clientSecret.trim();
      if (!clientId || !clientSecret) {
        throw httpError.validation("Both clientId and clientSecret are required");
      }
      ctx.store.upsertConnectorAccount({ provider: "google", clientId, clientSecret });
      return connectorsSchema.ConnectorStatusSchema.parse(statusView());
    },
  );

  // Begin the consent flow: build the PKCE auth URL the UI opens in a browser.
  app.post(
    "/api/connectors/google/auth/start",
    {
      schema: routeSchema({
        tags,
        summary: "Start Google OAuth",
        response: connectorsSchema.AuthStartResponse,
      }),
    },
    async () => {
      const account = ctx.store.getConnectorAccount("google");
      if (!account?.client_id) {
        throw httpError.badRequest("Save your Google OAuth credentials first");
      }
      const { verifier, challenge, state } = createPkcePair();
      pending.set(state, verifier);
      // Don't leak verifiers forever if the user abandons the flow.
      setTimeout(() => pending.delete(state), 10 * 60_000).unref();
      const url = google.oauth.buildAuthUrl({
        clientId: account.client_id,
        redirectUri,
        challenge,
        state,
      });
      return connectorsSchema.AuthStartResponse.parse({ url });
    },
  );

  // Loopback callback: exchange the code, store tokens, record the account email.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/connectors/google/callback",
    async (request, reply) => {
      const { code, state, error } = request.query;
      const page = (heading: string, detail: string) =>
        reply
          .type("text/html")
          .send(
            `<!doctype html><meta charset="utf-8"><title>MeOS</title>` +
              `<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
              `<div style="text-align:center"><h2>${heading}</h2><p style="color:#aaa">${detail}</p></div>` +
              `<script>setTimeout(()=>window.close(),1500)</script></body>`,
          );

      if (error) return page("Authorization cancelled", "You can close this window.");
      const verifier = state ? pending.get(state) : undefined;
      if (!code || !state || !verifier) {
        return page("Authorization failed", "Missing or expired request — try connecting again.");
      }
      pending.delete(state);

      const account = ctx.store.getConnectorAccount("google");
      if (!account?.client_id || !account?.client_secret) {
        return page("Authorization failed", "Google credentials are missing.");
      }
      try {
        const tokens = await google.oauth.exchangeCode({
          clientId: account.client_id,
          clientSecret: account.client_secret,
          code,
          verifier,
          redirectUri,
        });
        ctx.store.updateConnectorTokens(account.id, tokens);
        // Best-effort: record which account this is for the UI.
        try {
          const self = await fetchSelf(tokens.accessToken);
          if (self.email) {
            ctx.store.upsertConnectorAccount({ provider: "google", accountEmail: self.email });
          }
        } catch {
          // Non-fatal — the connection still works without the display email.
        }
        return page(
          "Connected ✓",
          "MeOS can now sync your Google data. You can close this window.",
        );
      } catch (err) {
        return page("Authorization failed", err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Enable/disable a kind, set its interval, and (additively) its coverage window,
  // content mode, and enabled calendars (#68). Rebuilds the schedule; a coverage
  // change re-syncs so the new window/mode/calendars take effect immediately.
  app.put<{
    Params: { kind: string };
    Body: {
      enabled?: boolean;
      intervalMinutes?: number;
      coverageWindow?: string;
      contentMode?: string;
      enabledCalendars?: string[];
    };
  }>(
    "/api/connectors/google/:kind/config",
    {
      schema: routeSchema({
        tags,
        summary: "Configure a connector kind",
        params: connectorsSchema.ConnectorKindParam,
        body: connectorsSchema.ConfigureKindBody,
        response: connectorsSchema.ConnectorStatusSchema,
      }),
    },
    async (request) => {
      const params = parseOrThrow(connectorsSchema.ConnectorKindParam, request.params, "params");
      const kind = params.kind;
      if (!KINDS.includes(kind)) throw httpError.badRequest(`Unknown kind: ${kind}`);
      const account = ctx.store.getConnectorAccount("google");
      if (!account) throw httpError.badRequest("Google is not connected");

      const body = parseOrThrow(connectorsSchema.ConfigureKindBody, request.body, "body");
      const { enabled, intervalMinutes, coverageWindow, contentMode, enabledCalendars } = body;

      // Assemble any coverage-config changes into a single config patch (#68).
      const configPatch: ConnectorKindConfig = {};
      if (coverageWindow != null) configPatch.coverageWindow = coverageWindow;
      if (kind === "gmail" && contentMode != null) configPatch.contentMode = contentMode;
      if (kind === "calendar" && enabledCalendars != null)
        configPatch.enabledCalendars = enabledCalendars;
      const coverageChanged = Object.keys(configPatch).length > 0;
      // Re-seeding coverage: clear the cursor so the new window/calendars re-pull from
      // the bound (a wider window must not be limited to the old incremental cursor).
      if (coverageChanged) configPatch.backfill = undefined;

      ctx.store.setSyncState(account.id, kind, {
        enabled,
        intervalMinutes:
          intervalMinutes != null ? Math.max(1, Math.floor(intervalMinutes)) : undefined,
        ...(coverageChanged
          ? { config: configPatch, ...(coverageWindow != null ? { syncToken: null } : {}) }
          : {}),
      });
      ctx.connectors.reschedule();
      // Pull immediately on first enable or a coverage change so the user sees the
      // new coverage without waiting for the next scheduled tick.
      if (enabled || coverageChanged) ctx.connectors.enqueueSync("google", kind);
      return connectorsSchema.ConnectorStatusSchema.parse(statusView());
    },
  );

  // List the user's Google calendars for the multi-calendar picker (#68).
  app.get(
    "/api/connectors/google/calendars",
    {
      schema: routeSchema({
        tags,
        summary: "List Google calendars",
        response: connectorsSchema.ListCalendarsResponse,
      }),
    },
    async () => {
      const account = ctx.store.getConnectorAccount("google");
      if (!account) throw httpError.badRequest("Google is not connected");
      const calendars = await ctx.connectors.listCalendars("google");
      return connectorsSchema.ListCalendarsResponse.parse({ calendars });
    },
  );

  // Sync one kind now.
  app.post<{ Params: { kind: string } }>(
    "/api/connectors/google/:kind/sync",
    {
      schema: routeSchema({
        tags,
        summary: "Sync a connector kind now",
        params: connectorsSchema.ConnectorKindParam,
        response: { 202: connectorsSchema.SyncKindResponse },
      }),
    },
    async (request, reply) => {
      const params = parseOrThrow(connectorsSchema.ConnectorKindParam, request.params, "params");
      const kind = params.kind;
      if (!KINDS.includes(kind)) throw httpError.badRequest(`Unknown kind: ${kind}`);
      const account = ctx.store.getConnectorAccount("google");
      if (!account) throw httpError.badRequest("Google is not connected");
      ctx.connectors.enqueueSync("google", kind);
      return reply.code(202).send(connectorsSchema.SyncKindResponse.parse({ syncing: true }));
    },
  );

  // Disconnect: revoke the token, stop timers, forget the account.
  app.delete(
    "/api/connectors/google",
    {
      schema: routeSchema({
        tags,
        summary: "Disconnect Google",
        response: connectorsSchema.DisconnectResponse,
      }),
    },
    async () => {
      const account = ctx.store.getConnectorAccount("google");
      if (account?.access_token) await google.oauth.revokeToken(account.access_token);
      ctx.store.deleteConnectorAccount("google");
      ctx.connectors.reschedule();
      return connectorsSchema.DisconnectResponse.parse({ disconnected: true });
    },
  );
}
