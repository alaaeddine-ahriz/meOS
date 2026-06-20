import fs from "node:fs";
import path from "node:path";
import {
  type AgentTaskRecord,
  createEmbedder,
  createLlmClient,
  createLogger,
  extractionModelId,
  crystallizeSession,
  detectContradictions,
  ensureDataDirs,
  IngestionPipeline,
  JobQueue,
  KnowledgeStore,
  listAgents,
  loadConfig,
  loadProfileContext,
  loadSchema,
  MeosEvents,
  openDatabase,
  overlayStoredLlmConfig,
  resolveGroupClient,
  runConsolidation,
  Semaphore,
  SwitchableLlmClient,
  TASK_GROUPS,
  Vault,
  WikiWriter,
  withRoutingDefaults,
  writeWikiAgentDocs,
  type Embedder,
  type IntelligenceRouting,
  type LlmConfig,
  type MeosConfig,
  type MeosDatabase,
  type TaskGroup,
  type WikiChange,
} from "@meos/core";
import { ActivityBus } from "./activity.js";
import { buildCommitMessage } from "./commit-message.js";
import { ConversationStreamBus } from "./conversation-stream.js";
import { ConnectorManager } from "./connector-manager.js";
import { DurableIngest } from "./durable-ingest.js";
import { GitSync } from "./git.js";
import type { WorkerBridge } from "./runtime/process-split.js";
import { WorkerRegistry } from "./runtime/worker.js";
import {
  ConnectorSyncWorker,
  IngestQueueWorker,
  QueueWorker,
  WatcherWorker,
} from "./runtime/workers.js";
import { FolderWatcher } from "./watcher.js";

/**
 * Which slice of the runtime this context drives (#94, process isolation):
 * - `all`   — single process (today's default): HTTP + every worker.
 * - `app`   — the UI-facing process: HTTP + enqueue only; heavy work is forwarded
 *             to the worker host. Producer-only ingest, forwarding connectors,
 *             no executor/scheduler.
 * - `worker`— the forked worker host: every heavy worker, no HTTP.
 */
export type ContextRole = "all" | "app" | "worker";

/** How many documents may move through parse/embed/extract at once. */
const INGEST_CONCURRENCY = 3;

/**
 * Ceiling on file descriptors the ingest paths (watcher stats/reads + durable
 * executor reads) may hold open at once. Defence-in-depth against EMFILE: a
 * burst of FS events (a large copy, an archive unpacked into a watched folder)
 * fans out into many simultaneous opens that the per-job {@link INGEST_CONCURRENCY}
 * does not bound. Kept well under the common macOS soft limit (256) so the DB,
 * WAL, sockets, and OS watch handles always have headroom.
 */
const FS_OPEN_CONCURRENCY = 32;

const gitLog = createLogger("git");
const wikiLog = createLogger("wiki");
const eventsLog = createLogger("events");

/**
 * The scheduled-task runner's public surface (concrete impl: `AgentTaskRunner` in
 * agent-task-scheduler.ts). Declared here, structurally, so `AppContext` can hold
 * one without importing the module — which would form a cycle through
 * coding-agent-command.ts (scheduler → command → context → scheduler).
 */
export interface TaskRunnerHandle {
  /** Start a run unless one is already in flight; returns the run id or null. */
  start(task: AgentTaskRecord, reschedule: boolean): number | null;
  /** Run a task immediately by id; returns the run id, or null if missing/running. */
  runNow(taskId: number): number | null;
  /** Whether a run for this task is currently executing. */
  isRunning(taskId: number): boolean;
  /** Start every due task not already running (the per-minute poll). */
  tick(): void;
}

