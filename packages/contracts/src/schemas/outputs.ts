import { z } from "zod";

/** The output modes the knowledge base can be projected into. */
export const OutputModeSchema = z.enum([
  "decision-brief",
  "contradiction-report",
  "timeline",
  "dependency-graph",
  "meeting-brief",
]);

/** GET /api/outputs/:mode?format=&entity= */
export const OutputParams = z.object({ mode: OutputModeSchema });
export const OutputQuery = z.object({
  format: z.enum(["json", "markdown"]).optional(),
  entity: z.string().optional(),
});

/** When ?format=json the body is wrapped; otherwise raw Markdown is returned. */
export const OutputJsonResponse = z.object({ markdown: z.string() });

export type OutputMode = z.infer<typeof OutputModeSchema>;
