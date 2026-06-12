import type { LlmClient } from "../llm/types.js";

const SYSTEM_PROMPT = `You are the image reader of MeOS, a personal second brain.
The user captured this image; turn it into text the knowledge pipeline can absorb.

Rules:
- Transcribe ALL legible text verbatim (signs, documents, screenshots, handwriting, labels). Preserve structure with markdown: headings, lists, tables.
- For charts and diagrams, state what they show and the concrete values or relationships they encode.
- For photos, describe what matters: who/what is shown, where, when (if inferable), and anything written or printed.
- Record facts, not speculation. If something is unreadable, say so rather than guessing.
- Output plain markdown only — no preamble, no commentary about the task.`;

/**
 * Read an image into markdown (transcription + factual description) so it can
 * flow through the normal text ingestion pipeline.
 */
export async function readImage(
  llm: LlmClient,
  filename: string,
  image: { mediaType: string; data: string },
): Promise<string> {
  return llm.complete({
    system: SYSTEM_PROMPT,
    cacheSystem: true,
    maxTokens: 4000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", mediaType: image.mediaType, data: image.data },
          { type: "text", text: `Filename: ${filename}` },
        ],
      },
    ],
  });
}
