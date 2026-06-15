import { z } from "zod";
import { NumericIdParam } from "./common.js";

/** GET /api/digest/latest */
export const DigestResponse = z.object({
  date: z.string(),
  content: z.string(),
});

/** POST /api/jobs/consolidate */
export const ConsolidateResponse = z.object({ started: z.boolean() });

/** Resolution actions for a contradiction. */
export const ResolutionActionSchema = z.enum([
  "supersede_a",
  "supersede_b",
  "keep_both",
  "context_specific",
]);

export const ContradictionProposalSchema = z.object({
  suggested: ResolutionActionSchema,
  rationale: z.string(),
  margin: z.number(),
});

export const ContradictionSchema = z.object({
  id: z.number(),
  note: z.string().nullable(),
  entity_name: z.string(),
  text_a: z.string(),
  text_b: z.string(),
  created_at: z.string(),
  proposal: ContradictionProposalSchema.optional(),
});

/** GET /api/contradictions */
export const ContradictionsResponse = z.object({ contradictions: z.array(ContradictionSchema) });

/** POST /api/contradictions/:id/resolve */
export const ResolveContradictionParams = NumericIdParam;
export const ResolveContradictionBody = z.object({ action: ResolutionActionSchema });
export const ResolveContradictionResponse = z.object({ resolved: z.boolean() });

/** GET /api/audit */
export const AuditQuery = z.object({ limit: z.coerce.number().int().positive().optional() });
export const AuditEntrySchema = z.object({
  id: z.number(),
  op: z.string(),
  detail: z.string().nullable(),
  created_at: z.string(),
});
export const AuditResponse = z.object({ entries: z.array(AuditEntrySchema) });

export type ResolutionAction = z.infer<typeof ResolutionActionSchema>;
export type Contradiction = z.infer<typeof ContradictionSchema>;
export type ContradictionProposal = z.infer<typeof ContradictionProposalSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
