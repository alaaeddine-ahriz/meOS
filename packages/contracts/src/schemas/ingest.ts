import { z } from "zod";
import { NumericIdParam, SourceRefSchema } from "./common.js";

/** POST /api/ingest/upload (multipart; response only) */
export const UploadAcceptedSchema = z.object({
  inboxItemId: z.number(),
  filename: z.string(),
});
export const UploadResponse = z.object({ accepted: z.array(UploadAcceptedSchema) });

/** GET /api/inbox */
export const InboxItemSchema = z.object({
  id: z.number(),
  /** The ingested document, once parsing has created one. Null while queued. */
  source_id: z.number().nullable(),
  title: z.string(),
  status: z.string(),
  detail: z.string().nullable(),
  /** Absolute path for watched files; null for uploads and pasted text. */
  path: z.string().nullable(),
  /** How many times this file has been ingested; > 1 means it changed and was re-read. */
  revision: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const InboxResponse = z.object({
  queuePending: z.number(),
  items: z.array(InboxItemSchema),
});

/** GET /api/sources/:id/diff */
export const SourceDiffParams = NumericIdParam;

export const DiffFileSchema = z.object({
  path: z.string(),
  kind: z.enum(["created", "updated"]),
  entityName: z.string().nullable(),
  entitySlug: z.string().nullable(),
});

export const SourceDiffResponse = z.object({
  source: SourceRefSchema,
  commits: z.array(
    z.object({
      hash: z.string(),
      subject: z.string(),
      committedAt: z.string(),
      files: z.array(DiffFileSchema),
      patch: z.string(),
    }),
  ),
});

export type InboxItem = z.infer<typeof InboxItemSchema>;
export type SourceDiff = z.infer<typeof SourceDiffResponse>;
export type DiffFile = z.infer<typeof DiffFileSchema>;
