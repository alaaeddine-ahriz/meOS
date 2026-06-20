import { ingest, staleFacts } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["ingest"];

export function registerIngestRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Facts now backed only by an outdated source revision (#16): superseded by a
  // newer version, or from a deleted/missing source. The UI flags these so an
  // obsolete claim is visible as such rather than treated as equally current.
  app.get(
    "/api/facts/stale",
    {
      schema: routeSchema({
        tags,
        summary: "Facts backed only by outdated sources",
        response: staleFacts.StaleFactsResponse,
        // Exposed over MCP so an agent can find facts backed only by stale revisions.
        mcp: { expose: true, name: "facts_stale", safety: "read" },
      }),
    },
    async () =>
      staleFacts.StaleFactsResponse.parse({
        facts: ctx.store.staleBackedObservations().map((o) => ({
          id: o.id,
          entityId: o.entity_id,
          entityName: o.entity_name,
          entitySlug: o.entity_slug,
          text: o.text,
          status: o.revision_status,
        })),
      }),
  );

  app.post(
    "/api/ingest/upload",
    {
      schema: routeSchema({
        tags,
        summary: "Upload files for ingestion",
        response: { 202: ingest.UploadResponse },
      }),
    },
    async (request, reply) => {
      const accepted: Array<{ inboxItemId: number; jobId: number; filename: string }> = [];
      for await (const part of request.files()) {
        const buffer = await part.toBuffer();
        const filename = part.filename;
        const inboxItemId = ctx.store.createInboxItem(filename);
        // Persist the ingest as a durable job before any work runs, so an upload
        // survives a crash/restart and is retryable (#13). The buffer is held for
        // this first run only; a recovered upload (no path) that never produced a
        // source dead-letters for a manual re-upload.
        const jobId = ctx.durableIngest.enqueueFile({
          filename,
          buffer,
          origin: "upload",
          inboxItemId,
        });
        accepted.push({ inboxItemId, jobId, filename });
      }
      if (accepted.length === 0) {
        throw httpError.badRequest("No files in request");
      }
      return reply.code(202).send(ingest.UploadResponse.parse({ accepted }));
    },
  );

  app.get(
    "/api/inbox",
    {
      schema: routeSchema({
        tags,
        summary: "Inbox items and queue state",
        response: ingest.InboxResponse,
        // Exposed over MCP so an agent can read the ingest inbox + queue state.
        mcp: { expose: true, name: "inbox", safety: "read" },
      }),
    },
    async () =>
      ingest.InboxResponse.parse({
        queuePending: ctx.queue.pending,
        items: ctx.store.listInbox(),
      }),
  );

  // The durable ingest job ledger (#13): every persisted ingestion unit with its
  // lifecycle state, attempts, and last error — enough to diagnose and retry.
  app.get(
    "/api/ingest/jobs",
    {
      schema: routeSchema({
        tags,
        summary: "Durable ingest job ledger",
        response: ingest.IngestJobsResponse,
        // Exposed over MCP so an agent can inspect the durable ingest job ledger.
        mcp: { expose: true, name: "ingest_jobs", safety: "read" },
      }),
    },
    async () =>
      ingest.IngestJobsResponse.parse({
        jobs: ctx.store.listIngestJobs().map((j) => ({
          id: j.id,
          kind: j.kind,
          queue: j.queue,
          stage: j.stage,
          state: j.state,
          attempts: j.attempts,
          maxAttempts: j.max_attempts,
          inboxItemId: j.inbox_item_id,
          sourceId: j.source_id,
          lastError: j.last_error,
          createdAt: j.created_at,
          updatedAt: j.updated_at,
        })),
      }),
  );

  // The ingestion observability surface (#18): per-stage timings + outcome
  // counts, per-queue throughput/backlog metrics, stale-job recovery counters,
  // best-effort per-extraction cost telemetry, and the active backpressure cap —
  // aggregated read-only from `ingest_runs`/`ingest_jobs`/`extraction_cache`, so
  // a slow or expensive ingest is diagnosable without reading terminal logs.
  app.get(
    "/api/ingest/metrics",
    {
      schema: routeSchema({
        tags,
        summary: "Ingestion metrics and telemetry",
        response: ingest.IngestMetricsResponse,
        // Exposed over MCP so an agent can read ingest throughput/cost telemetry.
        mcp: { expose: true, name: "ingest_metrics", safety: "read" },
      }),
    },
    async () =>
      ingest.IngestMetricsResponse.parse({
        queues: ctx.store.ingestQueueMetrics(),
        stages: ctx.store.ingestStageMetrics(),
        recovery: ctx.store.ingestRecoveryMetrics(),
        // No per-model USD rate table ships yet, so cost is surfaced best-effort
        // (null) with token usage; it lights up the moment a rate is wired in.
        costs: ctx.store.ingestCostMetrics(),
        backpressure: { maxBatchesPerPump: ctx.durableIngest.batchCap },
        paused: ctx.store.isIngestPaused(),
        generatedAt: new Date().toISOString(),
      }),
  );

  // Manually retry a failed or dead-letter ingest: resets the retry budget and
  // re-pumps the queue. Idempotent stages make the re-run safe; a job that only
  // needs its extraction retried re-runs from the stored revision (no re-read).
  app.post<{ Params: { id: string } }>(
    "/api/ingest/jobs/:id/retry",
    {
      schema: routeSchema({
        tags,
        summary: "Retry a failed ingest job",
        params: ingest.RetryJobParams,
        response: ingest.RetryJobResponse,
        // Exposed over MCP: re-pump a failed/dead-letter job (idempotent stages).
        mcp: { expose: true, name: "ingest_job_retry", safety: "write" },
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(ingest.RetryJobParams, request.params, "params");
      const job = ctx.store.getIngestJob(id);
      if (!job) {
        throw httpError.notFound("No such ingest job");
      }
      const retried = ctx.durableIngest.retry(id);
      if (!retried) {
        throw httpError.badRequest("Job is not in a retryable state");
      }
      return ingest.RetryJobResponse.parse({ retried });
    },
  );

  // Bulk dead-letter controls (#98) so a user can unstick or clear the failed
  // pile from the Health tab without inspecting jobs one by one. Distinct path
  // prefix from `jobs/:id` so "dead-letter" isn't captured as an :id param.
  app.post(
    "/api/ingest/dead-letter/retry",
    {
      schema: routeSchema({
        tags,
        summary: "Retry all dead-letter ingest jobs",
        response: ingest.RetryDeadLetterResponse,
        // Exposed over MCP: bulk re-pump the dead-letter pile (idempotent).
        mcp: { expose: true, name: "ingest_dead_letter_retry", safety: "write" },
      }),
    },
    async () =>
      ingest.RetryDeadLetterResponse.parse({ retried: ctx.durableIngest.retryAllDeadLetter() }),
  );

  app.post(
    "/api/ingest/dead-letter/clear",
    {
      schema: routeSchema({
        tags,
        summary: "Clear (discard) all dead-letter ingest jobs",
        response: ingest.ClearDeadLetterResponse,
        // Destructive: discards failed jobs irreversibly — recorded but never auto-exposed.
        mcp: { expose: true, safety: "destructive" },
      }),
    },
    async () =>
      ingest.ClearDeadLetterResponse.parse({ cleared: ctx.durableIngest.clearDeadLetter() }),
  );

  // Per-job controls (#98): cancel removes a single non-processing job; rebuild
  // re-extracts a source from its stored revision; pause/resume gate the executor.
  app.post<{ Params: { id: string } }>(
    "/api/ingest/jobs/:id/cancel",
    {
      schema: routeSchema({
        tags,
        summary: "Cancel a single ingest job",
        params: ingest.CancelJobParams,
        response: ingest.CancelJobResponse,
        // Exposed over MCP: remove a single non-processing queued job (re-enqueueable).
        mcp: { expose: true, name: "ingest_job_cancel", safety: "write" },
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(ingest.CancelJobParams, request.params, "params");
      if (!ctx.store.getIngestJob(id)) {
        throw httpError.notFound("No such ingest job");
      }
      const cancelled = ctx.durableIngest.cancel(id);
      if (!cancelled) {
        throw httpError.badRequest("Job is processing and can't be cancelled");
      }
      return ingest.CancelJobResponse.parse({ cancelled });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/ingest/sources/:id/rebuild",
    {
      schema: routeSchema({
        tags,
        summary: "Rebuild (re-extract) a source",
        params: ingest.RebuildSourceParams,
        response: ingest.RebuildSourceResponse,
        // Exposed over MCP: re-extract a source from its stored revision (no re-read).
        mcp: { expose: true, name: "ingest_source_rebuild", safety: "write" },
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(ingest.RebuildSourceParams, request.params, "params");
      if (!ctx.store.getSource(id)) {
        throw httpError.notFound("No such source");
      }
      return ingest.RebuildSourceResponse.parse({ jobId: ctx.durableIngest.rebuildSource(id) });
    },
  );

  app.post(
    "/api/ingest/pause",
    {
      schema: routeSchema({
        tags,
        summary: "Pause ingest processing",
        response: ingest.PauseResponse,
        // Exposed over MCP: gate the executor (reversible via resume).
        mcp: { expose: true, name: "ingest_pause", safety: "write" },
      }),
    },
    async () => {
      ctx.durableIngest.pause();
      return ingest.PauseResponse.parse({ paused: true });
    },
  );

  app.post(
    "/api/ingest/resume",
    {
      schema: routeSchema({
        tags,
        summary: "Resume ingest processing",
        response: ingest.PauseResponse,
        // Exposed over MCP: re-enable the executor (reversible via pause).
        mcp: { expose: true, name: "ingest_resume", safety: "write" },
      }),
    },
    async () => {
      ctx.durableIngest.resume();
      return ingest.PauseResponse.parse({ paused: false });
    },
  );

  // What a single document created/changed in the wiki: its commits, each
  // scoped (via path filtering) to just this document's pages, with the diff.
  app.get<{ Params: { id: string } }>(
    "/api/sources/:id/diff",
    {
      schema: routeSchema({
        tags,
        summary: "Wiki diff for a source document",
        params: ingest.SourceDiffParams,
        response: ingest.SourceDiffResponse,
        // Exposed over MCP so an agent can see what a document changed in the wiki.
        mcp: { expose: true, name: "sources_diff", safety: "read" },
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(ingest.SourceDiffParams, request.params, "params");
      const source = ctx.store.getSource(id);
      if (!source) {
        throw httpError.notFound("No such document");
      }

      // Group this source's recorded file changes by the commit they landed in,
      // preserving newest-first order from the store query.
      const rows = ctx.store.sourceChanges(id);
      const byCommit = new Map<
        string,
        { hash: string; subject: string; committedAt: string; files: typeof rows }
      >();
      for (const row of rows) {
        const entry = byCommit.get(row.hash) ?? {
          hash: row.hash,
          subject: row.subject,
          committedAt: row.committedAt,
          files: [] as typeof rows,
        };
        entry.files.push(row);
        byCommit.set(row.hash, entry);
      }

      const commits = [];
      for (const entry of byCommit.values()) {
        const paths = entry.files.map((f) => f.filePath);
        const detail = await ctx.git.show(entry.hash, paths).catch(() => null);
        commits.push({
          hash: entry.hash,
          subject: entry.subject,
          committedAt: entry.committedAt,
          files: entry.files.map((f) => ({
            path: f.filePath,
            kind: f.kind,
            entityName: f.entityName,
            entitySlug: f.entitySlug,
          })),
          patch: detail?.patch ?? "",
        });
      }

      return ingest.SourceDiffResponse.parse({ source, commits });
    },
  );
}
