import { connectors as connectorsSchema } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import {
  completeTask,
  connectorRegistry,
  createPkcePair,
  createTask,
  ensureAccessToken,
  fetchSelf,
  listTaskLists,
} from "@meos/core";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";

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

  app.get("/api/connectors", async () => statusView());

  // Save the user's OAuth client id/secret (no tokens yet).
  app.put<{ Body: { clientId?: string; clientSecret?: string } }>(
    "/api/connectors/google/credentials",
    async (request) => {
      const body = parseOrThrow(connectorsSchema.GoogleCredentialsBody, request.body, "body");
      const clientId = body.clientId.trim();
      const clientSecret = body.clientSecret.trim();
      if (!clientId || !clientSecret) {
        throw httpError.validation("Both clientId and clientSecret are required");
      }
      ctx.store.upsertConnectorAccount({ provider: "google", clientId, clientSecret });
      return statusView();
    },
  );

  // Begin the consent flow: build the PKCE auth URL the UI opens in a browser.
  app.post("/api/connectors/google/auth/start", async () => {
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
    return { url };
  });

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

  // Enable/disable a kind and set its sync interval, then rebuild the schedule.
  app.put<{ Params: { kind: string }; Body: { enabled?: boolean; intervalMinutes?: number } }>(
    "/api/connectors/google/:kind/config",
    async (request) => {
      const params = parseOrThrow(connectorsSchema.ConnectorKindParam, request.params, "params");
      const kind = params.kind;
      if (!KINDS.includes(kind)) throw httpError.badRequest(`Unknown kind: ${kind}`);
      const account = ctx.store.getConnectorAccount("google");
      if (!account) throw httpError.badRequest("Google is not connected");

      const { enabled, intervalMinutes } = parseOrThrow(
        connectorsSchema.ConfigureKindBody,
        request.body,
        "body",
      );
      ctx.store.setSyncState(account.id, kind, {
        enabled,
        intervalMinutes:
          intervalMinutes != null ? Math.max(1, Math.floor(intervalMinutes)) : undefined,
      });
      ctx.connectors.reschedule();
      // Pull immediately on first enable so the user sees data without waiting.
      if (enabled) ctx.connectors.enqueueSync("google", kind);
      return statusView();
    },
  );

  // Sync one kind now.
  app.post<{ Params: { kind: string } }>(
    "/api/connectors/google/:kind/sync",
    async (request, reply) => {
      const params = parseOrThrow(connectorsSchema.ConnectorKindParam, request.params, "params");
      const kind = params.kind;
      if (!KINDS.includes(kind)) throw httpError.badRequest(`Unknown kind: ${kind}`);
      const account = ctx.store.getConnectorAccount("google");
      if (!account) throw httpError.badRequest("Google is not connected");
      ctx.connectors.enqueueSync("google", kind);
      return reply.code(202).send({ syncing: true });
    },
  );

  // --- Google Tasks (read + write) ---
  //
  // A connected, live access token for the Google account, refreshed if needed
  // through the existing OAuth lifecycle. Throws the standard error envelope when
  // Google isn't connected so the routes share one guard.
  const taskAccessToken = async (): Promise<string> => {
    const account = ctx.store.getConnectorAccount("google");
    if (!account) throw httpError.badRequest("Google is not connected");
    try {
      return await ensureAccessToken(ctx.store, account, google);
    } catch (err) {
      throw httpError.badRequest(err instanceof Error ? err.message : String(err));
    }
  };

  // List the account's task lists — for the sync-selection + default-list picker.
  app.get("/api/connectors/google/tasks/lists", async () => {
    const token = await taskAccessToken();
    try {
      const lists = await listTaskLists(token);
      return { lists };
    } catch (err) {
      throw httpError.badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  // WRITE PATH: create a task in Google Tasks on the user's behalf. This is the
  // connector's explicit write capability (the `tasks` scope is read/write).
  // Provenance: the created task flows back into the graph on the next `tasks`
  // sync as a google:tasks source (deep-linked), exactly like a synced task.
  app.post<{ Body: { taskListId?: string; title?: string; notes?: string; due?: string } }>(
    "/api/connectors/google/tasks/create",
    async (request, reply) => {
      const body = parseOrThrow(connectorsSchema.CreateTaskBody, request.body, "body");
      const token = await taskAccessToken();
      let taskListId = body.taskListId;
      try {
        if (!taskListId) {
          // No list specified — fall back to the account's first (default) list.
          const lists = await listTaskLists(token);
          taskListId = lists[0]?.id;
          if (!taskListId) throw httpError.badRequest("No Google Tasks list is available");
        }
        const task = await createTask(token, taskListId, {
          title: body.title,
          notes: body.notes,
          due: body.due ?? null,
        });
        // Pull the new task into the graph promptly (best-effort; non-blocking).
        ctx.connectors.enqueueSync("google", "tasks");
        return reply.code(201).send({ task });
      } catch (err) {
        if (err && typeof err === "object" && "statusCode" in err) throw err;
        throw httpError.badRequest(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // WRITE PATH: mark a task completed (or reopen it).
  app.post<{
    Body: { taskListId?: string; completed?: boolean };
    Params: { taskId: string };
  }>("/api/connectors/google/tasks/:taskId/complete", async (request) => {
    const token = await taskAccessToken();
    const taskId = request.params.taskId;
    const body = request.body ?? {};
    if (!body.taskListId) throw httpError.validation("taskListId is required");
    try {
      const task = await completeTask(token, body.taskListId, taskId, body.completed !== false);
      ctx.connectors.enqueueSync("google", "tasks");
      return { task };
    } catch (err) {
      if (err && typeof err === "object" && "statusCode" in err) throw err;
      throw httpError.badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  // Disconnect: revoke the token, stop timers, forget the account.
  app.delete("/api/connectors/google", async () => {
    const account = ctx.store.getConnectorAccount("google");
    if (account?.access_token) await google.oauth.revokeToken(account.access_token);
    ctx.store.deleteConnectorAccount("google");
    ctx.connectors.reschedule();
    return { disconnected: true };
  });
}