export interface AppContext {
  /** Which slice of the runtime this process drives (#94). */
  role: ContextRole;
  rootDir: string;
  config: MeosConfig;
  db: MeosDatabase;
  store: KnowledgeStore;
  /**
   * The `"background"` task group's client — kept as a top-level alias so the many
   * existing `ctx.llm` consumers (and call sites that don't care about routing)
   * stay valid. New code that wants a specific group should call {@link llmFor}.
   */
  llm: SwitchableLlmClient;
  /**
   * The per-task-group LLM clients (#native-agent-intelligence). Each group runs
   * on either the cloud API or a local coding agent per the persisted
   * `intelligence-routing` setting; `applyIntelligenceRouting` swaps each in place
   * when the routing or the provider/key changes. `llmFor("background")` is the
   * same instance as {@link llm}.
   */
  llmFor: (group: TaskGroup) => SwitchableLlmClient;
  /**
   * The provider-health probe's client (#circuit). ALWAYS the cloud API — never a
   * group client that may be routed to a local agent — because the probe's job is
   * to test the configured API provider's credentials/credits. Rebuilt alongside
   * the groups on a provider/key change (see {@link applyIntelligenceRouting}).
   */
  llmProbe: SwitchableLlmClient;
  embedder: Embedder;
  wiki: WikiWriter;
  vault: Vault;
  pipeline: IngestionPipeline;
  queue: JobQueue;
  /** The durable, resumable ingestion layer (#13): persisted jobs + retries. */
  durableIngest: DurableIngest;
  watcher: FolderWatcher;
  git: GitSync;
  events: MeosEvents;
  /** Live + persisted wiki-maintainer transcripts for the Activity view. */
  activity: ActivityBus;
  /**
   * Live agent-run frames keyed by conversation, so a headless scheduled task run
   * can be watched in real time from the Tasks view (#7). Frames are also persisted
   * on the message, so this is pure transient fan-out.
   */
  runStream: ConversationStreamBus;
  /**
   * Runs scheduled agent tasks (#7). Constructed in `buildServer` (the HTTP
   * process), so it's present for routes and the per-minute scheduler; absent in
   * the worker host, which serves no task routes. Typed structurally (the concrete
   * `AgentTaskRunner` lives in agent-task-scheduler.ts) so context.ts doesn't import
   * it — that would close a module cycle through coding-agent-command.ts.
   */
  agentTasks?: TaskRunnerHandle;
  /** Background sync schedule for connected external accounts (Google). */
  connectors: ConnectorManager;
  /**
   * The background workers (watcher, connectors, scheduler, ingest/wiki queues)
   * behind a uniform lifecycle + health surface. `main.ts` drives start/stop
   * through this; the /api/runtime route reads each worker's health.
   */
  workers: WorkerRegistry;
  /**
   * In the app process (#94), the handle used to forward merge-producing work to
   * the worker host (e.g. the consolidate route). Undefined in single-process and
   * worker roles, where such work runs locally.
   */
  workerBridge?: WorkerBridge;
  /**
   * Kick a wiki regeneration of the stale-flagged backlog (coalesced). Exposed so
   * startup recovery can drain a backlog stranded by a restart (#97); routes that
   * make pages stale push through the same coalesced pass.
   */
  refreshWiki: () => void;
}

/**
 * Startup recovery for the wiki backlog (#97). Stale flags live in the DB, but
 * the regeneration *trigger* is in-memory — so a restart leaves any pages that
 * were stale (a merge/ingest landed just before shutdown) un-regenerated until
 * the next ingest happens to fire a refresh. Kick one pass at boot if the backlog
 * is non-empty. Benefits single-process today and the worker host once split.
 * Returns the backlog size found.
 */
export function recoverWikiBacklog(ctx: Pick<AppContext, "store" | "refreshWiki">): number {
  const stale = ctx.store.staleEntities().length;
  if (stale > 0) ctx.refreshWiki();
  return stale;
}

/** The settings key the persisted {@link IntelligenceRouting} lives under. */
export const INTELLIGENCE_ROUTING_KEY = "intelligence-routing";

/** Read the persisted routing (filling defaults) — `"auto"` for every group on a fresh DB. */
export function loadIntelligenceRouting(store: KnowledgeStore): IntelligenceRouting {
  return withRoutingDefaults(store.getSetting<Partial<IntelligenceRouting>>(INTELLIGENCE_ROUTING_KEY));
}

