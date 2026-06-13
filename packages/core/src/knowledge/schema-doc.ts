import fs from "node:fs";
import path from "node:path";

/**
 * The schema document — MeOS's equivalent of CLAUDE.md / AGENTS.md, the file
 * both reference designs call the most important one. It encodes the
 * conventions every LLM stage shares: entity and relationship types, what is
 * worth extracting, how pages are written, and how confidence/contradiction are
 * handled. It lives at `data/SCHEMA.md` as plain Markdown so the user can edit
 * the system's behaviour without touching code; the prompts read it at runtime.
 */

export const SCHEMA_FILE = "SCHEMA.md";

/**
 * Controlled relationship vocabulary. Free-form verb phrases fragment the graph
 * ("works on" vs "Works On" vs "working on" become three edges); the extractor
 * is steered toward these, and labels are normalised before storage.
 */
export const RELATIONSHIP_VOCABULARY = [
  "works on",
  "works at",
  "member of",
  "part of",
  "founded",
  "led by",
  "manages",
  "knows",
  "located in",
  "created",
  "owns",
  "owned by",
  "uses",
  "depends on",
  "decided by",
  "caused",
  "fixed",
  "blocks",
  "supports",
  "mentions",
  "contradicts",
  "supersedes",
  "related to",
] as const;

/**
 * Observation kinds — the *type* of claim, so retrieval and outputs can treat a
 * decision differently from a passing fact or an open question.
 */
export const OBSERVATION_KINDS = [
  "fact",
  "decision",
  "requirement",
  "preference",
  "task",
  "event",
  "risk",
  "open_question",
  "procedure",
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** Sensitivity tiers, least to most restricted. Governs what reaches the wiki. */
export const SENSITIVITY_LEVELS = ["normal", "private", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

/** Rank for comparing two sensitivity labels (higher = more restricted). */
export function sensitivityRank(level: Sensitivity): number {
  return SENSITIVITY_LEVELS.indexOf(level);
}

/** The stronger (more restricted) of two sensitivity labels. */
export function strongerSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return sensitivityRank(a) >= sensitivityRank(b) ? a : b;
}

/** Collapse casing/whitespace so equivalent labels share one edge. */
export function normalizeRelationshipLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Append the schema document to a system prompt. The delimiter and join live
 * here so every LLM stage (extraction, contradiction, crystallization, digest,
 * wiki) injects the schema identically.
 */
export function withSchema(systemPrompt: string, schema: string): string {
  return `${systemPrompt}\n\n--- SCHEMA ---\n${schema}`;
}

export const DEFAULT_SCHEMA_MD = `# MeOS Schema

This file defines how MeOS reads your sources and maintains your knowledge base.
It is plain Markdown — edit it to change the system's behaviour. Every LLM stage
(extraction, wiki writing, contradiction checking, digest) reads it at runtime.

## Entity types

Extract an entity only when it matters to your world:

- **person** — people you interact with.
- **project** — things you work on.
- **organisation** — companies, teams, institutions.
- **concept** — recurring ideas, topics, technologies.
- **place** — meaningful locations.
- **decision** — choices that were made; name them descriptively
  (e.g. "Decision: use SQLite for storage").

Skip generic terms, document boilerplate, and anything mentioned only in passing
with no substance.

## Relationship types

Prefer this controlled vocabulary for relationship labels so the graph stays
connected rather than fragmented into synonyms:

${RELATIONSHIP_VOCABULARY.map((label) => `- ${label}`).join("\n")}

"from" and "to" must be exact entity names. Labels read "from <label> to".

## Observation kinds

Every observation is typed by what kind of claim it is:

${OBSERVATION_KINDS.map((kind) => `- ${kind}`).join("\n")}

Observations are atomic, self-contained claims about one entity, in third person,
understandable without the source document. Include dates when the document
states them. Every observation references one entity by its exact name. Quote the
exact supporting sentence from the source ("sourceQuote") so the claim is
traceable. Never invent facts.

## Source types

- **file** — a watched or uploaded document (md, txt, pdf, docx, csv…).
- **image** — an image read by the model (OCR + description).
- **conversation** — the user's own statements in chat, crystallized back.
- **session** — a distilled summary of a completed work thread.
- **profile_context** — a document the user uploaded to describe their world;
  it feeds the profile *lens*, not the knowledge graph, so it is never extracted
  into entities or pages.

## Confidence rules

- A new claim starts at the extractor's stated confidence (source/claim quality).
- Independent sources corroborating the same claim raise its confidence.
- The same source restating a claim never raises it — confidence tracks distinct
  source count, not repeat mentions.
- Claims unconfirmed for a long time decay toward a floor.
- State well-supported claims (>= 0.7) plainly; hedge weaker ones explicitly.

## Supersession rules

When a new claim updates an old one ("moved to Berlin" vs "lives in Paris"), the
old one is **superseded** — retired, never silently kept. Prefer supersession to
silent forgetting: keep the trail. A claim may carry validFrom/validUntil when
the source dates it.

## Contradiction handling

When two claims genuinely disagree and it is unclear which is right, record a
**contradiction** for the user to resolve. Suggest a resolution by comparing
source recency, authority, and confidence — but a human makes the final call.

## Privacy rules

Classify every claim's sensitivity:

- **normal** — fine to synthesise into the wiki.
- **private** — personal/sensitive; kept in memory, kept *out* of wiki pages.
- **secret** — credentials, API keys, tokens, passwords. The secret value is
  redacted at ingest and never written to the wiki.

Never write private or secret claims into wiki pages (they are portable and
git-synced). Secrets are redacted from stored text.

## Wiki writing rules

One page per entity, written as clear factual prose by someone who has read every
source. Use only recorded observations and relationships — never outside
knowledge. Link related entities inline with [[Entity Name]] using exact names.
Edit pages in place: keep prose that is still accurate, weave in new facts.

## Quality criteria

A good page is: grounded in cited sources, free of broken [[links]] and orphan
status, free of duplicate or vague claims, explicit about low-confidence or stale
claims, and connected to the rest of the graph.
`;

/** Read the user's schema document, falling back to the built-in default. */
export function loadSchema(dataDir: string): string {
  const file = path.join(dataDir, SCHEMA_FILE);
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return DEFAULT_SCHEMA_MD;
  }
}

/** Write the default schema document once, if the user has none yet. */
export function ensureSchemaDoc(dataDir: string): void {
  const file = path.join(dataDir, SCHEMA_FILE);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, DEFAULT_SCHEMA_MD);
  }
}
