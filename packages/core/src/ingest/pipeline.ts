import type { Embedder } from "../embedding/embedder.js";
import { extractKnowledge } from "../extract/extractor.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import { mergeExtraction, type MergeResult } from "../knowledge/merge.js";
import type { LlmClient } from "../llm/types.js";
import type { WikiWriter } from "../wiki/writer.js";
import { chunkText } from "./chunk.js";
import { parseDocument } from "./parse.js";

export type IngestInput =
  | { kind: "file"; filename: string; buffer: Buffer; origin?: string }
  | { kind: "text"; title: string; text: string; origin?: string };

export interface IngestOutcome {
  inboxItemId: number;
  sourceId?: number;
  status: "done" | "failed" | "unsupported";
}

/**
 * Hook invoked after merge, before wiki regeneration. Phase 2 wires
 * contradiction detection through this seam; a returned string is appended
 * to the inbox item's final status detail.
 */
export type PostMergeHook = (context: {
  sourceId: number;
  merge: MergeResult;
}) => Promise<string | void>;

export class IngestionPipeline {
  constructor(
    private readonly deps: {
      store: KnowledgeStore;
      llm: LlmClient;
      embedder: Embedder;
      wiki: WikiWriter;
      postMerge?: PostMergeHook;
    },
  ) {}

  async ingest(input: IngestInput, existingInboxItemId?: number): Promise<IngestOutcome> {
    const { store, embedder, wiki } = this.deps;
    const title = input.kind === "file" ? input.filename : input.title;
    const inboxItemId = existingInboxItemId ?? store.createInboxItem(title);

    try {
      store.updateInboxItem(inboxItemId, "parsing");
      let parsed: { title: string; text: string } | null;
      if (input.kind === "file") {
        parsed = await parseDocument(input.filename, input.buffer);
      } else {
        parsed = { title: input.title, text: input.text };
      }
      if (!parsed || !parsed.text.trim()) {
        store.updateInboxItem(
          inboxItemId,
          "unsupported",
          parsed ? "Document contains no extractable text" : "Unsupported file type",
        );
        return { inboxItemId, status: "unsupported" };
      }

      const sourceId = store.createSource({
        type: input.origin ?? input.kind,
        title: parsed.title,
        path: input.kind === "file" ? input.filename : undefined,
        content: parsed.text,
      });
      store.updateInboxItem(inboxItemId, "parsing", undefined, sourceId);

      const chunks = chunkText(parsed.text);
      const vectors = await embedder.embed(chunks);
      store.addChunks(
        sourceId,
        chunks.map((text, i) => ({ text, embedding: vectors[i]! })),
      );

      store.updateInboxItem(inboxItemId, "extracting");
      const extraction = await extractKnowledge(this.deps.llm, parsed);

      store.updateInboxItem(inboxItemId, "merging");
      const merge = await mergeExtraction(store, embedder, extraction, sourceId);

      const postMergeNote = await this.deps.postMerge?.({ sourceId, merge });

      await wiki.regenerateStale();

      store.updateInboxItem(
        inboxItemId,
        "done",
        `${merge.affectedEntityIds.length} entities touched, ` +
          `${merge.newObservationIds.length} new observations, ` +
          `${merge.reinforcedObservationIds.length} reinforced` +
          (postMergeNote ? ` — ${postMergeNote}` : ""),
      );
      return { inboxItemId, sourceId, status: "done" };
    } catch (error) {
      store.updateInboxItem(inboxItemId, "failed", error instanceof Error ? error.message : String(error));
      return { inboxItemId, status: "failed" };
    }
  }
}
