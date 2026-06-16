import { vault } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["vault"];

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

  app.get(
    "/api/vault",
    {
      schema: routeSchema({ tags, summary: "List vault notes", response: vault.ListNotesResponse }),
    },
    async () => vault.ListNotesResponse.parse({ notes: ctx.vault.list() }),
  );

  app.get<{ Querystring: { path?: string } }>(
    "/api/vault/note",
    {
      schema: routeSchema({
        tags,
        summary: "Read a note",
        querystring: vault.NotePathQuery,
        response: vault.NoteContentsSchema,
      }),
    },
    async (request) => {
      const { path: relPath } = parseOrThrow(vault.NotePathQuery, request.query, "query");
      try {
        return vault.NoteContentsSchema.parse(ctx.vault.read(relPath));
      } catch {
        throw httpError.notFound("No such note");
      }
    },
  );

  // Create an empty, titled note. 409 if the path is already taken so the UI
  // can fall back to opening the existing note instead of clobbering it.
  app.post<{ Body: { path?: string } }>(
    "/api/vault/note",
    {
      schema: routeSchema({
        tags,
        summary: "Create a note",
        body: vault.CreateNoteBody,
        response: { 201: vault.NoteMetaSchema },
      }),
    },
    async (request, reply) => {
      const { path: relPath } = parseOrThrow(vault.CreateNoteBody, request.body, "body");
      try {
        const note = ctx.vault.create(relPath);
        commit([note.path], `notes: create ${note.title}`);
        return reply.code(201).send(vault.NoteMetaSchema.parse(note));
      } catch (error) {
        throw httpError.badRequest(
          error instanceof Error ? error.message : "Could not create note",
        );
      }
    },
  );

  app.put<{ Body: { path?: string; markdown?: string } }>(
    "/api/vault/note",
    {
      schema: routeSchema({
        tags,
        summary: "Save a note",
        body: vault.SaveNoteBody,
        response: vault.NoteMetaSchema,
      }),
    },
    async (request) => {
      const { path: relPath, markdown } = parseOrThrow(vault.SaveNoteBody, request.body, "body");
      try {
        const note = ctx.vault.write(relPath, markdown);
        commit([note.path], `notes: edit ${note.title}`);
        return vault.NoteMetaSchema.parse(note);
      } catch (error) {
        throw httpError.badRequest(error instanceof Error ? error.message : "Could not save note");
      }
    },
  );

  app.delete<{ Querystring: { path?: string } }>(
    "/api/vault/note",
    {
      schema: routeSchema({
        tags,
        summary: "Delete a note",
        querystring: vault.NotePathQuery,
        response: vault.DeleteNoteResponse,
      }),
    },
    async (request) => {
      const { path: relPath } = parseOrThrow(vault.NotePathQuery, request.query, "query");
      try {
        ctx.vault.remove(relPath);
        commit([relPath], `notes: delete ${relPath}`);
        return vault.DeleteNoteResponse.parse({ deleted: true });
      } catch (error) {
        throw httpError.badRequest(
          error instanceof Error ? error.message : "Could not delete note",
        );
      }
    },
  );

  app.post<{ Body: { from?: string; to?: string } }>(
    "/api/vault/note/rename",
    {
      schema: routeSchema({
        tags,
        summary: "Rename a note",
        body: vault.RenameNoteBody,
        response: vault.NoteMetaSchema,
      }),
    },
    async (request) => {
      const { from, to } = parseOrThrow(vault.RenameNoteBody, request.body, "body");
      try {
        const note = ctx.vault.rename(from, to);
        commit([from, note.path], `notes: rename ${from} → ${note.path}`);
        return vault.NoteMetaSchema.parse(note);
      } catch (error) {
        throw httpError.badRequest(
          error instanceof Error ? error.message : "Could not rename note",
        );
      }
    },
  );
}
