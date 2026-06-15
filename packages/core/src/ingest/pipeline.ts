import type { Embedder } from "../embedding/embedder.js";
import type { MeosEvents } from "../events.js";
import { extractKnowledge } from "../extract/extractor.js";
import type { Extraction } from "../extract/schema.js";
import { readImage } from "../extract/image.js";
import { loadSchema } from "../knowledge/schema-doc.js";
import { loadProfileContext } from "../profile/profile-doc.js";
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
      /** Data dir to read the user's schema document from for extraction. */
      dataDir?: string;
      /** Event bus; onNewSource / onMemoryWrite fire here for automation hooks. */
      events?: MeosEvents;
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

  /**
   * Deterministic sibling of {@link ingest}: integrate a pre-built extraction
   * (e.g. a Google contact mapped without an LLM) through the *same* merge seam —
   * the shared `mergeLock`, the `onMemoryWrite`/`onNewSource` events, and the
   * batched wiki refresh. No parse/chunk/embed of `content` (observations are
   * already embedded + FTS-indexed by `mergeExtraction`; chunking the small
   * metadata blob would add cost for no retrieval benefit) and no inbox row
   * (connectors aren't documents). `postMerge` (contradiction detection, an LLM
   * call) is skipped by default — running it per email would defeat the
   * deterministic, no-LLM-cost design.
   */
  async ingestExtraction(input: {
    /** Source origin, e.g. "google:contacts" — surfaces as a typed source chip. */
    type: string;
    title: string;
    /** A small metadata blob kept for provenance/citation (not chunked). */
    content: string;
    /** A deep link back to the underlying item (Gmail/Calendar/Contacts URL). */
    path?: string;
    extraction: Extraction;
    /** Opt in to contradiction detection (off by default — no per-item LLM cost). */
    runPostMerge?: boolean;
  }): Promise<{ sourceId: number; merge: MergeResult }> {
    const { store, embedder } = this.deps;
    const sourceId = store.createSource({
      type: input.type,
      title: input.title,
      path: input.path,
      content: input.content,
    });

    const merge = await this.withMergeLock(async () => {
      const merge = await mergeExtraction(store, embedder, input.extraction, sourceId, input.content);
      for (const id of merge.staleEntityIds) store.recordStaleSource(id, sourceId);
      if (input.runPostMerge) await this.deps.postMerge?.({ sourceId, merge });
      return merge;
    });

    await this.deps.events?.emit("onMemoryWrite", { sourceId, newObservationIds: merge.newObservationIds });
    await this.deps.events?.emit("onNewSource", { sourceId, merge });

    if (this.deps.scheduleWikiRefresh) {
      this.deps.scheduleWikiRefresh();
    } else {
      await this.deps.wiki.regenerateStale();
    }

    return { sourceId, merge };
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
      const schema = this.deps.dataDir ? loadSchema(this.deps.dataDir) : undefined;
      const profile = this.deps.dataDir ? loadProfileContext(this.deps.dataDir) : "";
      const extraction = await extractKnowledge(this.deps.llm, parsed, schema, profile);

      store.updateInboxItem(inboxItemId, "merging");
      const { merge, postMergeNote } = await this.withMergeLock(async () => {
        const merge = await mergeExtraction(store, embedder, extraction, sourceId, parsed.text);
        // Credit this document for the pages it made stale; consumed when the
        // wiki regenerates and the resulting commit is attributed back to it.
        for (const id of merge.staleEntityIds) store.recordStaleSource(id, sourceId);
        const postMergeNote = await this.deps.postMerge?.({ sourceId, merge });
        return { merge, postMergeNote };
      });

      // Automation hooks: a source landed, and memory was written. Subscribers
      // (contradiction checks, crystallization, etc.) react without the pipeline
      // knowing them. Awaited inside the try so failures surface on the item.
      await this.deps.events?.emit("onMemoryWrite", { sourceId, newObservationIds: merge.newObservationIds });
      await this.deps.events?.emit("onNewSource", { sourceId, merge });

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
