import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/settings/folders", async () => ({
    folders: ctx.store.listWatchedFolders(),
  }));

  app.post<{ Body: { path?: string } }>("/api/settings/folders", async (request, reply) => {
    const raw = request.body?.path?.trim();
    if (!raw) {
      return reply.code(400).send({ error: "Field 'path' is required" });
    }
    const folderPath = path.resolve(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(folderPath);
    } catch {
      return reply.code(400).send({ error: `Folder not found: ${folderPath}` });
    }
    if (!stat.isDirectory()) {
      return reply.code(400).send({ error: `Not a folder: ${folderPath}` });
    }

    const folder = ctx.store.addWatchedFolder(folderPath);
    ctx.watcher.addFolder(folderPath);
    return reply.code(201).send({ folder });
  });

  app.delete<{ Params: { id: string } }>("/api/settings/folders/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const removedPath = Number.isInteger(id) ? ctx.store.removeWatchedFolder(id) : undefined;
    if (!removedPath) {
      return reply.code(404).send({ error: "No such folder" });
    }
    ctx.watcher.removeFolder(removedPath);
    return { removed: true };
  });
}
