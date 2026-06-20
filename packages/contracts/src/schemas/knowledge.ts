import { z } from "zod";

/**
 * Granular knowledge writes (native agent intelligence, PR2). The endpoints
 * under `/api/knowledge/*` let a caller — and, via the MCP bridge, a coding
 * agent — write the knowledge base one primitive at a time: upsert an entity,
 * add a single observation (fact) with provenance, add one relationship.
 *
 * Unlike the coarse, source-gated `POST /api/wiki/agent/facts` (which re-validates
 * a whole extraction against verbatim source quotes), these primitives go through
 * the SAME canonical write path the extraction-merge uses — entity resolution,
 * provenance, staleness flagging — but without requiring a fabricated verbatim
 * quote: agent/user-authored writes carry a `manual` provenance instead.
 *
 * Explicit `z.object` throughout — never `z.record` in a RESPONSE schema, which
 * Fastify mis-serialises in this codebase (a record keyed by an enum emits a
 * malformed body). The values below mirror the canonical enums in
 * `@meos/core` (`entityTypeSchema`, `observationKindSchema`, `sensitivitySchema`);
 * the server re-validates against those before writing, so the two cannot drift
 * without a route test failing.
 */

/** Entity kinds, mirroring `@meos/core` `entityTypeSchema`. */
export const KnowledgeEntityType = z.enum([
  "person",
  "project",
  "organisation",
  "concept",
  "place",
  "decision",
]);

/** Observation kinds, mirroring `@meos/core` `OBSERVATION_KINDS`. */
export const KnowledgeObservationKind = z.enum([
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

/** Sensitivity levels, mirroring `@meos/core` `SENSITIVITY_LEVELS`. */
export const KnowledgeSensitivity = z.enum(["normal", "private", "secret"]);

// --- Shared references ------------------------------------------------

/**
 * How an observation/relationship endpoint points at an entity. Either an
 * existing `id` (the certain path) OR a (`type`, `name`) pair the server resolves
 * through the canonical entity-resolution (exact name/alias/slug, then a fuzzy
 * merge) — creating the entity when nothing matches. Exactly one form is
 * required; a request supplying neither (or only a name without a type) is
 * rejected with a validation error.
 */
export const EntityRef = z
  .object({
    /** Resolve directly by entity id (skips name resolution). */
    id: z.number().int().positive().optional(),
    /** Resolve (or create) by name within a type. Requires `type`. */
    name: z.string().min(1).optional(),
    /** The entity's type; required whenever resolving by `name`. */
    type: KnowledgeEntityType.optional(),
  })
  .refine((ref) => ref.id !== undefined || (!!ref.name && !!ref.type), {
    message: "Provide an entity `id`, or both `name` and `type`.",
  });

/**
 * Where a granular write comes from. `manual` is the user/agent-authored default:
 * no real ingested source, no verbatim-quote gate — the optional `quote` is free
 * text kept only for display. `source` ties the write to an existing ingested
 * source by `sourceId`, reusing the merge's provenance (char spans, stale-source
 * credit); `quote`, when given, is located within that source's text.
 */
export const Provenance = z
  .object({
    kind: z.enum(["manual", "source"]).default("manual"),
    /** Required when `kind` is `source`: the existing source this claim came from. */
    sourceId: z.number().int().positive().optional(),
    /** Supporting text. Free-form for `manual`; located in the source for `source`. */
    quote: z.string().nullable().optional(),
  })
  .refine((p) => p.kind !== "source" || p.sourceId !== undefined, {
    message: "`provenance.sourceId` is required when `provenance.kind` is 'source'.",
  });

// --- POST /api/knowledge/entities -------------------------------------

/** Upsert an entity: resolve by (type, name) to an existing one, else create. */
export const UpsertEntityBody = z.object({
  type: KnowledgeEntityType,
  name: z.string().min(1),
  /** Optional one-line summary; sets/overwrites the entity's summary when present. */
  summary: z.string().optional(),
  /** Extra surface forms folded in as aliases so future writes resolve here. */
  aliases: z.array(z.string().min(1)).optional(),
});

export const UpsertEntityResponse = z.object({
  id: z.number(),
  slug: z.string(),
  /** True when this request created the entity; false when it resolved to one. */
  created: z.boolean(),
});

// --- POST /api/knowledge/observations ---------------------------------

/** Add a single observation (fact/claim) about an entity, with provenance. */
export const AddObservationBody = z.object({
  /** Which entity the claim is about (by id, or type+name). */
  entity: EntityRef,
  /** The atomic claim. Either this or (`predicate` + `object`) must be present. */
  text: z.string().min(1).optional(),
  /** Subject-less predicate, e.g. "works at"; combined with `object` to form text. */
  predicate: z.string().min(1).optional(),
  /** Object of the predicate, e.g. "Acme"; combined with `predicate` to form text. */
  object: z.string().min(1).optional(),
  /** What kind of claim this is; defaults to `fact`. */
  kind: KnowledgeObservationKind.default("fact"),
  /** Caller's confidence, 0..1; scaled by source quality before storage. */
  confidence: z.number().min(0).max(1).optional(),
  /** How sensitive the claim is; a detected credential always escalates this. */
  sensitivity: KnowledgeSensitivity.optional(),
  /** ISO date the claim becomes true, when known. */
  validFrom: z.string().nullable().optional(),
  /** ISO date the claim stops being true, when known. */
  validUntil: z.string().nullable().optional(),
  /** Where the claim comes from; defaults to a `manual` (agent/user) write. */
  provenance: Provenance.optional(),
});

export const AddObservationResponse = z.object({
  /** The new (or reinforced existing) observation row id. */
  observationId: z.number(),
  /** The resolved entity id the claim was attached to. */
  entityId: z.number(),
  /** True when a new observation was inserted; false when it reinforced a near-duplicate. */
  created: z.boolean(),
  /** True when the entity's wiki page was flagged stale by this write. */
  staleFlagged: z.boolean(),
});

// --- POST /api/knowledge/relationships --------------------------------

/** Add a relationship `subject —predicate→ object` between two entities. */
export const AddRelationshipBody = z.object({
  /** The relationship's source entity (by id, or type+name). */
  subject: EntityRef,
  /** The (free-form) relationship label, e.g. "works at"; normalised before storage. */
  predicate: z.string().min(1),
  /** The relationship's target entity (by id, or type+name). */
  object: EntityRef,
  /** Optional provenance tying the edge to an existing source. */
  provenance: Provenance.optional(),
});

export const AddRelationshipResponse = z.object({
  subjectId: z.number(),
  objectId: z.number(),
  /** The normalised predicate the edge was stored under. */
  predicate: z.string(),
  /** True when a new edge was created; false when an existing one was reinforced. */
  created: z.boolean(),
});

export type UpsertEntityBodyT = z.infer<typeof UpsertEntityBody>;
export type AddObservationBodyT = z.infer<typeof AddObservationBody>;
export type AddRelationshipBodyT = z.infer<typeof AddRelationshipBody>;
export type EntityRefT = z.infer<typeof EntityRef>;
export type ProvenanceT = z.infer<typeof Provenance>;
