import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerIngestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/ingest/upload", async (request, reply) => {
    const accepted: Array<{ inboxItemId: number; filename: string }> = [];
    for await (const part of request.files()) {
      const buffer = await part.toBuffer();
      const filename = part.filename;
      const inboxItemId = ctx.store.createInboxItem(filename);
      ctx.queue.push(() =>
        ctx.pipeline
          .ingest({ kind: "file", filename, buffer, origin: "upload" }, inboxItemId)
          .then(() => undefined),
      );
      accepted.push({ inboxItemId, filename });
    }
    if (accepted.length === 0) {
      return reply.code(400).send({ error: "No files in request" });
    }
    return reply.code(202).send({ accepted });
  });

  app.post<{ Body: { title?: string; text: string } }>("/api/ingest/text", async (request, reply) => {
    const { title, text } = request.body ?? {};
    if (!text?.trim()) {
      return reply.code(400).send({ error: "Field 'text' is required" });
    }
    const resolvedTitle = title?.trim() || `Note ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const inboxItemId = ctx.store.createInboxItem(resolvedTitle);
    ctx.queue.push(() =>
      ctx.pipeline
        .ingest({ kind: "text", title: resolvedTitle, text, origin: "quick-capture" }, inboxItemId)
        .then(() => undefined),
    );
    return reply.code(202).send({ inboxItemId });
  });

  app.get("/api/inbox", async () => ({
    queuePending: ctx.queue.pending,
    items: ctx.store.listInbox(),
  }));

  // What a single document created/changed in the wiki: its commits, each
  // scoped (via path filtering) to just this document's pages, with the diff.
  app.get<{ Params: { id: string } }>("/api/sources/:id/diff", async (request, reply) => {
    const id = Number(request.params.id);
    const source = Number.isInteger(id) ? ctx.store.getSource(id) : undefined;
    if (!source) {
      return reply.code(404).send({ error: "No such document" });
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
