import { z } from "zod";

export const entityTypeSchema = z.enum([
  "person",
  "project",
  "organisation",
  "concept",
  "place",
  "decision",
]);

export type EntityType = z.infer<typeof entityTypeSchema>;

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
      entity: z.string(),
      text: z.string(),
    }),
  ),
});

export type Extraction = z.infer<typeof extractionSchema>;
