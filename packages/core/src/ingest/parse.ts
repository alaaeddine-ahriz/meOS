import path from "node:path";

/**
 * The kind of a document block. Deliberately open-ended at the edges ("other")
 * so future multimodal parsers (image/audio captions, embeds) can slot in
 * without a schema rewrite — the data model has to outlive #14.
 */
export type BlockType = "heading" | "paragraph" | "list" | "table" | "code" | "other";

/**
 * A first-class structural unit of a parsed document. Blocks preserve the
 * structure flat text throws away — page numbers, heading hierarchy, char
 * spans — so retrieval can boost headings, citations can point at a page/
 * section/span, and chunking can stay inside section boundaries.
 *
 * `charStart`/`charEnd` are offsets into {@link ParsedDocument.text} (the
 * normalized full text), so a block always maps back to a substring of the
 * document the rest of the pipeline already works with.
 */
export interface Block {
  /** Stable within one parse, document order: "b0", "b1", … */
  id: string;
  type: BlockType;
  text: string;
  /** 1-based page (PDF) when known. */
  page?: number;
  /** Enclosing headings, outermost first (DOCX/markdown). */
  headingPath?: string[];
  /** Offset of this block's text in {@link ParsedDocument.text}. */
  charStart: number;
  /** Exclusive end offset in {@link ParsedDocument.text}. */
  charEnd: number;
  /** Format-specific extras (CSV columns, JSON key path, heading level…). */
  meta?: Record<string, unknown>;
}

export interface ParsedDocument {
  title: string;
  /** Normalized full text — the canonical content the pipeline embeds/extracts. */
  text: string;
  /**
   * Structured blocks, when the parser could recover structure. Optional so the
   * plain-text path and existing callers stay valid; when present, the blocks'
   * `text` concatenated (in order, joined per the parser) reconstructs `text`.
   */
  blocks?: Block[];
}

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".csv",
  ".json",
  ".org",
  // Tier 2: code/config files ingested as plain text/code.
  ".sql",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".log",
]);

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Everything the pipeline can absorb — watchers use this to skip the rest silently. */
export const SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ".pdf",
  ".docx",
  // Spreadsheets (SheetJS).
  ".xlsx",
  ".xls",
  ".ods",
  // Presentations (zip+XML).
  ".pptx",
  // Email.
  ".eml",
  ".mbox",
  // Web / rich text.
  ".html",
  ".htm",
  ".rtf",
  ".odt",
  // Notebooks.
  ".ipynb",
  ...Object.keys(IMAGE_MEDIA_TYPES),
]);

/**
 * Media type for image files the LLM can read directly, or undefined for
 * non-images. Images bypass parseDocument: the pipeline sends them to the
 * LLM's vision input instead.
 */
export function imageMediaType(filename: string): string | undefined {
  return IMAGE_MEDIA_TYPES[path.extname(filename).toLowerCase()];
}

/** Append a block, deriving its id from position so ids are deterministic. */
function pushBlock(blocks: Block[], block: Omit<Block, "id">): void {
  blocks.push({ id: `b${blocks.length}`, ...block });
}

/**
 * Split plain text / markdown into heading + paragraph blocks, tracking each
 * block's char span in the original text and the heading hierarchy it sits
 * under. Deterministic: identical input always yields identical blocks.
 */
