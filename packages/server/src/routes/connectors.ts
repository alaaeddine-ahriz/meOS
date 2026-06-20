import { connectors as connectorsSchema } from "@meos/contracts";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  completeTask,
  connectorRegistry,
  createPkcePair,
  createTask,
  deriveCoverageState,
  ensureAccessToken,
  fetchSelf,
  listTaskLists,
} from "@meos/core";
import type { Connector, ConnectorKindConfig } from "@meos/core";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["connectors"];

/**
 * Connector setup + control, PROVIDER-GENERIC over the registry (#5). The route
 * owns the HTTP surface; each registered connector owns "what it is" — its auth
 * model, kinds, and validation. A request resolves its connector from the
 * `:provider` path segment, so `/api/connectors/google/...` and any future
 * provider share one set of handlers.
 *
 * OAuth providers authenticate via loopback + PKCE for an installed "Desktop app"
 * client whose credentials the user pastes in Settings. The one-time PKCE verifier
 * is held in memory keyed by the OAuth `state` (no session plugin needed); tokens
 * are exchanged on the loopback callback and stored in the DB. Tokens are never
 * returned to the client — only connection status.
 */
export function registerConnectorRoutes(app: FastifyInstance, ctx: AppContext): void {
  // state → PKCE verifier, awaiting the callback. Short-lived, single-use.
  const pending = new Map<string, string>();
  const redirectUri = (provider: string) =>
    `http://127.0.0.1:${ctx.config.server.port}/api/connectors/${provider}/callback`;

  /**
   * Resolve the connector named by the `:provider` path segment, 404ing through the
   * standard error envelope when no connector is registered for it. Backward-
   * compatible: existing `/api/connectors/google/...` URLs resolve `provider="google"`.
   */
  const requireConnector = (provider: string): Connector => {
    const connector = connectorRegistry.get(provider);
    if (!connector) throw httpError.notFound(`Unknown connector: ${provider}`);
    return connector;
  };

  /**
   * Resolve a connector AND its OAuth surface for the OAuth-only flow (consent
   * start + callback), narrowing past the optional `oauth` field. Basic-auth
   * connectors have no hosted consent flow — they persist credentials directly via
   * PUT /credentials — so the OAuth routes 400 for them with a clear message.
   */
  const requireOAuth = (provider: string) => {
    const connector = requireConnector(provider);
    if (connector.manifest.auth.kind !== "oauth2" || !connector.oauth) {
      throw httpError.badRequest(`${provider} is not an OAuth connector`);
    }
    return { connector, oauth: connector.oauth };
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
    const last = config.lastSync;
    const base = {
      itemCount: stats.itemCount,
      oldestIndexed: stats.oldestIndexed,
      coverageWindow: config.coverageWindow ?? "recent",
      // The unambiguous completeness state + last-success/last-failure split (#88),
      // so the UI never shows just "connected". Derived deterministically in core.
      state: deriveCoverageState(config),
      lastSuccessAt: last?.okAt ?? null,
      lastFailureAt: last?.errorAt ?? null,
      lastError: last?.error ?? null,
      lastIndexed: last?.indexed,
      lastSkipped: last?.skipped,
      lastFailed: last?.failed,
    } as Record<string, unknown>;
    if (kind === "gmail") {
      base.contentMode = config.contentMode ?? "metadata";
      base.includeLabels = config.includeLabels ?? [];
      base.excludeLabels = config.excludeLabels ?? [];
      if (config.backfill) {
        base.backfill = {
          indexed: config.backfill.indexed,
          oldestIndexed: config.backfill.oldestIndexed,
          complete: config.backfill.complete,
        };
      }
    }
    if (kind === "calendar") {
      // The live calendar list (`availableCalendars`) is fetched via the dedicated
      // GET /calendars endpoint the UI already calls — kept out of this per-poll
      // status view so /api/connectors stays a cheap, network-free read.
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
    if (kind === "tasks") {
      // Task-list selection (#88); the available lists come from the dedicated
      // GET /tasks/lists endpoint (it needs a live token), like calendars above.
      base.enabledTaskLists = config.enabledTaskLists ?? [];
    }
    return base;
  };

  /**
   * Whether a basic-auth account has every REQUIRED field present in its stored
   * auth config — the basic-auth analogue of "has client id + secret". Drives both
   * `connected` and `hasCredentials` for a basic connector (there's no token step).
   */
  const basicAuthSatisfied = (connector: Connector): boolean => {
    if (connector.manifest.auth.kind !== "basic") return false;
    const stored = ctx.store.getConnectorAuthConfig(connector.manifest.id);
    if (!stored) return false;
    return connector.manifest.auth.fields
      .filter((f) => f.required)
      .every((f) => Boolean(stored[f.key]?.trim()));
  };

  /** The live status block for one connector (an entry in the providers array). */
  const providerStatusFor = (connector: Connector) => {
    const provider = connector.manifest.id;
    const account = ctx.store.getConnectorAccount(provider);
    const isBasic = connector.manifest.auth.kind === "basic";
    const basicReady = isBasic && basicAuthSatisfied(connector);
    const connected = isBasic
      ? basicReady
      : Boolean(account?.refresh_token || account?.access_token);
    const kinds = connector.manifest.kinds.map((manifest) => {
      const kind = manifest.kind;
      const state = account ? ctx.store.getSyncState(account.id, kind) : undefined;
      const cfg = account ? ctx.store.getSyncConfig(account.id, kind) : undefined;
      return {
        kind,
        enabled: state?.enabled === 1,
        intervalMinutes: state?.interval_minutes ?? manifest.defaultIntervalMinutes,
        mode: cfg?.mode ?? "index",
        lastSyncedAt: state?.last_synced_at ?? null,
        lastStatus: state?.last_status ?? null,
        coverage: account ? coverageFor(account.id, kind) : undefined,
      };
    });
    return {
      provider,
      connected,
      // A basic connector surfaces the IMAP username as its account email when set.
      accountEmail:
        account?.account_email ??
        (isBasic ? (ctx.store.getConnectorAuthConfig(provider)?.username ?? null) : null),
      hasCredentials: isBasic ? basicReady : Boolean(account?.client_id && account?.client_secret),
      kinds,
    };
  };

  /** The multi-provider status payload — one entry per registered connector. */
  const statusView = () => ({
    providers: connectorRegistry.list().map((c) => providerStatusFor(c)),
  });

  app.get(
    "/api/connectors",
    {
      schema: routeSchema({
        tags,
        summary: "Connector status",
        response: connectorsSchema.ConnectorStatusSchema,
        // Exposed over MCP so an agent can see which connectors are connected + their coverage.
        mcp: { expose: true, name: "connectors", safety: "read" },
      }),
    },
    async () => connectorsSchema.ConnectorStatusSchema.parse(statusView()),
  );

  // Save the connector's credentials, branching on its auth model: an OAuth
  // connector gets its client id/secret; a basic-auth one (IMAP …) gets its declared
  // `fields` form persisted as an auth-config JSON object. No JSON-Schema body on the
  // route — the shape differs per auth kind, so each branch validates its own body.
  app.put<{ Params: { provider: string }; Body: unknown }>(
    "/api/connectors/:provider/credentials",
    {
      schema: routeSchema({
        tags,
        summary: "Save a connector's credentials",
        response: connectorsSchema.ConnectorStatusSchema,
        // Destructive: persists secrets / changes auth — recorded but never auto-exposed.
        mcp: { expose: true, safety: "destructive" },
      }),
    },
    async (request) => {
      const provider = request.params.provider;
      const connector = requireConnector(provider);

      if (connector.manifest.auth.kind === "basic") {
        // Validate the submitted fields against the manifest: every `required` field
        // must be present and non-empty. Store the lot as a JSON auth-config object.
        const body = parseOrThrow(connectorsSchema.BasicCredentialsBody, request.body, "body");
        const fields = connector.manifest.auth.fields;
        const values: Record<string, string> = {};
        for (const field of fields) {
          const value = body[field.key]?.trim() ?? "";
          if (field.required && !value) {
            throw httpError.validation(`${field.label} is required`);
          }
          if (value) values[field.key] = value;
        }
        // Best-effort connection check (e.g. open + close an IMAP session). A failure
        // is surfaced as a warning, not a hard error — we don't block storing valid
        // credentials on a transient outage. (Status carries no warning field today.)
        if (connector.testConnection) {
          try {
            const result = await connector.testConnection(values);
            if (!result.ok) {
              app.log.warn(
                { provider, error: result.error },
                `${provider} credential test failed; saving anyway`,
              );
            }
          } catch (err) {
            app.log.warn({ provider, err }, `${provider} credential test threw; saving anyway`);
          }
        }
        ctx.store.upsertConnectorAccount({ provider, authConfig: JSON.stringify(values) });
        return connectorsSchema.ConnectorStatusSchema.parse(statusView());
      }

      // OAuth: client id/secret only (no tokens yet — those come from the consent flow).
      const body = parseOrThrow(connectorsSchema.GoogleCredentialsBody, request.body, "body");
      const clientId = body.clientId.trim();
      const clientSecret = body.clientSecret.trim();
      if (!clientId || !clientSecret) {
        throw httpError.validation("Both clientId and clientSecret are required");
      }
      ctx.store.upsertConnectorAccount({ provider, clientId, clientSecret });
      return connectorsSchema.ConnectorStatusSchema.parse(statusView());
    },
  );

  // Begin the consent flow: build the PKCE auth URL the UI opens in a browser.
  app.post<{ Params: { provider: string } }>(
    "/api/connectors/:provider/auth/start",
    {
      schema: routeSchema({
        tags,
        summary: "Start a connector's OAuth flow",
        response: connectorsSchema.AuthStartResponse,
      }),
    },
    async (request) => {
      const provider = request.params.provider;
      const { oauth } = requireOAuth(provider);
      const account = ctx.store.getConnectorAccount(provider);
      if (!account?.client_id) {
        throw httpError.badRequest(`Save your ${provider} OAuth credentials first`);
      }
      const { verifier, challenge, state } = createPkcePair();
      pending.set(state, verifier);
      // Don't leak verifiers forever if the user abandons the flow.
      setTimeout(() => pending.delete(state), 10 * 60_000).unref();
      const url = oauth.buildAuthUrl({
        clientId: account.client_id,
        redirectUri: redirectUri(provider),
        challenge,
        state,
      });
      return connectorsSchema.AuthStartResponse.parse({ url });
    },
  );

  // Loopback callback: exchange the code, store tokens, record the account email.
  app.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string };
  }>("/api/connectors/:provider/callback", async (request, reply) => {
    const provider = request.params.provider;
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

    const connector = connectorRegistry.get(provider);
    if (!connector || connector.manifest.auth.kind !== "oauth2" || !connector.oauth) {
      return page("Authorization failed", `${provider} is not an OAuth connector.`);
    }
    const oauth = connector.oauth;

    if (error) return page("Authorization cancelled", "You can close this window.");
    const verifier = state ? pending.get(state) : undefined;
    if (!code || !state || !verifier) {
      return page("Authorization failed", "Missing or expired request — try connecting again.");
    }
    pending.delete(state);

    const account = ctx.store.getConnectorAccount(provider);
    if (!account?.client_id || !account?.client_secret) {
      return page("Authorization failed", `${provider} credentials are missing.`);
    }
    try {
      const tokens = await oauth.exchangeCode({
        clientId: account.client_id,
        clientSecret: account.client_secret,
        code,
        verifier,
        redirectUri: redirectUri(provider),
      });
      ctx.store.updateConnectorTokens(account.id, tokens);
      // Best-effort: record which account this is for the UI.
      try {
        const self = await fetchSelf(tokens.accessToken);
        if (self.email) {
          ctx.store.upsertConnectorAccount({ provider, accountEmail: self.email });
        }
      } catch {
        // Non-fatal — the connection still works without the display email.
      }
      return page(
        "Connected ✓",
        `MeOS can now sync your ${connector.manifest.displayName} data. You can close this window.`,
      );
    } catch (err) {
      return page("Authorization failed", err instanceof Error ? err.message : String(err));
    }
  });

  // Enable/disable a kind, set its interval, and (additively) its coverage window,
  // content mode, and enabled calendars (#68). Rebuilds the schedule; a coverage
  // change re-syncs so the new window/mode/calendars take effect immediately.
  app.put<{
    Params: { provider: string; kind: string };
    Body: {
      enabled?: boolean;
      intervalMinutes?: number;
      coverageWindow?: string;
      contentMode?: string;
      enabledCalendars?: string[];
      mode?: "index" | "wiki";
      includeLabels?: string[];
      excludeLabels?: string[];
      enabledTaskLists?: string[];
      reset?: boolean;
    };
  }>(
    "/api/connectors/:provider/:kind/config",
    {
      // No `params` JSON schema here: the contract's ConnectorKindParam only
      // declares `kind`, so attaching it makes Fastify strip `:provider` from
      // request.params (zod→JSON Schema emits additionalProperties:false). The
      // kind is validated against the resolved connector's manifest below instead.
      schema: routeSchema({
        tags,
        summary: "Configure a connector kind",
        body: connectorsSchema.ConfigureKindBody,
        response: connectorsSchema.ConnectorStatusSchema,
        // Destructive: a reset/coverage change can wipe the sync cursor + re-import — never auto-exposed.
        mcp: { expose: true, safety: "destructive" },
      }),
    },
    async (request) => {
      const provider = request.params.provider;
      const connector = requireConnector(provider);
      const params = parseOrThrow(connectorsSchema.ConnectorKindParam, request.params, "params");
      const kind = params.kind;
      if (!connector.manifest.kinds.some((k) => k.kind === kind)) {
        throw httpError.badRequest(`Unknown kind: ${kind}`);
      }
      const account = ctx.store.getConnectorAccount(provider);
      if (!account) throw httpError.badRequest(`${provider} is not connected`);

      const body = parseOrThrow(connectorsSchema.ConfigureKindBody, request.body, "body");
      const {
        enabled,
        intervalMinutes,
        coverageWindow,
        contentMode,
        enabledCalendars,
        mode,
        includeLabels,
        excludeLabels,
        enabledTaskLists,
        reset,
      } = body;

      // Assemble any coverage-config changes into a single config patch (#68/#88).
      const configPatch: ConnectorKindConfig = {};
      if (coverageWindow != null) configPatch.coverageWindow = coverageWindow;
      if (kind === "gmail" && contentMode != null) configPatch.contentMode = contentMode;
      if (kind === "gmail" && includeLabels != null) configPatch.includeLabels = includeLabels;
      if (kind === "gmail" && excludeLabels != null) configPatch.excludeLabels = excludeLabels;
      if (kind === "calendar" && enabledCalendars != null)
        configPatch.enabledCalendars = enabledCalendars;
      if (kind === "tasks" && enabledTaskLists != null)
        configPatch.enabledTaskLists = enabledTaskLists;
      // A coverage change re-seeds: clear the cursor so the new window/labels/lists
      // re-pull from the bound (a wider window must not be limited to the old cursor).
      // Content mode + the index/wiki mode are NOT coverage — toggling them must not
      // re-pull the mailbox — so they're tracked separately.
      const coverageChanged =
        coverageWindow != null ||
        includeLabels != null ||
        excludeLabels != null ||
        enabledCalendars != null ||
        enabledTaskLists != null;
      // Full re-import (#88): the explicit "reset & re-import" action wipes the
      // cursor + backfill so the whole window is re-pulled from scratch.
      const resetting = reset === true;
      if (coverageChanged || resetting) configPatch.backfill = undefined;
      // The index/wiki mode (the "one of two" choice) is a plain config flag — it
      // never resets the cursor, so toggling it doesn't re-pull the mailbox.
      if (mode != null) configPatch.mode = mode;
      const configChanged = Object.keys(configPatch).length > 0;
      // Clearing the cursor forces a fresh full pull (new window seed, or a reset).
      const clearCursor = coverageWindow != null || resetting;

      ctx.store.setSyncState(account.id, kind, {
        enabled,
        intervalMinutes:
          intervalMinutes != null ? Math.max(1, Math.floor(intervalMinutes)) : undefined,
        ...(configChanged
          ? { config: configPatch, ...(clearCursor ? { syncToken: null } : {}) }
          : clearCursor
            ? { syncToken: null }
            : {}),
      });
      ctx.connectors.reschedule();
      // Pull immediately on first enable, a coverage change, or a reset so the user
      // sees the new coverage without waiting for the next scheduled tick.
      if (enabled || coverageChanged || resetting) ctx.connectors.enqueueSync(provider, kind);
      return connectorsSchema.ConnectorStatusSchema.parse(statusView());
    },
  );

  // List the user's calendars for the multi-calendar picker (#68).
  app.get<{ Params: { provider: string } }>(
    "/api/connectors/:provider/calendars",
    {
      schema: routeSchema({
        tags,
        summary: "List a connector's calendars",
        response: connectorsSchema.ListCalendarsResponse,
        // Exposed over MCP so an agent can read the account's available calendars.
        mcp: { expose: true, name: "connectors_calendars", safety: "read" },
      }),
    },
    async (request) => {
      const provider = request.params.provider;
      requireConnector(provider);
      const account = ctx.store.getConnectorAccount(provider);
      if (!account) throw httpError.badRequest(`${provider} is not connected`);
      const calendars = await ctx.connectors.listCalendars(provider);
      return connectorsSchema.ListCalendarsResponse.parse({ calendars });
    },
  );

  // Sync one kind now.
  app.post<{ Params: { provider: string; kind: string } }>(
    "/api/connectors/:provider/:kind/sync",
    {
      // See the config route above: no `params` schema, or Fastify strips
      // `:provider`. The kind is validated against the connector's manifest below.
      schema: routeSchema({
        tags,
        summary: "Sync a connector kind now",
        response: { 202: connectorsSchema.SyncKindResponse },
        // Exposed over MCP: trigger a sync of one kind now (idempotent pull).
        mcp: { expose: true, name: "connectors_sync", safety: "write" },
      }),
    },
    async (request, reply) => {
      const provider = request.params.provider;
      const connector = requireConnector(provider);
      const params = parseOrThrow(connectorsSchema.ConnectorKindParam, request.params, "params");
      const kind = params.kind;
      if (!connector.manifest.kinds.some((k) => k.kind === kind)) {
        throw httpError.badRequest(`Unknown kind: ${kind}`);
      }
      const account = ctx.store.getConnectorAccount(provider);
      if (!account) throw httpError.badRequest(`${provider} is not connected`);
      ctx.connectors.enqueueSync(provider, kind);
      return reply.code(202).send(connectorsSchema.SyncKindResponse.parse({ syncing: true }));
    },
  );

  // --- Tasks (read + write) ---
  //
  // A connected, live access token for the account, refreshed if needed through the
  // existing OAuth lifecycle. Throws the standard error envelope when the provider
  // isn't connected so the routes share one guard.
  const taskAccessToken = async (provider: string): Promise<string> => {
    const connector = requireConnector(provider);
    const account = ctx.store.getConnectorAccount(provider);
    if (!account) throw httpError.badRequest(`${provider} is not connected`);
    try {
      return await ensureAccessToken(ctx.store, account, connector);
    } catch (err) {
      throw httpError.badRequest(err instanceof Error ? err.message : String(err));
    }
  };

  // List the account's task lists — for the sync-selection + default-list picker.
  app.get<{ Params: { provider: string } }>(
    "/api/connectors/:provider/tasks/lists",
    {
      schema: routeSchema({
        tags,
        summary: "List a connector's task lists",
        response: connectorsSchema.TaskListsResponse,
        // Exposed over MCP so an agent can read the account's task lists.
        mcp: { expose: true, name: "connectors_tasks_lists", safety: "read" },
      }),
    },
    async (request) => {
      const token = await taskAccessToken(request.params.provider);
      try {
        const lists = await listTaskLists(token);
        return { lists };
      } catch (err) {
        throw httpError.badRequest(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // WRITE PATH: create a task on the user's behalf. This is the connector's explicit
  // write capability (the `tasks` scope is read/write). Provenance: the created task
  // flows back into the graph on the next `tasks` sync as a tasks source (deep-
  // linked), exactly like a synced task.
  app.post<{
    Params: { provider: string };
    Body: { taskListId?: string; title?: string; notes?: string; due?: string };
  }>(
    "/api/connectors/:provider/tasks/create",
    {
      schema: routeSchema({
        tags,
        summary: "Create a task via a connector",
        body: connectorsSchema.CreateTaskBody,
        response: { 201: connectorsSchema.CreateTaskResponse },
        // Exposed over MCP: the connector's explicit write capability (a real task is created).
        mcp: { expose: true, name: "connectors_task_create", safety: "write" },
      }),
    },
    async (request, reply) => {
      const provider = request.params.provider;
      const body = parseOrThrow(connectorsSchema.CreateTaskBody, request.body, "body");
      const token = await taskAccessToken(provider);
      let taskListId = body.taskListId;
      try {
        if (!taskListId) {
          // No list specified — fall back to the account's first (default) list.
          const lists = await listTaskLists(token);
          taskListId = lists[0]?.id;
          if (!taskListId) throw httpError.badRequest("No task list is available");
        }
        const task = await createTask(token, taskListId, {
          title: body.title,
          notes: body.notes,
          due: body.due ?? null,
        });
        // Pull the new task into the graph promptly (best-effort; non-blocking).
        ctx.connectors.enqueueSync(provider, "tasks");
        return reply.code(201).send({ task });
      } catch (err) {
        if (err && typeof err === "object" && "statusCode" in err) throw err;
        throw httpError.badRequest(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // WRITE PATH: mark a task completed (or reopen it).
  app.post<{
    Params: { provider: string; taskId: string };
    Body: { taskListId?: string; completed?: boolean };
  }>(
    "/api/connectors/:provider/tasks/:taskId/complete",
    {
      schema: routeSchema({
        tags,
        summary: "Complete (or reopen) a task via a connector",
        body: z.object({
          taskListId: z.string(),
          completed: z.boolean().optional(),
        }),
        response: connectorsSchema.CreateTaskResponse,
        // Exposed over MCP: mark a task done / reopen it (reversible by re-calling).
        mcp: { expose: true, name: "connectors_task_complete", safety: "write" },
      }),
    },
    async (request) => {
      const provider = request.params.provider;
      const token = await taskAccessToken(provider);
      const taskId = request.params.taskId;
      const body = request.body ?? {};
      if (!body.taskListId) throw httpError.validation("taskListId is required");
      try {
        const task = await completeTask(token, body.taskListId, taskId, body.completed !== false);
        ctx.connectors.enqueueSync(provider, "tasks");
        return { task };
      } catch (err) {
        if (err && typeof err === "object" && "statusCode" in err) throw err;
        throw httpError.badRequest(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // Disconnect: revoke the token, stop timers, forget the account.
  app.delete<{ Params: { provider: string } }>(
    "/api/connectors/:provider",
    {
      schema: routeSchema({
        tags,
        summary: "Disconnect a connector",
        response: connectorsSchema.DisconnectResponse,
        // Destructive: revokes tokens + forgets the account — recorded but never auto-exposed.
        mcp: { expose: true, safety: "destructive" },
      }),
    },
    async (request) => {
      const provider = request.params.provider;
      const connector = requireConnector(provider);
      const account = ctx.store.getConnectorAccount(provider);
      // OAuth connectors best-effort revoke their token upstream; basic-auth ones
      // hold no revocable token, so disconnect is just forgetting the local account.
      if (connector.manifest.auth.kind === "oauth2" && connector.oauth && account?.access_token) {
        await connector.oauth.revokeToken(account.access_token);
      }
      ctx.store.deleteConnectorAccount(provider);
      ctx.connectors.reschedule();
      return connectorsSchema.DisconnectResponse.parse({ disconnected: true });
    },
  );
}
