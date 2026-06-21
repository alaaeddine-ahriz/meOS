import { git as gitSchema } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import type { GitStatus } from "../git.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["git"];

interface GitPrefs {
  /** Commit and push automatically after the nightly consolidation pass. */
  autoSync: boolean;
}

function prefs(ctx: AppContext): GitPrefs {
  return { autoSync: false, ...ctx.store.getSetting<GitPrefs>("git") };
}

/** Fold the `autoSync` preference into a raw GitStatus and validate the public shape. */
function statusResponse(ctx: AppContext, status: GitStatus): gitSchema.GitStatus {
  return gitSchema.GitStatusSchema.parse({ ...status, autoSync: prefs(ctx).autoSync });
}

export function registerGitRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/settings/git",
    { schema: routeSchema({ tags, summary: "Git status", response: gitSchema.GitStatusSchema }) },
    async () => statusResponse(ctx, await ctx.git.status()),
  );

  app.post(
    "/api/settings/git/init",
    {
      schema: routeSchema({
        tags,
        summary: "Initialize git repo",
        response: gitSchema.GitStatusSchema,
      }),
    },
    async () => {
      try {
        // ctx.git.init() returns the raw GitStatus; statusResponse folds in the
        // `autoSync` preference so the response satisfies the public contract.
        return statusResponse(ctx, await ctx.git.init());
      } catch (error) {
        throw httpError.badRequest(error instanceof Error ? error.message : String(error));
      }
    },
  );

  app.put<{ Body: { url?: string } }>(
    "/api/settings/git/remote",
    {
      schema: routeSchema({
        tags,
        summary: "Set git remote",
        body: gitSchema.SetGitRemoteBody,
        response: gitSchema.GitStatusSchema,
      }),
    },
    async (request) => {
      const { url } = parseOrThrow(gitSchema.SetGitRemoteBody, request.body, "body");
      const trimmed = url.trim();
      if (!trimmed) throw httpError.validation("Field 'url' is required");
      try {
        await ctx.git.setRemote(trimmed);
        return statusResponse(ctx, await ctx.git.status());
      } catch (error) {
        throw httpError.badRequest(error instanceof Error ? error.message : String(error));
      }
    },
  );

  app.put<{ Body: { enabled?: boolean } }>(
    "/api/settings/git/auto",
    {
      schema: routeSchema({
        tags,
        summary: "Toggle git auto-sync",
        body: gitSchema.SetGitAutoBody,
        response: gitSchema.GitAutoResponse,
      }),
    },
    async (request) => {
      const { enabled } = parseOrThrow(gitSchema.SetGitAutoBody, request.body, "body");
      ctx.store.setSetting("git", { autoSync: enabled });
      return gitSchema.GitAutoResponse.parse({ autoSync: enabled });
    },
  );

  app.post(
    "/api/settings/git/sync",
    {
      schema: routeSchema({ tags, summary: "Sync git repo", response: gitSchema.GitStatusSchema }),
    },
    async () => {
      try {
        return statusResponse(ctx, await ctx.git.sync());
      } catch (error) {
        throw httpError.badRequest(error instanceof Error ? error.message : String(error));
      }
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/settings/git/log",
    {
      schema: routeSchema({
        tags,
        summary: "Git commit log",
        querystring: gitSchema.GitLogQuery,
        response: gitSchema.GitLogResponse,
      }),
    },
    async (request) => {
      const { limit } = parseOrThrow(gitSchema.GitLogQuery, request.query, "query");
      const bounded = Math.min(Math.max(limit ?? 50, 1), 200);
      return gitSchema.GitLogResponse.parse({ commits: await ctx.git.log(bounded) });
    },
  );

  app.get<{ Params: { hash: string } }>(
    "/api/settings/git/commit/:hash",
    {
      schema: routeSchema({
        tags,
        summary: "Git commit detail",
        params: gitSchema.GitCommitParams,
        response: gitSchema.GitCommitDetailSchema,
      }),
    },
    async (request) => {
      const { hash } = parseOrThrow(gitSchema.GitCommitParams, request.params, "params");
      try {
        return gitSchema.GitCommitDetailSchema.parse(await ctx.git.show(hash));
      } catch (error) {
        throw httpError.notFound(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