export function blocksFromText(text: string): Block[] {
  const blocks: Block[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];

  // Walk paragraph-shaped segments (blank-line separated), but treat each
  // markdown heading line as its own block so the hierarchy is recoverable.
  // We scan with a regex over double-newline boundaries while keeping offsets.
  const paraRe = /\n\s*\n/g;
  const segments: Array<{ text: string; start: number }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(text)) !== null) {
    segments.push({ text: text.slice(last, m.index), start: last });
    last = m.index + m[0].length;
  }
  segments.push({ text: text.slice(last), start: last });

  const headingPathSnapshot = () => headingStack.map((h) => h.title);

  for (const segment of segments) {
    const trimmed = segment.text.trim();
    if (!trimmed) continue;
    // Locate the trimmed body precisely inside the segment for an exact span.
    const offset = segment.text.indexOf(trimmed);
    const charStart = segment.start + offset;
    const charEnd = charStart + trimmed.length;

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headingMatch && !trimmed.includes("\n")) {
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();
      // Pop deeper-or-equal headings so the path reflects this heading's parents.
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      pushBlock(blocks, {
        type: "heading",
        text: title,
        headingPath: headingPathSnapshot(),
        charStart,
        charEnd,
        meta: { level },
      });
      headingStack.push({ level, title });
      continue;
    }

    // A bullet/numbered block becomes a "list"; fenced code a "code" block.
    const isList = trimmed.split("\n").every((line) => /^\s*([-*+]|\d+[.)])\s+/.test(line));
    const isCode = /^```/.test(trimmed) || /^ {4}/.test(segment.text);
    const type: BlockType = isCode ? "code" : isList ? "list" : "paragraph";
    pushBlock(blocks, {
      type,
      text: trimmed,
      headingPath: headingPathSnapshot(),
      charStart,
      charEnd,
    });
  }

  return blocks;
}

/**
 * Parse CSV into a table block plus one block per data row. Hand-rolled (no new
 * deps), tolerant of quoted fields with embedded commas/newlines. Column names
 * land in `meta` so downstream consumers stay schema-aware. The normalized
 * `text` is a readable "Column: value" rendering, deterministic per input.
 */
export function parseCsv(raw: string): { text: string; blocks: Block[] } {
  const rows = parseCsvRows(raw);
  if (rows.length === 0) return { text: raw.trim(), blocks: [] };

  const header = rows[0]!;
  const dataRows = rows.slice(1);
  const blocks: Block[] = [];
  const lines: string[] = [];
  let cursor = 0;

  const headingText = `Table with columns: ${header.join(", ")}`;
  lines.push(headingText);
  pushBlock(blocks, {
    type: "table",
    text: headingText,
    charStart: cursor,
    charEnd: cursor + headingText.length,
    meta: { columns: header, rowCount: dataRows.length },
  });
  cursor += headingText.length + 2; // for the "\n\n" join

  dataRows.forEach((cells, i) => {
    const rowText = header.map((col, c) => `${col}: ${cells[c] ?? ""}`).join("; ");
    lines.push(rowText);
    const record: Record<string, string> = {};
    header.forEach((col, c) => {
      record[col] = cells[c] ?? "";
    });
    pushBlock(blocks, {
      type: "table",
      text: rowText,
      charStart: cursor,
      charEnd: cursor + rowText.length,
      meta: { columns: header, row: i, record },
    });
    cursor += rowText.length + 2;
  });

  return { text: lines.join("\n\n"), blocks };
}

/** RFC-4180-ish CSV row splitter: handles quoted fields, "" escapes, CRLF. */
function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      // Skip wholly empty trailing rows.
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/**
 * Parse JSON into schema-aware blocks: a top-level array becomes one block per
 * element (with key names in `meta`); an object becomes one block per top-level
 * key. Falls back to a single block of pretty-printed text for scalars or
 * unparseable input. Deterministic — object keys are emitted in insertion order.
 */
export function parseJson(raw: string): { text: string; blocks: Block[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const text = raw.trim();
    return { text, blocks: blocksFromText(text) };
  }

  const blocks: Block[] = [];
  const lines: string[] = [];
  let cursor = 0;
  const emit = (text: string, meta: Record<string, unknown>) => {
    lines.push(text);
    pushBlock(blocks, {
      type: "table",
      text,
      charStart: cursor,
      charEnd: cursor + text.length,
      meta,
    });
    cursor += text.length + 2;
  };

  if (Array.isArray(parsed)) {
    const keys = collectKeys(parsed);
    emit(
      `JSON array of ${parsed.length} items` +
        (keys.length ? ` with keys: ${keys.join(", ")}` : ""),
      {
        keys,
        itemCount: parsed.length,
      },
    );
    parsed.forEach((item, i) => {
      emit(renderJsonValue(item), { index: i, keys: itemKeys(item) });
    });
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    emit(`JSON object with keys: ${keys.join(", ")}`, { keys });
    for (const key of keys) {
      emit(`${key}: ${renderJsonValue(obj[key])}`, { key });
    }
  } else {
    emit(renderJsonValue(parsed), {});
  }

  return { text: lines.join("\n\n"), blocks };
}

function itemKeys(item: unknown): string[] {
  return item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item) : [];
}

function collectKeys(items: unknown[]): string[] {
  const keys = new Set<string>();
  for (const item of items) for (const k of itemKeys(item)) keys.add(k);
  return [...keys];
}

function renderJsonValue(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(value);
}

/**
 * Extract text + structural blocks from an uploaded file. Returns null for
 * formats MeOS cannot read yet — the caller surfaces those in the Inbox as
 * "unsupported". `text` is always the normalized full text (existing callers
 * keep working); `blocks` carries structure when the parser could recover it.
 */
export async function parseDocument(
  filename: string,
  buffer: Buffer,
): Promise<ParsedDocument | null> {
  const ext = path.extname(filename).toLowerCase();
  const title = path.basename(filename, ext);

  if (ext === ".csv") {
    const { text, blocks } = parseCsv(buffer.toString("utf-8"));
    return { title, text, blocks };
  }

  if (ext === ".json") {
    const { text, blocks } = parseJson(buffer.toString("utf-8"));
    return { title, text, blocks };
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    const text = buffer.toString("utf-8");
    return { title, text, blocks: blocksFromText(text) };
  }

  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // verbosity 0 = errors only: silences PDF.js's harmless per-font hinting
    // noise ("Warning: TT: undefined function") that otherwise floods the log
    // for any PDF whose TrueType fonts reference undefined instructions.
    const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
    // mergePages:false gives us per-page text so each block can carry its page.
    const { text: pages } = await extractText(pdf, { mergePages: false });
    const pageTexts = Array.isArray(pages) ? pages : [pages];
    const blocks: Block[] = [];
    const parts: string[] = [];
    let cursor = 0;
    pageTexts.forEach((pageText, i) => {
      const trimmed = (pageText ?? "").trim();
      if (!trimmed) return;
      parts.push(trimmed);
      pushBlock(blocks, {
        type: "paragraph",
        text: trimmed,
        page: i + 1,
        charStart: cursor,
        charEnd: cursor + trimmed.length,
        meta: { page: i + 1 },
      });
      cursor += trimmed.length + 2;
    });
    return { title, text: parts.join("\n\n"), blocks };
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    // convertToHtml preserves the heading hierarchy (<h1>..<h6>) that
    // extractRawText flattens away; we walk it to recover headingPath.
    const { value: html } = await mammoth.convertToHtml({ buffer });
    return { title, ...blocksFromDocxHtml(html) };
  }

  // Spreadsheets: .xlsx / .xls / .ods (SheetJS reads all three).
  if (ext === ".xlsx" || ext === ".xls" || ext === ".ods") {
    const { parseSpreadsheet } = await import("./parsers/spreadsheet.js");
    return { title, ...(await parseSpreadsheet(buffer)) };
  }

  // Presentations: .pptx (zip of per-slide XML).
  if (ext === ".pptx") {
    const { parsePptx } = await import("./parsers/pptx.js");
    return { title, ...(await parsePptx(buffer)) };
  }

  // Email: single message (.eml) or mailbox of many (.mbox).
  if (ext === ".eml") {
    const { parseEml } = await import("./parsers/email.js");
    return { title, ...(await parseEml(buffer)) };
  }
  if (ext === ".mbox") {
    const { parseMbox } = await import("./parsers/email.js");
    return { title, ...(await parseMbox(buffer)) };
  }

  // Web / rich text.
  if (ext === ".html" || ext === ".htm") {
    const { parseHtml } = await import("./parsers/html.js");
    return { title, ...(await parseHtml(buffer.toString("utf-8"))) };
  }
  if (ext === ".rtf") {
    const { parseRtf } = await import("./parsers/rtf.js");
    return { title, ...parseRtf(buffer.toString("utf-8")) };
  }
  if (ext === ".odt") {
    const { parseOdt } = await import("./parsers/odf.js");
    return { title, ...(await parseOdt(buffer)) };
  }

  // Jupyter notebooks (JSON document of markdown/code cells).
  if (ext === ".ipynb") {
    const { parseNotebook } = await import("./parsers/notebook.js");
    return { title, ...parseNotebook(buffer.toString("utf-8")) };
  }

  return null;
}

/**
 * Turn mammoth's HTML into normalized text + blocks, recovering the heading
 * hierarchy. Hand-rolled tag walk (no DOM dep): good enough for mammoth's flat,
 * predictable output of block-level <h1..6>/<p>/<ul>/<ol>/<table> elements.
 */
export function blocksFromDocxHtml(html: string): { text: string; blocks: Block[] } {
  const blocks: Block[] = [];
  const parts: string[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  let cursor = 0;

  // Match each top-level block element mammoth emits.
  const elementRe = /<(h[1-6]|p|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = elementRe.exec(html)) !== null) {
    const tag = m[1]!.toLowerCase();
    const inner = m[2]!;
    const text = decodeHtml(stripTags(inner)).trim();
    if (!text) continue;

    const headingPath = headingStack.map((h) => h.title);
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      parts.push(text);
      pushBlock(blocks, {
        type: "heading",
        text,
        headingPath,
        charStart: cursor,
        charEnd: cursor + text.length,
        meta: { level },
      });
      headingStack.push({ level, title: text });
      cursor += text.length + 2;
      continue;
    }

    const type: BlockType =
      tag === "ul" || tag === "ol" ? "list" : tag === "table" ? "table" : "paragraph";
    parts.push(text);
    pushBlock(blocks, {
      type,
      text,
      headingPath,
      charStart: cursor,
      charEnd: cursor + text.length,
    });
    cursor += text.length + 2;
  }

  return { text: parts.join("\n\n"), blocks };
}

function stripTags(html: string): string {
  // Turn list items / breaks into newlines so structure survives the strip.
  return html
    .replace(/<\/(li|p|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
