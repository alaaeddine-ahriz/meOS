import { z } from "zod";
import { OBSERVATION_KINDS, SENSITIVITY_LEVELS } from "../knowledge/schema-doc.js";

export const entityTypeSchema = z.enum([
  "person",
  "project",
  "organisation",
  "concept",
  "place",
  "decision",
]);

export type EntityType = z.infer<typeof entityTypeSchema>;

export const observationKindSchema = z.enum(OBSERVATION_KINDS);
export const sensitivitySchema = z.enum(SENSITIVITY_LEVELS);

export const extractionSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      type: entityTypeSchema,
      aliases: z.array(z.string()),
      summary: z.string(),
    }),
  ),
  relationships: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      label: z.string(),
    }),
  ),
  observations: z.array(
    z.object({
      /** Exact entity name this claim is about. */
      entity: z.string(),
      /** The atomic claim, third person, self-contained. */
      claim: z.string(),
      /** What kind of claim this is. */
      kind: observationKindSchema,
      /** The exact supporting sentence quoted from the source, for traceability. */
      sourceQuote: z.string().nullable(),
      /** ISO date the claim becomes true, when the source dates it. */
      validFrom: z.string().nullable(),
      /** ISO date the claim stops being true, when the source dates it. */
      validUntil: z.string().nullable(),
      /** Extractor's confidence in the claim, 0..1. */
      confidence: z.number(),
      /** How sensitive the claim is (governs whether it reaches the wiki). */
      sensitivity: sensitivitySchema,
    }),
  ),
});

export type Extraction = z.infer<typeof extractionSchema>;
export type ExtractedObservation = Extraction["observations"][number];
