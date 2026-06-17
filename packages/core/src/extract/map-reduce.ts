import { createHash } from "node:crypto";
import { chunkBlocks } from "../ingest/chunk.js";
import { blocksFromText, type Block } from "../ingest/parse.js";
import {
  defaultPreferences,
  type KnowledgePreferences,
  preferencesVersion,
} from "../knowledge/preferences.js";
import { DEFAULT_SCHEMA_MD } from "../knowledge/schema-doc.js";
import type { ExtractionStrategy, ExtractionCacheKey, KnowledgeStore } from "../knowledge/store.js";
import type { LlmClient } from "../llm/types.js";
import { extractKnowledge } from "./extractor.js";
import { reduceExtractions } from "./reduce.js";
import type { Extraction } from "./schema.js";

/**
 * Version of the extraction PROMPT. Bump when {@link extractKnowledge}'s system
 * prompt changes in a way that alters output — it is part of the cache key so a
 * prompt change invalidates cached partials. The reduce step is deterministic
 * and not LLM-driven, so it has no version of its own.
 */
export const EXTRACTION_PROMPT_VERSION = "v1";

/**
 * Version of the extraction OUTPUT SCHEMA (`extractionSchema`). Bump on any
 * shape change; part of the cache key. Distinct from the user-editable schema
 * document, whose content (the relevance lens etc.) is folded into the key via
 * {@link schemaDocVersion}.
 */
export const EXTRACTION_SCHEMA_VERSION = "v1";

/**
 * Documents whose estimated token size is at or below this stay on the CURRENT
 * single-pass {@link extractKnowledge} fast path — same cost/latency/behaviour
 * as before #15. Only larger documents go map-reduce. The estimate is the cheap
 * chars/4 heuristic shared with chunking; the threshold is a conservative slice
 * of a modern context window, leaving room for the schema + profile + prompt.
 */
export const SINGLE_PASS_TOKEN_LIMIT = 6000;

/**
 * Soft per-section character budget for the map pass. Each section is one LLM
 * call, so this trades cost (fewer, bigger sections) against context-limit
 * safety (smaller sections never overflow on a pathological document).
 */
const SECTION_MAX_CHARS = 4000;

/** Cheap, deterministic token estimate: ~4 chars/token (matches chunking). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * A content-derived "version" for the user-editable schema document and profile
 * lens: a short hash so a changed schema/profile invalidates the cache without
 * leaking the document into the key.
 */
export function schemaDocVersion(schemaMd: string): string {
  return sha256(schemaMd).slice(0, 16);
}
export function profileVersion(profileContext: string): string {
  return profileContext.trim() ? sha256(profileContext).slice(0, 16) : "none";
}

export interface MapReduceOptions {
  store: KnowledgeStore;
  /** The revision (#16) this extraction belongs to — the cache's primary scope. */
  sourceRevisionId: number;
  /** Identifies the extraction model for the cache version tuple. */
  modelId: string;
  /** The schema document the prompt is steered by (DEFAULT_SCHEMA_MD when absent). */
  schemaMd?: string;
  /** The profile lens; folded into relevance + the cache key. */
  profileContext?: string;
  /** Knowledge focus (#86); biases extraction + folded into the cache key so a
   *  preference change invalidates stale cached partials. Defaults to all-enabled. */
  preferences?: KnowledgePreferences;
  /** Override the size gate (tests). */
  singlePassTokenLimit?: number;
}

export interface ExtractionRunResult {
  extraction: Extraction;
  strategy: ExtractionStrategy;
  /** LLM tokens spent on map calls that actually ran (0 when fully cache-served). */
  tokenUsage: number;
  /** Number of LLM extraction calls that ran (0 == fully cache-served). */
  llmCalls: number;
  /** Number of sections served from the cache. */
  cacheHits: number;
}

/**
 * Group a document's blocks into self-contained sections for the map pass. Reuses
 * #14's {@link chunkBlocks} so sections honour heading boundaries and never split
 * mid-section, then prefixes the document title + nearest section heading onto
 * each section's text so a section's claims are interpretable on their own
 * (local context). Returns one entry per section with the exact text the LLM
 * will see (which is what the cache hashes).
 */
