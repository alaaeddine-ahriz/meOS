import { z } from "zod";

export const NoteMetaSchema = z.object({
  path: z.string(),
  title: z.string(),
  updatedAt: z.string(),
});

export const NoteContentsSchema = NoteMetaSchema.extend({
  markdown: z.string(),
  backlinks: z.array(NoteMetaSchema),
});

/** GET /api/vault */
export const ListNotesResponse = z.object({ notes: z.array(NoteMetaSchema) });

/** GET /api/vault/note?path= , DELETE /api/vault/note?path= */
export const NotePathQuery = z.object({ path: z.string().min(1) });

/** POST /api/vault/note */
export const CreateNoteBody = z.object({ path: z.string().min(1) });

/** PUT /api/vault/note */
export const SaveNoteBody = z.object({
  path: z.string().min(1),
  markdown: z.string(),
});

/** POST /api/vault/note/rename */
export const RenameNoteBody = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export const DeleteNoteResponse = z.object({ deleted: z.boolean() });

export type NoteMeta = z.infer<typeof NoteMetaSchema>;
export type NoteContents = z.infer<typeof NoteContentsSchema>;
