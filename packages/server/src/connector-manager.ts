import {
  connectorRegistry,
  createLogger,
  ensureAccessToken,
  IngestPriority,
  syncConnector,
  type CalendarListEntry,
  type Connector,
  type ConnectorRegistry,
  type IngestionPipeline,
  type JobQueue,
  type KnowledgeStore,
} from "@meos/core";

const log = createLogger("connectors");

/**
 * Owns the background sync schedule for connected external accounts. One timer
 * per enabled (account, kind), each pushing a sync onto the shared ingest queue
 * (so connector merges serialise with file ingest). Built inside the app context
 * so it closes over the live store/pipeline/queue; started from main.ts and
 * stopped on shutdown. (Chat-agent tools are assembled by the ChatService straight
 * from the registry — connectors own their own tools.)
 *
 * Driven through the {@link ConnectorRegistry} (#5): kinds and OAuth all come
 * from a resolved {@link Connector}, so this manager names no specific provider.
 */
/** A connector action forwarded from the app process to the worker host (#94). */
export type ConnectorForward = (
  action: "enqueueSync" | "reschedule" | "syncAllEnabled",
  args?: { provider?: string; kind?: string },
) => void;

export class ConnectorManager {
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly registry: ConnectorRegistry;
  /** The connectors with a stored account, scheduled on (re)start. */
  private readonly providers: string[];
  /**
   * When set (the app process), sync execution lives in the worker host, so the
   * actions that arm timers / push merge work are forwarded there instead of run
   * locally — connector merges must share the single writer process. Read-only
   * ops (listCalendars) always run in-process; they only fetch.
   */
  private readonly forward?: ConnectorForward;

  constructor(
    private readonly deps: {
      store: KnowledgeStore;
      pipeline: IngestionPipeline;
      queue: JobQueue;
      forward?: ConnectorForward;
    },
    registry: ConnectorRegistry = connectorRegistry,
  ) {
    this.registry = registry;
    this.providers = registry.list().map((c) => c.manifest.id);
    this.forward = deps.forward;
  }

  start(): void {
    this.reschedule();
  }

  /** The connector + account for a provider, when an account exists. */
  private resolve(provider: string): { connector: Connector; accountId: number } | undefined {
    const connector = this.registry.get(provider);
    const account = this.deps.store.getConnectorAccount(provider);
    if (!connector || !account) return undefined;
    return { connector, accountId: account.id };
  }

  private timerKey(provider: string, kind: string): string {
    return `${provider}:${kind}`;
  }

  /** Rebuild every timer from the persisted per-kind schedule across all connectors. */
  reschedule(): void {
    if (this.forward) return this.forward("reschedule");
    this.stop();
    for (const provider of this.providers) {
      const resolved = this.resolve(provider);
      if (!resolved) continue;
      for (const state of this.deps.store.listSyncState(resolved.accountId)) {
        if (!state.enabled) continue;
        const ms = Math.max(1, state.interval_minutes) * 60_000;
        const timer = setInterval(() => this.enqueueSync(provider, state.kind), ms);
        timer.unref();
        this.timers.set(this.timerKey(provider, state.kind), timer);
      }
    }
  }

  /** Queue a sync of one kind now (used by "Sync now" and the timers). */
  enqueueSync(provider: string, kind: string): void {
    if (this.forward) return this.forward("enqueueSync", { provider, kind });
    // Background connector sync rides below user uploads and watched files (#18),
    // so a large mailbox pull never delays the document the user just dropped in.
    this.deps.queue.push(
      async () => {
        const resolved = this.resolve(provider);
        if (!resolved) return;
        const account = this.deps.store.getConnectorAccount(provider);
        if (!account) return;
        try {
          const result = await syncConnector(this.deps, account, kind, resolved.connector);
          log.info(
            { provider, kind, ingested: result.ingested, skipped: result.skipped },
            `${provider}/${kind} sync: ${result.ingested} updated, ${result.skipped} unchanged`,
          );
          // A resumable backfill (#68) that still has pages re-enqueues itself so a
          // long historical pull drains in bounded steps without blocking the app or
          // waiting for the next scheduled tick. Rides at CONNECTOR priority, so it
          // never delays user uploads or watched files.
          if (result.hasMore) this.enqueueSync(provider, kind);
        } catch (error) {
          log.error({ err: error, provider, kind }, `${provider}/${kind} sync failed`);
        }
      },
      { priority: IngestPriority.CONNECTOR },
    );
  }

  /** A nightly delta pass over every enabled kind (wired to onSchedule). */
  syncAllEnabled(): void {
    if (this.forward) return this.forward("syncAllEnabled");
    for (const provider of this.providers) {
      const resolved = this.resolve(provider);
      if (!resolved) continue;
      for (const state of this.deps.store.listSyncState(resolved.accountId)) {
        if (state.enabled) this.enqueueSync(provider, state.kind);
      }
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  /** How many per-kind sync timers are currently armed (runtime introspection). */
  activeTimerCount(): number {
    return this.timers.size;
  }

  /**
   * List the user's available calendars for the multi-calendar picker (#68).
   * Resolves the connector + a live token, then delegates to the connector's
   * optional `listCalendars`. Returns [] when the provider/kind has no such list.
   */
  async listCalendars(provider: string): Promise<CalendarListEntry[]> {
    const resolved = this.resolve(provider);
    if (!resolved?.connector.listCalendars) return [];
    const account = this.deps.store.getConnectorAccount(provider);
    if (!account) return [];
    const accessToken = await ensureAccessToken(this.deps.store, account, resolved.connector);
    return resolved.connector.listCalendars({ accessToken });
  }
}