function sectionsForMap(title: string, blocks: Block[]): Array<{ text: string; hash: string }> {
  const chunks = chunkBlocks(blocks, { maxChars: SECTION_MAX_CHARS, overlap: 0 });
  return chunks.map((chunk) => {
    const heading = chunk.sectionTitle && chunk.sectionTitle !== title ? chunk.sectionTitle : null;
    // Local context: title + heading path so the section reads standalone. The
    // body already carries its heading when chunkBlocks prefixed it, so only add
    // the document title here.
    const text = `Document title: ${title}${heading ? `\nSection: ${heading}` : ""}\n\n${chunk.text}`;
    return { text, hash: sha256(text) };
  });
}

/**
 * Extract a document's knowledge, choosing the strategy by size (#15):
 *
 *  - **small** documents take the unchanged single-pass {@link extractKnowledge}
 *    fast path — one LLM call over the whole text;
 *  - **large** documents are split into sections (map), each extracted with local
 *    context and cached by (revision, section hash, version tuple), then the
 *    partials are deterministically reduced into one Extraction (reduce).
 *
 * Either way the result is a plain {@link Extraction} the existing merge step
 * consumes. Cache hits skip the LLM call for a section; a miss recomputes and
 * writes the partial back. The whole result is cached so a small-doc re-run is
 * also LLM-free.
 */
export async function extractKnowledgeMapReduce(
  llm: LlmClient,
  source: { title: string; text: string; blocks?: Block[] },
  options: MapReduceOptions,
): Promise<ExtractionRunResult> {
  const schemaMd = options.schemaMd ?? DEFAULT_SCHEMA_MD;
  const profileContext = options.profileContext ?? "";
  const preferences = options.preferences ?? defaultPreferences();
  const limit = options.singlePassTokenLimit ?? SINGLE_PASS_TOKEN_LIMIT;

  // The knowledge-preferences version (#86) rides on schemaVersion so a prefs
  // change invalidates cached partials without a new cache column/migration.
  // The all-enabled default contributes NOTHING (empty suffix), keeping the key
  // byte-identical to pre-#86 for an unconfigured install — no spurious
  // re-extraction. Only a restricted preference set appends a `:p<hash>` segment.
  const prefsVer = preferencesVersion(preferences);
  const prefsSuffix = prefsVer === "all" ? "" : `:p${prefsVer}`;
  const versionTuple = {
    schemaVersion: `${EXTRACTION_SCHEMA_VERSION}:${schemaDocVersion(schemaMd)}${prefsSuffix}`,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    modelId: options.modelId,
    profileVersion: profileVersion(profileContext),
  };
  const keyFor = (contentHash: string): ExtractionCacheKey => ({
    sourceRevisionId: options.sourceRevisionId,
    contentHash,
    ...versionTuple,
  });

  // ---- Size gate: small documents keep the single-pass fast path. ---------
  if (estimateTokens(source.text) <= limit) {
    const wholeHash = sha256(`single\n${source.title}\n${source.text}`);
    const cached = options.store.getCachedExtraction(keyFor(wholeHash));
    if (cached) {
      return { extraction: cached, strategy: "single", tokenUsage: 0, llmCalls: 0, cacheHits: 1 };
    }
    const extraction = await extractKnowledge(llm, source, schemaMd, profileContext, preferences);
    options.store.putCachedExtraction(keyFor(wholeHash), extraction, "single", 0);
    return {
      extraction,
      strategy: "single",
      tokenUsage: 0,
      llmCalls: 1,
      cacheHits: 0,
    };
  }

  // ---- Map: per-section extraction with local context (+ cache). ----------
  const blocks = source.blocks?.length ? source.blocks : blocksFromText(source.text);
  const sections = sectionsForMap(source.title, blocks);

  const partials: Extraction[] = [];
  let llmCalls = 0;
  let cacheHits = 0;
  for (const section of sections) {
    const key = keyFor(section.hash);
    const cached = options.store.getCachedExtraction(key);
    if (cached) {
      partials.push(cached);
      cacheHits++;
      continue;
    }
    // Each section is its own already-titled "document" so extractKnowledge's
    // own framing doesn't double-prefix; the section text carries the context.
    const partial = await extractKnowledge(
      llm,
      { title: source.title, text: section.text },
      schemaMd,
      profileContext,
      preferences,
    );
    options.store.putCachedExtraction(key, partial, "map-reduce", 0);
    partials.push(partial);
    llmCalls++;
  }

  // ---- Reduce: deterministic merge of the partials (no LLM). --------------
  const extraction = reduceExtractions(partials);
  return { extraction, strategy: "map-reduce", tokenUsage: 0, llmCalls, cacheHits };
}
