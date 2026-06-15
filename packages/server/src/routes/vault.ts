import { vault } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";

/**
 * The user's note vault: free-form markdown the user writes by hand, stored
 * under `<dataDir>/vault` and cross-linked with `[[wiki-links]]`. Edits are
 * committed locally (best-effort) so they ride the same Settings → Sync path
 * as the wiki; a failed commit never fails the save.
 */
export function registerVaultRoutes(app: FastifyInstance, ctx: AppContext): void {
  const commit = (paths: string[], message: string): void => {
    ctx.git
      .commitPaths(
        paths.map((p) => `vault/${p}`),
        message,
      )
      .catch((error) => {
        app.log.warn({ error: String(error) }, "vault commit failed");
      });
  };

  app.get("/api/vault", async () => ({ notes: ctx.vault.list() }));

  app.get<{ Querystring: { path?: string } }>("/api/vault/note", async (request) => {
    const { path: relPath } = parseOrThrow(vault.NotePathQuery, request.query, "query");
    try {
      return ctx.vault.read(relPath);
    } catch {
      throw httpError.notFound("No such note");
    }
  });

  // Create an empty, titled note. 409 if the path is already taken so the UI
  // can fall back to opening the existing note instead of clobbering it.
  app.post<{ Body: { path?: string } }>("/api/vault/note", async (request, reply) => {
    const { path: relPath } = parseOrThrow(vault.CreateNoteBody, request.body, "body");
    try {
      const note = ctx.vault.create(relPath);
      commit([note.path], `notes: create ${note.title}`);
      return reply.code(201).send(note);
    } catch (error) {
      throw httpError.badRequest(error instanceof Error ? error.message : "Could not create note");
    }
  });

  app.put<{ Body: { path?: string; markdown?: string } }>("/api/vault/note", async (request) => {
    const { path: relPath, markdown } = parseOrThrow(vault.SaveNoteBody, request.body, "body");
    try {
      const note = ctx.vault.write(relPath, markdown);
      commit([note.path], `notes: edit ${note.title}`);
      return note;
    } catch (error) {
      throw httpError.badRequest(error instanceof Error ? error.message : "Could not save note");
    }
  });

  app.delete<{ Querystring: { path?: string } }>("/api/vault/note", async (request) => {
    const { path: relPath } = parseOrThrow(vault.NotePathQuery, request.query, "query");
    try {
      ctx.vault.remove(relPath);
      commit([relPath], `notes: delete ${relPath}`);
      return { deleted: true };
    } catch (error) {
      throw httpError.badRequest(error instanceof Error ? error.message : "Could not delete note");
    }
  });

  app.post<{ Body: { from?: string; to?: string } }>("/api/vault/note/rename", async (request) => {
    const { from, to } = parseOrThrow(vault.RenameNoteBody, request.body, "body");
    try {
      const note = ctx.vault.rename(from, to);
      commit([from, note.path], `notes: rename ${from} → ${note.path}`);
      return note;
    } catch (error) {
      throw httpError.badRequest(error instanceof Error ? error.message : "Could not rename note");
    }
  });
}
