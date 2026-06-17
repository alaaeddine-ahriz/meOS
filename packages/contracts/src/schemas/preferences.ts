import { z } from "zod";

/**
 * Knowledge preferences (#86) — the shared contract for which canonical entity
 * types and observation kinds MeOS focuses on. Mirrors the core model; the enum
 * key lists are fixed (we never widen the canonical types/kinds here).
 */

/** The six canonical entity types. */
export const EntityTypeSchema = z.enum([
  "person",
  "project",
  "organisation",
  "concept",
  "place",
  "decision",
]);

/** The nine canonical observation kinds. */
export const ObservationKindSchema = z.enum([
  "fact",
  "decision",
  "requirement",
  "preference",
  "task",
  "event",
  "risk",
  "open_question",
  "procedure",
]);

/** Named presets, plus "custom" for a user-tweaked toggle set. */
export const KnowledgePresetSchema = z.enum([
  "default",
  "consultant",
  "executive",
  "personal",
  "research",
  "custom",
]);

// NOTE: these are explicit object schemas (one boolean per fixed key) rather
// than `z.record(EnumSchema, z.boolean())`. An enum-keyed record makes Zod v4
// emit a JSON Schema with `additionalProperties` + `required` but no
// `properties`, which Fastify's response serializer (fast-json-stringify) turns
// into malformed JSON (`{,"person":true,...}` — a stray leading comma that
// fails JSON.parse on the client). Explicit `properties` serialize correctly.
// Keep these keys in sync with EntityTypeSchema / ObservationKindSchema above.
export const EntityTypeTogglesSchema = z.object({
  person: z.boolean(),
  project: z.boolean(),
  organisation: z.boolean(),
  concept: z.boolean(),
  place: z.boolean(),
  decision: z.boolean(),
});
export const ObservationKindTogglesSchema = z.object({
  fact: z.boolean(),
  decision: z.boolean(),
  requirement: z.boolean(),
  preference: z.boolean(),
  task: z.boolean(),
  event: z.boolean(),
  risk: z.boolean(),
  open_question: z.boolean(),
  procedure: z.boolean(),
});

/** GET /api/settings/knowledge — the resolved, complete preference value. */
export const KnowledgePreferencesSchema = z.object({
  preset: KnowledgePresetSchema,
  entityTypes: EntityTypeTogglesSchema,
  observationKinds: ObservationKindTogglesSchema,
});

/**
 * PUT /api/settings/knowledge — a partial update. The server resolves/normalises
 * it (filling unknown keys as enabled) before persisting, so all fields are
 * optional here.
 */
export const UpdateKnowledgePreferencesBody = z.object({
  preset: KnowledgePresetSchema.optional(),
  entityTypes: EntityTypeTogglesSchema.optional(),
  observationKinds: ObservationKindTogglesSchema.optional(),
});

export type EntityTypeName = z.infer<typeof EntityTypeSchema>;
export type ObservationKindName = z.infer<typeof ObservationKindSchema>;
export type KnowledgePreset = z.infer<typeof KnowledgePresetSchema>;
export type KnowledgePreferences = z.infer<typeof KnowledgePreferencesSchema>;
