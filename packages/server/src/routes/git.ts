import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

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

  app.post("/api/settings/git/init", async (_request, reply) => {
    try {
      return await ctx.git.init();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Body: { url?: string } }>("/api/settings/git/remote", async (request, reply) => {
    const url = request.body?.url?.trim();
    if (!url) {
      return reply.code(400).send({ error: "Field 'url' is required" });
    }
    try {
      await ctx.git.setRemote(url);
      return await ctx.git.status();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Body: { enabled?: boolean } }>("/api/settings/git/auto", async (request, reply) => {
    if (typeof request.body?.enabled !== "boolean") {
      return reply.code(400).send({ error: "Field 'enabled' must be a boolean" });
    }
    ctx.store.setSetting("git", { autoSync: request.body.enabled });
    return { autoSync: request.body.enabled };
  });

  app.post("/api/settings/git/sync", async (_request, reply) => {
    try {
      return await ctx.git.sync();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
