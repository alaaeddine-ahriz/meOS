import type { Embedder } from "../embedding/embedder.js";
import { extractKnowledge } from "../extract/extractor.js";
import { readImage } from "../extract/image.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import { mergeExtraction, type MergeResult } from "../knowledge/merge.js";
import type { LlmClient } from "../llm/types.js";
import type { WikiWriter } from "../wiki/writer.js";
import { chunkText } from "./chunk.js";
import { imageMediaType, parseDocument } from "./parse.js";

export type IngestInput =
  | { kind: "file"; filename: string; buffer: Buffer; origin?: string; path?: string }
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
  /**
   * Ingest jobs may run concurrently (parse/embed/extract are independent),
   * but merges are serialized through this chain so two documents mentioning
   * the same new entity cannot both create it.
   */
  private mergeLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      store: KnowledgeStore;
      llm: LlmClient;
      embedder: Embedder;
      wiki: WikiWriter;
      postMerge?: PostMergeHook;
      /**
       * When provided, wiki regeneration is handed off here instead of running
       * inline — the server coalesces a batch of ingests into one regen pass
       * and the inbox item completes as soon as knowledge is merged.
       */
      scheduleWikiRefresh?: () => void;
    },
  ) {}

  private withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mergeLock.then(fn);
    this.mergeLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async ingest(input: IngestInput, existingInboxItemId?: number): Promise<IngestOutcome> {
    const { store, embedder, wiki } = this.deps;
    const title = input.kind === "file" ? input.filename : input.title;
    const inboxItemId = existingInboxItemId ?? store.createInboxItem(title);

    try {
      store.updateInboxItem(inboxItemId, "parsing");
      let parsed: { title: string; text: string } | null;
      if (input.kind === "file") {
        const mediaType = imageMediaType(input.filename);
        if (mediaType) {
          // Images carry no extractable text — the LLM reads them (OCR +
          // description) and the result flows through the text pipeline.
          const text = await readImage(this.deps.llm, input.filename, {
            mediaType,
            data: input.buffer.toString("base64"),
          });
          parsed = { title: title.replace(/\.[^.]+$/, ""), text };
        } else {
          parsed = await parseDocument(input.filename, input.buffer);
        }
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
        path: input.kind === "file" ? (input.path ?? input.filename) : undefined,
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
      const { merge, postMergeNote } = await this.withMergeLock(async () => {
        const merge = await mergeExtraction(store, embedder, extraction, sourceId);
        const postMergeNote = await this.deps.postMerge?.({ sourceId, merge });
        return { merge, postMergeNote };
      });

      if (this.deps.scheduleWikiRefresh) {
        this.deps.scheduleWikiRefresh();
      } else {
        await wiki.regenerateStale();
      }

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
