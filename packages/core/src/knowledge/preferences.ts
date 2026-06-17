import { createHash } from "node:crypto";
import type { EntityType } from "../extract/schema.js";
import { OBSERVATION_KINDS, type ObservationKind } from "./schema-doc.js";

/**
 * Knowledge preferences (#86) — which of the canonical entity types and
 * observation kinds the user wants MeOS to FOCUS on. This is the simple,
 * non-destructive "enabled/disabled" model: disabling a type never deletes
 * anything, it only narrows what extraction is steered toward and what the
 * wiki/graph/digest surface. The default — all enabled — reproduces the
 * pre-#86 behaviour exactly, so a no-config install is unaffected.
 *
 * We deliberately do NOT widen the entity-type enum or invent new types here:
 * the six canonical types (`entityTypeSchema`) and the nine observation kinds
 * (`OBSERVATION_KINDS`) stay fixed. A preset is just a named subset of those
 * two sets.
 */

/** The six canonical entity types, in their canonical display order. */
export const ENTITY_TYPES: readonly EntityType[] = [
  "person",
  "project",
  "organisation",
  "concept",
  "place",
  "decision",
] as const;

/** The known preset identifiers (plus "custom" for a user-tweaked toggle set). */
export const KNOWLEDGE_PRESETS = [
  "default",
  "consultant",
  "executive",
  "personal",
  "research",
  "custom",
] as const;
export type KnowledgePreset = (typeof KNOWLEDGE_PRESETS)[number];

/** A toggle map over a fixed key set: key -> enabled. */
export type EntityTypeToggles = Record<EntityType, boolean>;
export type ObservationKindToggles = Record<ObservationKind, boolean>;

/**
 * The persisted preference value (stored as one JSON blob in the `settings`
 * table under `knowledge_preferences`). All three fields are optional on read
 * so an old/partial value still resolves cleanly via {@link resolvePreferences}.
 */
export interface KnowledgePreferences {
  preset: KnowledgePreset;
  entityTypes: EntityTypeToggles;
  observationKinds: ObservationKindToggles;
}

/** Build a fully-enabled toggle map for a key list. */
function allEnabled<K extends string>(keys: readonly K[]): Record<K, boolean> {
  return Object.fromEntries(keys.map((k) => [k, true])) as Record<K, boolean>;
}

/** Build a toggle map enabling only the keys in `on` (others false). */
function only<K extends string>(keys: readonly K[], on: readonly K[]): Record<K, boolean> {
  const set = new Set<string>(on);
  return Object.fromEntries(keys.map((k) => [k, set.has(k)])) as Record<K, boolean>;
}

/**
 * Preset definitions. Each preset from the issue lists user-facing focus areas;
 * several of those ("Action items", "Risks", "Tasks", "Events", "Metrics",
 * "Claims", "Questions"…) are not entity types but OBSERVATION KINDS, so every
 * preset maps onto BOTH sets:
 *
 *  - **default**    — everything enabled (today's behaviour, the safe no-config base).
 *  - **consultant** — People, Organizations, Projects, Decisions, Technologies(→concept)
 *                     + task/risk/open_question/decision observation kinds.
 *  - **executive**  — People, Organizations, Projects, Decisions
 *                     + decision/risk/event observation kinds (priorities/metrics fold into fact).
 *  - **personal**   — People, Places, Events(→no entity type; via kind), Tasks,
 *                     Decisions, Organizations, Projects → entity types person/place/
 *                     organisation/project/decision + task/event/decision kinds.
 *  - **research**   — Concepts, Claims, Papers/documents, People, Organizations,
 *                     Questions, Projects → entity types concept/person/organisation/project
 *                     + fact(claims)/open_question/decision kinds.
 *
 * Kinds the user never wants to see can be turned off, but we keep `fact` enabled
 * in every preset because it is the catch-all kind for ordinary claims — turning
 * it off would silently drop most observations.
 */
const PRESET_DEFS: Record<
  Exclude<KnowledgePreset, "default" | "custom">,
  { entityTypes: EntityType[]; observationKinds: ObservationKind[] }
> = {
  consultant: {
    entityTypes: ["person", "organisation", "project", "decision", "concept"],
    observationKinds: ["fact", "decision", "requirement", "task", "risk", "open_question"],
  },
  executive: {
    entityTypes: ["person", "organisation", "project", "decision"],
    observationKinds: ["fact", "decision", "requirement", "risk", "event"],
  },
  personal: {
    entityTypes: ["person", "place", "organisation", "project", "decision"],
    observationKinds: ["fact", "decision", "preference", "task", "event"],
  },
  research: {
    entityTypes: ["concept", "person", "organisation", "project"],
    observationKinds: ["fact", "decision", "requirement", "open_question", "procedure"],
  },
};

/** The default preferences: every entity type and observation kind enabled. */
export function defaultPreferences(): KnowledgePreferences {
  return {
    preset: "default",
    entityTypes: allEnabled(ENTITY_TYPES),
    observationKinds: allEnabled(OBSERVATION_KINDS),
  };
}

