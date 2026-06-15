import { z } from "zod";

export const GitStatusSchema = z.object({
  initialized: z.boolean(),
  branch: z.string().nullable(),
  remote: z.string().nullable(),
  dirty: z.number(),
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
  lastCommit: z.string().nullable(),
  autoSync: z.boolean(),
});

export const GitCommitSchema = z.object({
  hash: z.string(),
  subject: z.string(),
  body: z.string(),
  relativeDate: z.string(),
  files: z.number(),
});

export const GitCommitDetailSchema = z.object({
  hash: z.string(),
  subject: z.string(),
  body: z.string(),
  patch: z.string(),
});

/** PUT /api/settings/git/remote */
export const SetGitRemoteBody = z.object({ url: z.string().min(1) });

/** PUT /api/settings/git/auto */
export const SetGitAutoBody = z.object({ enabled: z.boolean() });
export const GitAutoResponse = z.object({ autoSync: z.boolean() });

/** GET /api/settings/git/log?limit= */
export const GitLogQuery = z.object({ limit: z.coerce.number().int().positive().optional() });
export const GitLogResponse = z.object({ commits: z.array(GitCommitSchema) });

/** GET /api/settings/git/commit/:hash */
export const GitCommitParams = z.object({ hash: z.string().min(1) });

export type GitStatus = z.infer<typeof GitStatusSchema>;
export type GitCommit = z.infer<typeof GitCommitSchema>;
export type GitCommitDetail = z.infer<typeof GitCommitDetailSchema>;
