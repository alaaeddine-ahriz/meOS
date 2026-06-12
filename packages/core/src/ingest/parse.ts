import path from "node:path";

export interface ParsedDocument {
  title: string;
  text: string;
}

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text", ".csv", ".json", ".org"]);

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

/**
 * Extract plain text from an uploaded file. Returns null for formats MeOS
 * cannot read yet — the caller surfaces those in the Inbox as "unsupported".
 */
export async function parseDocument(filename: string, buffer: Buffer): Promise<ParsedDocument | null> {
  const ext = path.extname(filename).toLowerCase();
  const title = path.basename(filename, ext);

  if (TEXT_EXTENSIONS.has(ext)) {
    return { title, text: buffer.toString("utf-8") };
  }

  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return { title, text };
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return { title, text: result.value };
  }

  return null;
}
