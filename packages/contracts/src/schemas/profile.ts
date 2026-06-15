import { z } from "zod";

export const ProfileSectionViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  placeholder: z.string(),
  content: z.string(),
});

export const ProfileDataSchema = z.object({
  sections: z.array(ProfileSectionViewSchema),
  gitSync: z.boolean(),
});

/** A reviewable AI proposal: the full proposed profile keyed by section id + a note. */
export const ProfileProposalSchema = z.object({
  profile: z.record(z.string(), z.string()),
  summary: z.string(),
});

export const ProfileVersionSchema = z.object({
  version: z.string(),
  savedAt: z.string(),
});

/** Path param shared by section routes. */
export const ProfileIdParam = z.object({ id: z.string().min(1) });
export const ProfileIdVersionParam = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
});

/** PUT /api/profile/:id */
export const SaveProfileSectionBody = z.object({ content: z.string().optional() });

/** POST /api/profile/apply */
export const ApplyProfileBody = z.object({ profile: z.record(z.string(), z.string()) });
export const ApplyProfileResponse = ProfileDataSchema.extend({ applied: z.array(z.string()) });

/** POST /api/profile/upload (multipart; response only) */
export const ProfileUploadResponse = z.object({
  proposal: ProfileProposalSchema,
  documents: z.array(z.string()),
});

/** POST /api/profile/draft, /api/profile/draft-from-wiki, /api/profile/edit */
export const ProfileProposalResponse = z.object({ proposal: ProfileProposalSchema });

/** POST /api/profile/edit */
export const EditProfileBody = z.object({
  instruction: z.string().min(1),
  useUploaded: z.boolean().optional(),
});

/** GET /api/profile/:id/history */
export const ProfileHistoryResponse = z.object({ versions: z.array(ProfileVersionSchema) });

/** GET /api/profile/:id/history/:version */
export const ProfileVersionContentResponse = z.object({ content: z.string() });

/** POST /api/profile/:id/restore */
export const RestoreProfileBody = z.object({ version: z.string().min(1) });

/** GET /api/profile/audit */
export const ProfileAuditResponse = z.object({
  entries: z.array(
    z.object({
      id: z.number(),
      op: z.string(),
      detail: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});

/** PUT /api/profile/privacy */
export const ProfilePrivacyBody = z.object({ sync: z.boolean() });
export const ProfilePrivacyResponse = z.object({ gitSync: z.boolean() });

export type ProfileSectionView = z.infer<typeof ProfileSectionViewSchema>;
export type ProfileData = z.infer<typeof ProfileDataSchema>;
export type ProfileProposal = z.infer<typeof ProfileProposalSchema>;
export type ProfileVersion = z.infer<typeof ProfileVersionSchema>;
