import type { Block, BlockType } from "./parse.js";

/**
 * A chunk plus the metadata that lets a retrieval result navigate back to its
 * origin (chunk → section → source) and lets citations point at a page/section/
 * char-span, not just a document. Built deterministically from a document's
 * blocks; see {@link chunkBlocks}.
 */
export interface ChunkWithMetadata {
  text: string;
  /** Ids of the {@link Block}s this chunk was assembled from. */
  sourceBlockIds: string[];
  /** The nearest enclosing heading, prefixed onto the chunk text for retrieval. */
  sectionTitle: string | null;
  /** 1-based page range covered, when the blocks carried page numbers. */
  pageStart: number | null;
  pageEnd: number | null;
  /** Char span in the document's normalized text (min/max over the blocks). */
  charStart: number;
  charEnd: number;
  /** Rough token count (chars/4) — cheap, deterministic, no tokenizer dep. */
  tokenEstimate: number;
  /** The dominant block type in the chunk (paragraph/list/table/code/heading). */
  contentType: BlockType;
}

/** Cheap, deterministic token estimate: ~4 chars/token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Paragraph-aware chunking: paragraphs are packed into chunks of roughly
 * maxChars, with single oversized paragraphs hard-split. Returns non-empty
 * trimmed chunks in document order.
 *
 * Retained for existing callers/tests; new code should prefer {@link chunkBlocks}
 * which carries page/section/span metadata. This now delegates to the block
 * chunker so the two paths can never drift.
 */
export function chunkText(text: string, maxChars = 1500): string[] {
  const blocks = paragraphBlocks(text);
  return chunkBlocks(blocks, { maxChars, overlap: 0, prefixHeading: false }).map((c) => c.text);
}

/** Build flat paragraph blocks from text — the substrate for {@link chunkText}. */
function paragraphBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const paraRe = /\n\s*\n/g;
  const segments: Array<{ text: string; start: number }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(text)) !== null) {
    segments.push({ text: text.slice(last, m.index), start: last });
    last = m.index + m[0].length;
  }
  segments.push({ text: text.slice(last), start: last });

  for (const segment of segments) {
    const trimmed = segment.text.trim();
    if (!trimmed) continue;
    const offset = segment.text.indexOf(trimmed);
    const charStart = segment.start + offset;
    blocks.push({
      id: `b${blocks.length}`,
      type: "paragraph",
      text: trimmed,
      charStart,
      charEnd: charStart + trimmed.length,
    });
  }
  return blocks;
}

export interface ChunkOptions {
  /** Soft size budget per chunk, in characters. */
  maxChars?: number;
  /** Characters of tail overlap carried into the next chunk (retrieval recall). */
  overlap?: number;
  /** Prefix the section heading onto each chunk's text so it ranks on headings. */
  prefixHeading?: boolean;
}

/**
 * Deterministic, structure-aware chunking. Packs blocks into chunks of roughly
 * `maxChars`, never merging across a heading boundary (so a chunk stays inside
 * one section), hard-splitting any single oversized block, and optionally
 * carrying `overlap` trailing characters into the next chunk for recall. Each
 * chunk records the blocks it came from, its section title, page range, char
 * span, token estimate, and dominant content type.
 *
 * Fully deterministic: identical blocks + options always yield identical chunks.
 */
export function chunkBlocks(blocks: Block[], options: ChunkOptions = {}): ChunkWithMetadata[] {
  const maxChars = options.maxChars ?? 1500;
  const overlap = Math.max(0, Math.min(options.overlap ?? 200, Math.floor(maxChars / 2)));
  const prefixHeading = options.prefixHeading ?? true;

  const chunks: ChunkWithMetadata[] = [];
  // Accumulator for the current chunk.
  let members: Block[] = [];
  let body = "";

  const sectionTitleOf = (block: Block): string | null => {
    if (block.type === "heading") return block.text;
    const path = block.headingPath;
    return path && path.length > 0 ? path[path.length - 1]! : null;
  };

  const flush = (carry: string) => {
    if (members.length === 0) return;
    const section = sectionTitleOf(members[0]!);
    const pages = members.map((b) => b.page).filter((p): p is number => p != null);
    const text = prefixHeading && section ? `${section}\n\n${body}` : body;
    chunks.push({
      text: text.trim(),
      sourceBlockIds: members.map((b) => b.id),
      sectionTitle: section,
      pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null,
      charStart: Math.min(...members.map((b) => b.charStart)),
      charEnd: Math.max(...members.map((b) => b.charEnd)),
      tokenEstimate: estimateTokens(text),
      contentType: dominantType(members),
    });
    members = [];
    body = carry;
  };

  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;

    // A heading starts a fresh section: flush whatever preceded it, then let
    // the heading begin the next chunk (so its section title is carried).
    const startsNewSection =
      block.type === "heading" || (members.length > 0 && breaksSection(members[0]!, block));
    if (startsNewSection) flush("");

    if (text.length > maxChars) {
      flush("");
      for (let i = 0; i < text.length; i += maxChars) {
        const slice = text.slice(i, i + maxChars);
        members = [{ ...block, text: slice }];
        body = slice;
        flush("");
      }
      continue;
    }

    if (body.length + text.length + 2 > maxChars && members.length > 0) {
      const carryTail = overlap > 0 ? body.slice(Math.max(0, body.length - overlap)) : "";
      // The overlapped tail belongs to the previous chunk's last block(s); keep
      // that block as the new chunk's provenance anchor so spans stay valid.
      const anchor = members[members.length - 1]!;
      flush(carryTail);
      if (carryTail) members = [anchor];
    }

    members.push(block);
    body = body ? `${body}\n\n${text}` : text;
  }
  flush("");

  return chunks;
}

/** Two blocks break the same section when their nearest heading differs. */
function breaksSection(a: Block, b: Block): boolean {
  const ha = a.headingPath?.join(" ") ?? "";
  const hb = b.headingPath?.join(" ") ?? "";
  return ha !== hb;
}

/** The most common block type among members (ties resolved by first seen). */
function dominantType(members: Block[]): BlockType {
  const counts = new Map<BlockType, number>();
  for (const b of members) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
  let best: BlockType = members[0]!.type;
  let bestN = 0;
  for (const [type, n] of counts) {
    if (n > bestN) {
      best = type;
      bestN = n;
    }
  }
  return best;
}