/**
 * Re-resolve every task group's client and {@link SwitchableLlmClient.swap} it in
 * place (#native-agent-intelligence). This is the single re-routing seam, invoked:
 *  (a) once at boot, after the group map is built;
 *  (b) from the Settings LLM route when provider/model/key change — the `api`-backed
 *      groups depend on `ctx.config`, so they must be rebuilt against the new config;
 *  (c) from the routing route when the user edits the routing itself.
 *
 * It re-detects which coding agents are installed (a CLI may have been installed
 * since boot), re-reads the routing setting, and resolves each group synchronously
 * via {@link resolveGroupClient}. Swapping in place keeps every consumer's
 * reference (pipeline, wiki, profile routes, …) valid — no rebuild of the graph.
 */
export async function applyIntelligenceRouting(
  ctx: Pick<AppContext, "config" | "store" | "llmFor" | "llmProbe">,
): Promise<void> {
  // Detect once here so resolveGroupClient stays a pure, synchronous fan-out.
  // listAgents() shells out per agent (cached briefly), so we await it off the
  // hot path — only on boot and on a settings change, never per LLM call.
  const installed = new Set<string>(
    listAgents()
      .filter((a) => a.installed)
      .map((a) => a.id),
  );
  const routing = loadIntelligenceRouting(ctx.store);
  for (const group of TASK_GROUPS) {
    ctx.llmFor(group).swap(resolveGroupClient(group, ctx.config, routing, installed));
  }
  // The probe always tracks the configured cloud provider (never a routed agent),
  // so a provider/key change rebuilds it here too — keeping the recovery probe
  // pointed at the credentials it's meant to test.
  ctx.llmProbe.swap(createLlmClient(ctx.config));
}

/**
 * Run a full consolidation pass + commit its wiki/digest changes. Extracted so
 * both the `/api/jobs/consolidate` route and the worker host run identical logic
 * (a consolidation merges into the graph, so it must execute in the single writer
 * process — the route forwards it there when the runtime is split).
 */
export async function runConsolidationJob(ctx: AppContext): Promise<void> {
  const report = await runConsolidation({
    store: ctx.store,
    llm: ctx.llm,
    wiki: ctx.wiki,
    embedder: ctx.embedder,
    schema: loadSchema(ctx.config.dataDir),
    profile: loadProfileContext(ctx.config.dataDir),
    digestDir: path.join(ctx.config.dataDir, "digests"),
    // External maintenance pauses the paid nightly page rewrite; memory
    // consolidation, lint, and the digest still run.
    regenerateWiki: ctx.store.getWikiMaintenanceMode() !== "external",
  });
  await commitWikiChanges(ctx, report.wikiChanges, "Consolidation", [
    `digests/${report.digestDate}.md`,
  ]);
  const { wikiChanges: _wikiChanges, ...summary } = report;
  eventsLog.info({ report: summary }, "consolidation finished");
}

/**
 * Commit a regeneration pass's wiki changes locally with a comprehensive
 * message, then record the commit so each document can be sliced back to its
 * own diff. Local-only — nothing is pushed until the user syncs to a remote.
 * Failures are logged, never fatal to ingestion.
 */
export async function commitWikiChanges(
  deps: Pick<AppContext, "git" | "store">,
  changes: WikiChange[],
  label?: string,
  extraPaths: string[] = [],
): Promise<void> {
  if (changes.length === 0 && extraPaths.length === 0) return;
  try {
    const { subject, message } = buildCommitMessage(changes, deps.store, label);
    // Scope the commit to exactly the changed pages (+ any digest) so the
    // commit's contents match its message and each document slices cleanly.
    const paths = [...new Set([...changes.map((c) => c.filePath), ...extraPaths])];
    if (!(await deps.git.commitPaths(paths, message))) return;
    const hash = await deps.git.headHash();
    if (hash) deps.store.recordWikiCommit(hash, subject, changes);
  } catch (error) {
    gitLog.error({ err: error }, "failed to commit wiki changes");
  }
}

