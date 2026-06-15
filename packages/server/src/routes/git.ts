import { git as gitSchema } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";

interface GitPrefs {
  /** Commit and push automatically after the nightly consolidation pass. */
  autoSync: boolean;
}

function prefs(ctx: AppContext): GitPrefs {
  return { autoSync: false, ...ctx.store.getSetting<GitPrefs>("git") };
}

export function registerGitRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/settings/git", async () => ({
    ...(await ctx.git.status()),
    autoSync: prefs(ctx).autoSync,
  }));

  app.post("/api/settings/git/init", async () => {
    try {
      return await ctx.git.init();
    } catch (error) {
      throw httpError.badRequest(error instanceof Error ? error.message : String(error));
    }
  });

  app.put<{ Body: { url?: string } }>("/api/settings/git/remote", async (request) => {
    const { url } = parseOrThrow(gitSchema.SetGitRemoteBody, request.body, "body");
    const trimmed = url.trim();
    if (!trimmed) throw httpError.validation("Field 'url' is required");
    try {
      await ctx.git.setRemote(trimmed);
      return await ctx.git.status();
    } catch (error) {
      throw httpError.badRequest(error instanceof Error ? error.message : String(error));
    }
  });

  app.put<{ Body: { enabled?: boolean } }>("/api/settings/git/auto", async (request) => {
    const { enabled } = parseOrThrow(gitSchema.SetGitAutoBody, request.body, "body");
    ctx.store.setSetting("git", { autoSync: enabled });
    return { autoSync: enabled };
  });

  app.post("/api/settings/git/sync", async () => {
    try {
      return await ctx.git.sync();
    } catch (error) {
      throw httpError.badRequest(error instanceof Error ? error.message : String(error));
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/settings/git/log", async (request) => {
    const { limit } = parseOrThrow(gitSchema.GitLogQuery, request.query, "query");
    const bounded = Math.min(Math.max(limit ?? 50, 1), 200);
    return { commits: await ctx.git.log(bounded) };
  });

  app.get<{ Params: { hash: string } }>("/api/settings/git/commit/:hash", async (request) => {
    const { hash } = parseOrThrow(gitSchema.GitCommitParams, request.params, "params");
    try {
      return await ctx.git.show(hash);
    } catch (error) {
      throw httpError.notFound(error instanceof Error ? error.message : String(error));
    }
  });
}
