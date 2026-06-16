import { ingest, staleFacts } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";

export function registerIngestRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Facts now backed only by an outdated source revision (#16): superseded by a
  // newer version, or from a deleted/missing source. The UI flags these so an
  // obsolete claim is visible as such rather than treated as equally current.
  app.get("/api/facts/stale", async () =>
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

  app.post("/api/ingest/upload", async (request, reply) => {
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
    return reply.code(202).send({ accepted });
  });

  app.get("/api/inbox", async () => ({
    queuePending: ctx.queue.pending,
    items: ctx.store.listInbox(),
  }));

  // The durable ingest job ledger (#13): every persisted ingestion unit with its
  // lifecycle state, attempts, and last error — enough to diagnose and retry.
  app.get("/api/ingest/jobs", async () =>
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

  // Manually retry a failed or dead-letter ingest: resets the retry budget and
  // re-pumps the queue. Idempotent stages make the re-run safe; a job that only
  // needs its extraction retried re-runs from the stored revision (no re-read).
  app.post<{ Params: { id: string } }>("/api/ingest/jobs/:id/retry", async (request) => {
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
  });

  // What a single document created/changed in the wiki: its commits, each
  // scoped (via path filtering) to just this document's pages, with the diff.
  app.get<{ Params: { id: string } }>("/api/sources/:id/diff", async (request) => {
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

    return { source, commits };
  });
}