/** Build the full preference value for a named preset. */
export function preferencesForPreset(preset: KnowledgePreset): KnowledgePreferences {
  if (preset === "default" || preset === "custom") return { ...defaultPreferences(), preset };
  const def = PRESET_DEFS[preset];
  return {
    preset,
    entityTypes: only(ENTITY_TYPES, def.entityTypes),
    observationKinds: only(OBSERVATION_KINDS, def.observationKinds),
  };
}

/**
 * Normalise a stored (possibly partial or stale) preference value into a
 * complete, valid {@link KnowledgePreferences}. Unknown/missing keys default to
 * ENABLED so a partial value never silently hides a type. `undefined` (unset)
 * resolves to {@link defaultPreferences} — the heart of "no config == old
 * behaviour".
 */
export function resolvePreferences(
  prefs?: Partial<KnowledgePreferences> | null,
): KnowledgePreferences {
  if (!prefs) return defaultPreferences();
  const base = defaultPreferences();
  const preset: KnowledgePreset =
    prefs.preset && KNOWLEDGE_PRESETS.includes(prefs.preset) ? prefs.preset : "custom";
  const entityTypes = { ...base.entityTypes };
  const observationKinds = { ...base.observationKinds };
  for (const t of ENTITY_TYPES) {
    if (prefs.entityTypes && typeof prefs.entityTypes[t] === "boolean") {
      entityTypes[t] = prefs.entityTypes[t];
    }
  }
  for (const k of OBSERVATION_KINDS) {
    if (prefs.observationKinds && typeof prefs.observationKinds[k] === "boolean") {
      observationKinds[k] = prefs.observationKinds[k];
    }
  }
  return { preset, entityTypes, observationKinds };
}

/** The set of currently-enabled entity types. */
export function enabledEntityTypes(prefs: KnowledgePreferences): Set<EntityType> {
  return new Set(ENTITY_TYPES.filter((t) => prefs.entityTypes[t]));
}

/** The set of currently-enabled observation kinds. */
export function enabledObservationKinds(prefs: KnowledgePreferences): Set<ObservationKind> {
  return new Set(OBSERVATION_KINDS.filter((k) => prefs.observationKinds[k]));
}

/**
 * True when every type and kind is enabled — i.e. preferences impose no filter
 * and every downstream surface should behave exactly as before #86. Callers use
 * this to short-circuit filtering so the default path is provably unchanged.
 */
export function preferencesAreUnrestricted(prefs: KnowledgePreferences): boolean {
  return (
    ENTITY_TYPES.every((t) => prefs.entityTypes[t]) &&
    OBSERVATION_KINDS.every((k) => prefs.observationKinds[k])
  );
}

/**
 * A short, stable hash of the resolved preferences — folded into the extraction
 * cache key so a preference change invalidates stale cached extractions. The
 * all-enabled default hashes to a fixed sentinel so an unset/default install
 * keeps the same cache key it had before #86 (no spurious re-extraction).
 */
export function preferencesVersion(prefs: KnowledgePreferences): string {
  if (preferencesAreUnrestricted(prefs)) return "all";
  const types = ENTITY_TYPES.filter((t) => prefs.entityTypes[t]).join(",");
  const kinds = OBSERVATION_KINDS.filter((k) => prefs.observationKinds[k]).join(",");
  return createHash("sha256").update(`${types}|${kinds}`).digest("hex").slice(0, 16);
}

/**
 * Compose the preference LENS appended to the extraction system prompt. A no-op
 * (returns the prompt unchanged) when preferences are unrestricted, so the
 * default prompt is byte-identical to the pre-#86 prompt. Otherwise it tells the
 * extractor which entity types and observation kinds to FOCUS on and which to
 * de-emphasise — it never instructs the model to invent new types.
 */
export function withPreferences(systemPrompt: string, prefs: KnowledgePreferences): string {
  if (preferencesAreUnrestricted(prefs)) return systemPrompt;
  const types = ENTITY_TYPES.filter((t) => prefs.entityTypes[t]);
  const disabledTypes = ENTITY_TYPES.filter((t) => !prefs.entityTypes[t]);
  const kinds = OBSERVATION_KINDS.filter((k) => prefs.observationKinds[k]);
  const disabledKinds = OBSERVATION_KINDS.filter((k) => !prefs.observationKinds[k]);
  const lines = [
    "",
    "--- KNOWLEDGE FOCUS (USER PREFERENCES) ---",
    "The user has tailored which kinds of knowledge MeOS should track. Stay within the schema's fixed entity types and observation kinds — never invent new ones — but bias your extraction as follows:",
    `- Focus on these entity types: ${types.length ? types.join(", ") : "(none — extract entities sparingly)"}.`,
  ];
  if (disabledTypes.length) {
    lines.push(
      `- De-emphasise these entity types (only extract them when essential to a focused entity): ${disabledTypes.join(", ")}.`,
    );
  }
  lines.push(`- Focus on these observation kinds: ${kinds.length ? kinds.join(", ") : "(none)"}.`);
  if (disabledKinds.length) {
    lines.push(`- De-emphasise these observation kinds: ${disabledKinds.join(", ")}.`);
  }
  return `${systemPrompt}\n${lines.join("\n")}`;
}
