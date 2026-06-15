import {
  CONNECTOR_KINDS,
  ensureAccessToken,
  searchThreadsText,
  syncConnector,
  type ConnectorKind,
  type IngestionPipeline,
  type JobQueue,
  type KnowledgeStore,
} from "@meos/core";

/**
 * Owns the background sync schedule for connected external accounts. One timer
 * per enabled (account, kind), each pushing a sync onto the shared ingest queue
 * (so connector merges serialise with file ingest). Built inside the app context
 * so it closes over the live store/pipeline/queue; started from main.ts and
 * stopped on shutdown. Also vends the per-turn Gmail fetcher for the chat agent.
 */
export class ConnectorManager {
  private timers = new Map<ConnectorKind, NodeJS.Timeout>();

  constructor(
    private readonly deps: { store: KnowledgeStore; pipeline: IngestionPipeline; queue: JobQueue },
  ) {}

  start(): void {
    this.reschedule();
  }

  /** Rebuild every timer from the persisted per-kind schedule. */
  reschedule(): void {
    this.stop();
    const account = this.deps.store.getConnectorAccount("google");
    if (!account) return;
    for (const state of this.deps.store.listSyncState(account.id)) {
      if (!state.enabled) continue;
      const ms = Math.max(1, state.interval_minutes) * 60_000;
      const timer = setInterval(() => this.enqueueSync(state.kind as ConnectorKind), ms);
      timer.unref();
      this.timers.set(state.kind as ConnectorKind, timer);
    }
  }

  /** Queue a sync of one kind now (used by "Sync now" and the timers). */
  enqueueSync(kind: ConnectorKind): void {
    this.deps.queue.push(async () => {
      const account = this.deps.store.getConnectorAccount("google");
      if (!account) return;
      try {
        const result = await syncConnector(this.deps, account, kind);
        console.log(`[connectors] ${kind} sync: ${result.ingested} updated, ${result.skipped} unchanged`);
      } catch (error) {
        console.error(`[connectors] ${kind} sync failed:`, error instanceof Error ? error.message : error);
      }
    });
  }

  /** A nightly delta pass over every enabled kind (wired to onSchedule). */
  syncAllEnabled(): void {
    const account = this.deps.store.getConnectorAccount("google");
    if (!account) return;
    for (const state of this.deps.store.listSyncState(account.id)) {
      if (state.enabled) this.enqueueSync(state.kind as ConnectorKind);
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
   * A Gmail thread fetcher for the chat agent, or undefined when Gmail isn't
   * connected/enabled — so the `fetch_email_threads` tool only appears when it
   * can work. Re-evaluated per turn by the ChatService.
   */
  gmailFetcher(): ((query: string) => Promise<string>) | undefined {
    const account = this.deps.store.getConnectorAccount("google");
    if (!account) return undefined;
    const state = this.deps.store.getSyncState(account.id, "gmail");
    if (!state?.enabled) return undefined;
    return async (query: string) => {
      const fresh = this.deps.store.getConnectorAccount("google");
      if (!fresh) return "Gmail is no longer connected.";
      const token = await ensureAccessToken(this.deps.store, fresh);
      return searchThreadsText(token, query);
    };
  }
}

export { CONNECTOR_KINDS };
