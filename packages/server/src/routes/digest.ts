import { digest as digestSchema } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import { applyResolution, proposeResolution } from "@meos/core";
import { commitWikiChanges, runConsolidationJob, type AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["digest"];

export function registerDigestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/digest/latest",
    {
      schema: routeSchema({
        tags,
        summary: "Latest digest",
        response: digestSchema.DigestResponse,
      }),
    },
    async () => {
      const digest = ctx.store.latestDigest();
      if (!digest) {
        throw httpError.notFound("No digest generated yet");
      }
      return digestSchema.DigestResponse.parse(digest);
    },
  );

  app.post(
    "/api/jobs/consolidate",
    {
      schema: routeSchema({
        tags,
        summary: "Run consolidation job",
        response: { 202: digestSchema.ConsolidateResponse },
      }),
    },
    async (_request, reply) => {
      // Consolidation merges into the graph, so when the runtime is split it must
      // run in the single writer process: the app forwards it to the worker host.
      // Single-process (and the worker itself) runs it on the local queue.
      if (ctx.role === "app") {
        ctx.workerBridge?.forwardConsolidate();
      } else {
        ctx.queue.push(() => runConsolidationJob(ctx), { exclusive: true });
      }
      return reply.code(202).send(digestSchema.ConsolidateResponse.parse({ started: true }));
    },
  );

  // Each open contradiction carries a proposed resolution (recency / source
  // authority / confidence / corroboration) the user can accept or override.
  app.get(
    "/api/contradictions",
    {
      schema: routeSchema({
        tags,
        summary: "List unresolved contradictions",
        response: digestSchema.ContradictionsResponse,
      }),
    },
    async () =>
      digestSchema.ContradictionsResponse.parse({
        contradictions: ctx.store.unresolvedContradictions().map((c) => ({
          ...c,
          proposal: proposeResolution(ctx.store, c.id),
        })),
      }),
  );

  // Governance: the append-only audit trail of automated memory operations.
  app.get<{ Querystring: { limit?: string } }>(
    "/api/audit",
    {
      schema: routeSchema({
        tags,
        summary: "Recent audit log",
        querystring: digestSchema.AuditQuery,
        response: digestSchema.AuditResponse,
      }),
    },
    async (request) => {
      const { limit } = parseOrThrow(digestSchema.AuditQuery, request.query, "query");
      return digestSchema.AuditResponse.parse({ entries: ctx.store.recentAudit(limit ?? 100) });
    },
  );

  app.post<{ Params: { id: string }; Body: { action?: string } }>(
    "/api/contradictions/:id/resolve",
    {
      schema: routeSchema({
        tags,
        summary: "Resolve a contradiction",
        params: digestSchema.ResolveContradictionParams,
        body: digestSchema.ResolveContradictionBody,
        response: digestSchema.ResolveContradictionResponse,
      }),
    },
    async (request, reply) => {
      const { id } = parseOrThrow(
        digestSchema.ResolveContradictionParams,
        request.params,
        "params",
      );
      const { action } = parseOrThrow(digestSchema.ResolveContradictionBody, request.body, "body");
      if (!applyResolution(ctx.store, id, action)) {
        throw httpError.notFound("No such open contradiction");
      }
      // The resolution may have retired a claim; refresh the affected page.
      ctx.queue.push(async () => {
        const changes = await ctx.wiki.regenerateStale();
        await commitWikiChanges(ctx, changes, "Contradiction resolved");
      });
      return reply.send(digestSchema.ResolveContradictionResponse.parse({ resolved: true }));
    },
  );
}
