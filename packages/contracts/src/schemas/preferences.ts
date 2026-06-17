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

export const EntityTypeTogglesSchema = z.record(EntityTypeSchema, z.boolean());
export const ObservationKindTogglesSchema = z.record(ObservationKindSchema, z.boolean());

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