export function findRootDir(start = process.cwd()): string {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function createContext(
  rootDir = findRootDir(),
  opts: { role?: ContextRole; bridge?: WorkerBridge } = {},
): AppContext {
  const role = opts.role ?? "all";
  const bridge = opts.bridge;
  const config = loadConfig(rootDir);
  ensureDataDirs(config);

  const db = openDatabase(path.join(config.dataDir, "meos.db"));
  const store = new KnowledgeStore(db);
  // Provider, model, and API keys are defined in Settings (persisted in the
  // DB) — overlay them onto the defaults before building the client.
  overlayStoredLlmConfig(config, store.getSetting<LlmConfig>("llm"));

  // One SwitchableLlmClient per task group (#native-agent-intelligence): each
  // group's calls route to the cloud API or a local coding agent per the persisted
  // routing. Built switchable so `applyIntelligenceRouting` can swap each in place
  // when the routing or the provider/key changes — consumers keep their reference.
  // Seeded with the cloud client; the boot-time applyIntelligenceRouting() below
  // re-resolves them against the routing setting + detected agents (which needs an
  // async agent probe we don't want in this synchronous constructor).
  const groupClients = new Map<TaskGroup, SwitchableLlmClient>(
    TASK_GROUPS.map((g) => [g, new SwitchableLlmClient(createLlmClient(config))]),
  );
  const llmFor = (group: TaskGroup): SwitchableLlmClient => {
    const client = groupClients.get(group);
    // Every TaskGroup is seeded above, so this is unreachable — narrow the type.
    if (!client) throw new Error(`No LLM client for task group: ${group}`);
    return client;
  };
  // `ctx.llm` aliases the background group so the many existing consumers stay valid.
  const llm = llmFor("background");
  const embedder = createEmbedder(config.embedding.provider, config.embedding.model);
  // Records each page regeneration's agent transcript and streams it live.
  const activity = new ActivityBus(store);
  // Live fan-out of headless agent-task runs to any Tasks-view watcher (#7).
  const runStream = new ConversationStreamBus();
  // The wiki maintainer routes through the `"wiki"` group — its own routing slot
  // so the agentic page rewrites can run on a (free) local coding agent.
  const wiki = new WikiWriter(
    store,
    llmFor("wiki"),
    path.join(config.dataDir, "wiki"),
    embedder,
    activity.hook,
  );
  // Drop the agent-maintenance guide (AGENTS.md / CLAUDE.md) into the wiki dir so
  // any coding agent that opens the folder learns the workflow + rules. Idempotent
  // and best-effort — never throws.
  writeWikiAgentDocs(path.join(config.dataDir, "wiki"));
  // The user's hand-authored note vault (Obsidian-style), distinct from the
  // system-compiled wiki — free-form markdown that cross-links via [[links]].
  const vault = new Vault(path.join(config.dataDir, "vault"));
  // The automation bus: core stages emit lifecycle events, the server subscribes.
  const events = new MeosEvents();
  events.on("onContradiction", ({ entityId }) => {
    const entity = store.getEntity(entityId);
    eventsLog.info(
      { entityId, entity: entity?.name },
      `contradiction flagged on ${entity?.name ?? `entity ${entityId}`} — needs review`,
    );
  });

  // Wiki regeneration runs decoupled from ingestion: stale flags accumulate in
  // the DB, and a single queued pass handles however many piled up — a batch
  // of 50 watched files triggers one regen per touched entity, not 50.
  const wikiQueue = new JobQueue(1);
  let refreshQueued = false;
  const scheduleWikiRefresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    wikiQueue.push(async () => {
      refreshQueued = false;
      // Under external maintenance the user's own coding agent rewrites pages, so
      // the paid in-app rewrite pauses — wiki_stale stays set for the agent to pick
      // up. Ingestion still ran and marked pages stale; only the rewrite is skipped.
      if (store.getWikiMaintenanceMode() === "external") return;
      const changes = await wiki.regenerateStale();
      await commitWikiChanges({ git, store }, changes);
    });
  };

  const pipeline = new IngestionPipeline({
    store,
    llm,
    embedder,
    wiki,
    scheduleWikiRefresh,
    dataDir: config.dataDir,
    extractionModelId: extractionModelId(config),
    events,
    postMerge: async ({ merge }) => {
      const result = await detectContradictions(
        store,
        llm,
        merge.newObservationIds,
        loadSchema(config.dataDir),
        events,
      );
      const notes: string[] = [];
      if (result.superseded > 0) notes.push(`${result.superseded} fact(s) superseded`);
      if (result.contradictions > 0)
        notes.push(`${result.contradictions} contradiction(s) flagged`);
      return notes.join(", ") || undefined;
    },
  });
  // A dedicated cloud client for the provider-health probe (#circuit). The probe
  // exists to test the configured API provider's credentials/credits, so it must
  // ALWAYS hit the cloud API — never a group client that may be routed to a local
  // agent (which would always "succeed" and mask a broken API key). Rebuilt with
  // the rest on a provider/key change via applyIntelligenceRouting → see the
  // Settings route, which also clears the hold so the backlog drains immediately.
  const probeClient = new SwitchableLlmClient(createLlmClient(config));
  const queue = new JobQueue(INGEST_CONCURRENCY);
  // Shared descriptor budget for the ingest paths (watcher + durable executor),
  // so a burst of file events can't exhaust the process FD limit (EMFILE).
  const fsLimit = new Semaphore(FS_OPEN_CONCURRENCY);
  // The durable layer (#13): persists each ingestion unit, recovers crashed
  // jobs, retries failures with backoff, and prunes old completed history. The
  // in-memory queue above is only its concurrency executor.
  const durableIngest = new DurableIngest({
    store,
    pipeline,
    queue,
    fsLimit,
    stagingDir: path.join(config.dataDir, "ingest-staging"),
    // In the app process the executor lives in the worker host: persist + spill
    // the job, then wake the worker (its sweep is the backstop). Other roles run
    // the executor locally.
    enqueueOnly: role === "app",
    notify: role === "app" && bridge ? () => bridge.notifyPump() : undefined,
    // Auto-recovery probe for the provider hold (#circuit): a 1-token completion
    // that exercises auth + credits + model. Only the role that runs the executor
    // needs it (the app process forwards execution to the worker host), so it's
    // skipped under `enqueueOnly`.
    probe:
      role === "app"
        ? undefined
        : async () => {
            try {
              // The dedicated cloud client — never a group client that may be
              // routed to a local agent — so this truly tests the API provider.
              await probeClient.complete({
                messages: [{ role: "user", content: "ping" }],
                maxTokens: 1,
              });
              return true;
            } catch {
              return false;
            }
          },
  });
  const watcher = new FolderWatcher({
    store,
    pipeline,
    queue,
    durableIngest,
    fsLimit,
    dataDir: config.dataDir,
  });
  const git = new GitSync(config.dataDir);
  // Background sync for connected external accounts. Pushes onto the same ingest
  // queue so connector merges serialise with file ingest. A nightly delta pass
  // also rides the consolidation schedule.
  const connectors = new ConnectorManager({
    store,
    pipeline,
    queue,
    // App process: forward sync execution to the worker host (connector merges
    // must share the single writer process). Read-only ops stay local.
    forward:
      role === "app" && bridge
        ? (action, args) => bridge.forwardConnector(action, args)
        : undefined,
  });
  events.on("onSchedule", () => connectors.syncAllEnabled());

  // Light up the compiled-knowledge retrieval stream for pages written before
  // wiki_pages existed (upgrade path): backfill from disk, locally, once. First
  // prune pages that no longer warrant one — connector-only or factless entities
  // (e.g. people pulled from contacts) whose pages predate the reference-only
  // gating — so the upgrade self-heals without a manual job. Heavy wiki work, so
  // the app process leaves it to the worker host.
  if (role !== "app") {
    queue.push(async () => {
      const pruned = wiki.pruneConnectorOnlyPages();
      if (pruned > 0)
        wikiLog.info({ pruned }, `pruned ${pruned} page(s) for entities without wiki backing`);
      const filled = await wiki.backfillPages();
      if (filled > 0)
        wikiLog.info({ filled }, `backfilled ${filled} page(s) into the retrieval index`);
    });
  }

  // When a conversation closes, distil it into a first-class session source so
  // its reasoning compounds instead of evaporating (crystallization). This merges
  // into the graph, so it must run in the single writer process: the app process
  // forwards the event to the worker host; everyone else crystallizes locally.
  if (role === "app") {
    events.on("onSessionEnd", ({ conversationId }) =>
      bridge?.forwardEvent("onSessionEnd", { conversationId }),
    );
  } else {
    events.on("onSessionEnd", ({ conversationId }) => {
      queue.push(async () => {
        const crystal = await crystallizeSession({
          store,
          llm,
          embedder,
          conversationId,
          schema: loadSchema(config.dataDir),
          profile: loadProfileContext(config.dataDir),
        });
        if (crystal) {
          scheduleWikiRefresh();
          eventsLog.info(
            { conversationId, newFacts: crystal.merge.newObservationIds.length },
            `crystallized conversation ${conversationId}: ${crystal.merge.newObservationIds.length} new fact(s)`,
          );
        }
      });
    });
  }

  // The runtime surface: each background component wrapped behind the uniform
  // Worker interface (see docs/runtime.md). Which workers are REGISTERED (and so
  // started/health-reported) depends on the role (#94):
  //   - all    → every worker in this process (today's behavior).
  //   - app    → only the watcher, which merely enqueues; it stays in the
  //              UI-facing process (fs events are light) and its health is read
  //              in-process. The heavy workers run in the worker host.
  //   - worker → the heavy executors (durable ingest sweep, embedding/wiki health,
  //              connector sync). The scheduler Cron is appended by worker-host.ts.
  // The watcher → connectors → scheduler start ordering is preserved within each
  // role. The ingest + wiki queues are queue-driven (no start/stop of their own).
  const workers = new WorkerRegistry();
  if (role === "app") {
    workers.register(new WatcherWorker(watcher));
  } else if (role === "worker") {
    workers.register(
      new ConnectorSyncWorker(connectors),
      new IngestQueueWorker("ingest", store, "extraction", durableIngest),
      new IngestQueueWorker("embedding", store, "embedding"),
      new QueueWorker("wiki", wikiQueue, "wiki regeneration"),
    );
  } else {
    workers.register(
      new WatcherWorker(watcher),
      new ConnectorSyncWorker(connectors),
      // The durable extraction queue (#13) owns the persisted-job sweep: startAll
      // triggers crash recovery + the periodic stale-job/retention timer. The
      // embedding queue is surfaced for health only (it has no sweep of its own).
      new IngestQueueWorker("ingest", store, "extraction", durableIngest),
      new IngestQueueWorker("embedding", store, "embedding"),
      new QueueWorker("wiki", wikiQueue, "wiki regeneration"),
    );
  }

  const ctx: AppContext = {
    role,
    rootDir,
    config,
    db,
    store,
    llm,
    llmFor,
    llmProbe: probeClient,
    embedder,
    wiki,
    vault,
    pipeline,
    queue,
    durableIngest,
    watcher,
    git,
    events,
    activity,
    runStream,
    connectors,
    workers,
    workerBridge: role === "app" ? bridge : undefined,
    // Startup recovery + the worker host invoke this only in non-app roles; the
    // closure coalesces (refreshQueued) so repeated kicks collapse to one pass.
    refreshWiki: scheduleWikiRefresh,
  };

  // Resolve every group against the routing setting + detected agents now that
  // the context exists. The groups are already seeded with a working cloud client
  // (above), so this fire-and-forget refinement (it awaits the async agent probe)
  // can't leave a group unusable even if it loses a boot race — it only upgrades a
  // group to its routed agent. Errors are swallowed: detection issues must never
  // crash boot, and the seeded cloud client remains a correct fallback.
  void applyIntelligenceRouting(ctx).catch((err) => {
    eventsLog.error({ err }, "failed to apply intelligence routing at boot");
  });

  return ctx;
}
