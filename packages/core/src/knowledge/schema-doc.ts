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
  "uses",
  "depends on",
  "caused",
  "fixed",
  "decided",
  "related to",
] as const;

/** Collapse casing/whitespace so equivalent labels share one edge. */
export function normalizeRelationshipLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
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

## Observations

Atomic, self-contained facts about one entity, in third person, understandable
without the source document. Include dates when the document states them. Every
observation references one entity by its exact name. Never invent facts.

## Confidence & corroboration

A fact's confidence rises as independent sources corroborate it, and decays when
it goes long unconfirmed. State well-supported facts plainly; hedge weak ones.

## Contradictions & supersession

When a new fact updates an old one ("moved to Berlin" vs "lives in Paris"), the
old one is **superseded** — retired, never silently kept. When two facts
genuinely disagree and it is unclear which is right, record a **contradiction**
for the user to resolve.

## Wiki pages

One page per entity, written as clear factual prose by someone who has read every
source. Use only recorded observations and relationships — never outside
knowledge. Link related entities inline with [[Entity Name]] using exact names.
Edit pages in place: keep prose that is still accurate, weave in new facts.
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
