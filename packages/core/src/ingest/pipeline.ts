import { createHash } from "node:crypto";
import type { Embedder } from "../embedding/embedder.js";
import type { MeosEvents } from "../events.js";
import { extractKnowledgeMapReduce } from "../extract/map-reduce.js";
import type { Extraction } from "../extract/schema.js";
import { readImage } from "../extract/image.js";
import { loadSchema } from "../knowledge/schema-doc.js";
import { suggestMeetingLinks } from "../knowledge/meeting-links.js";
import { loadProfileContext } from "../profile/profile-doc.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import { mergeExtraction, type MergeResult } from "../knowledge/merge.js";
import { MEETING_SOURCE_TYPE } from "../knowledge/visibility.js";
import type { LlmClient } from "../llm/types.js";
import { createLogger } from "../logger.js";
import type { WikiWriter } from "../wiki/writer.js";
import { chunkBlocks } from "./chunk.js";
import { detectMeeting, type MeetingDetectionResult } from "./meeting-detect.js";
import { MEETING_EXTRACTION_LENS } from "./meeting.js";
import { blocksFromText, imageMediaType, parseDocument, type Block } from "./parse.js";

const log = createLogger("ingest-pipeline");

export type IngestInput =
  | { kind: "file"; filename: string; buffer: Buffer; origin?: string; path?: string }
  | {
      kind: "text";
      title: string;
      text: string;
      origin?: string;
      /**
       * A stable logical-source key (#16). When set, re-ingesting the same key
       * advances that source's revision history (superseding its prior facts)
       * instead of forking a new source — the meeting flow keys reprocess by
       * "meeting:<id>" so editing a note supersedes the previous version.
       */
      path?: string;
      /**
       * An extra extraction lens (#26) folded into the profile context for this
       * one ingest only — used to steer extraction of a typed source (e.g. a
       * meeting note toward decisions / action items / risks / open questions)
       * without changing the shared extractor prompt or the user's profile.
       */
      extractionLens?: string;
      /**
       * Invoked once extraction+merge succeeds, with the same Extraction that was
       * merged. The meeting flow uses it to derive + persist link suggestions
       * from the extracted entities without re-running the LLM.
       */
      onExtraction?: (context: {
        sourceId: number;
        revisionId: number;
        extraction: Extraction;
      }) => void | Promise<void>;
    };

export interface IngestOutcome {
  inboxItemId: number;
  sourceId?: number;
  /** The revision opened for this ingest (#16); set once parsing creates one. */
  sourceRevisionId?: number;
  /**
   * `done` — fully ingested (parsed, indexed, extracted, merged).
   * `indexed` — search/index committed but semantic extraction failed; the
   *   source IS searchable and the extraction stage is retryable (#13). The
   *   revision is left `incomplete` so it doesn't look fully ingested.
   * `failed` — failed before the source became searchable.
   * `unsupported` — no extractable text.
   */
  status: "done" | "indexed" | "failed" | "unsupported";
  /**
   * On `indexed` (extraction failed), the stage it failed at and the underlying
   * error message, so the durable worker records the real failing stage + error
   * on the job — surfaced verbatim in the Health view — instead of a generic
   * "extraction failed" wrapper.
   */
  failedStage?: "reading" | "indexing" | "extraction" | "merging";
  error?: string;
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
      /**
       * The extraction model's id, threaded into the extraction cache's version
       * tuple (#15) so a model change invalidates cached partials. Defaults to
       * "unknown" (e.g. the stub) — fine for cache scoping in tests.
       */
      extractionModelId?: string;
      /** Event bus; onNewSource / onMemoryWrite fire here for automation hooks. */
      events?: MeosEvents;
      /**
       * Auto-detect meeting notes during generic ingests and route them into the
       * meeting subsystem (#85). Defaults ON; set false to disable detection
       * entirely (documents still ingest as normal sources).
       */
      detectMeetings?: boolean;
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
    // Every ingest opens a source revision (#16); derived facts link to it so a
    // connector item that later changes/disappears can flag what it produced.
    const revisionId = store.createSourceRevision({
      sourceId,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
      normalizedContent: input.content,
    });

    const merge = await this.withMergeLock(async () => {
      const merge = await mergeExtraction(
        store,
        embedder,
        input.extraction,
        sourceId,
        input.content,
        revisionId,
      );
      for (const id of merge.staleEntityIds) store.recordStaleSource(id, sourceId);
      if (input.runPostMerge) await this.deps.postMerge?.({ sourceId, merge });
      return merge;
    });

    await this.deps.events?.emit("onMemoryWrite", {
      sourceId,
      newObservationIds: merge.newObservationIds,
    });
    await this.deps.events?.emit("onNewSource", { sourceId, merge });

    if (this.deps.scheduleWikiRefresh) {
      this.deps.scheduleWikiRefresh();
    } else {
      await this.deps.wiki.regenerateStale();
    }

    return { sourceId, merge };
  }

  /**
   * The connector materialization seam (#19), the document-shaped sibling of
   * {@link ingestExtraction}. Where `ingestExtraction` merges a pre-built
   * extraction with no document/chunks/revision, `materialize` turns a changed
   * connector item into a first-class local document BEFORE semantic extraction:
   *
   *   1. resolve/create the *logical source* for this external item — a re-sync of
   *      a changed item advances the SAME source's revision rather than forking a
   *      new source row (identity is owned by the caller via `existingSourceId`,
   *      which it reads from the connector ledger);
   *   2. open a new revision (#16) storing the RAW provider payload separately from
   *      the NORMALIZED human-readable text, and apply the source-type visibility
   *      defaults (#11);
   *   3. CHUNK + EMBED + INDEX the normalized text so the item is searchable even
   *      if extraction later fails (#13/#14) — the search commit lands first;
   *   4. run semantic extraction as a DERIVED stage off the saved revision, merging
   *      its observations/relationships linked to the exact `sourceRevisionId`.
   *
   * Extraction failure parks the revision `incomplete` and returns `indexed`: the
   * item stays searchable and the extraction is retryable, exactly like {@link
   * ingest}. The deterministic mappers (mapContact/…) stay the extraction source;
   * the seam is compatible with #15's cached map-reduce path for richer connectors.
   */
  async materialize(input: {
    /** Source origin, e.g. "google:contacts" — drives the visibility defaults + chip. */
    type: string;
    title: string;
    /** Deep link back to the underlying provider item. */
    path?: string;
    /** The raw provider payload, kept verbatim so a reprocess needs no re-fetch. */
    rawContent: string;
    /** A human-readable rendering of the item — what gets chunked, indexed, extracted. */
    normalizedContent: string;
    /** The deterministic mapping's pre-built extraction (the derived stage's input). */
    extraction: Extraction;
    /**
     * The logical source to advance, when this external item was materialized
     * before. Omit to create a fresh source. The caller resolves this from the
     * connector ledger so identity stays keyed by (account, kind, external_id).
     */
    existingSourceId?: number;
    /**
     * Index-only mode (the connector's "index" choice): merge the item's
     * entities/links and keep it searchable, but do NOT proactively author/rewrite
     * wiki pages from this sync. Affected pages are still flagged stale so a later
     * regeneration (triggered by a real document) reads this item as source
     * material — the wiki uses indexed items as sources without the sync itself
     * spinning up a wiki run. Defaults to false (the "wiki" path).
     */
    skipWikiRefresh?: boolean;
  }): Promise<{
    sourceId: number;
    sourceRevisionId: number;
    status: "done" | "indexed";
    merge?: MergeResult;
  }> {
    const { store, embedder } = this.deps;
    const contentHash = createHash("sha256").update(input.normalizedContent).digest("hex");

    // (1) Logical-source identity. A changed item advances its existing source;
    // a never-seen item opens a new one with the connector visibility defaults.
    let sourceId: number;
    if (input.existingSourceId && store.getSource(input.existingSourceId)) {
      sourceId = input.existingSourceId;
      store.updateSourceContent(sourceId, input.normalizedContent, input.rawContent);
      store.clearChunksForSource(sourceId);
    } else {
      sourceId = store.createSource({
        type: input.type,
        title: input.title,
        path: input.path,
        content: input.normalizedContent,
        rawContent: input.rawContent,
      });
    }

    // (2) Open this sync's revision; the prior active one is superseded so the
    // facts it backed become flag-able as outdated. Raw payload is stored apart
    // from the normalized text so a reprocess re-renders without a re-fetch.
    const revisionId = store.createSourceRevision({
      sourceId,
      contentHash,
      rawContent: input.rawContent,
      normalizedContent: input.normalizedContent,
    });

    // (3) The SEARCH/INDEX commit — lands independently of extraction (#13/#14),
    // so the item is searchable even if the derived extraction below fails.
    const blocks = blocksFromText(input.normalizedContent);
    const chunks = chunkBlocks(blocks);
    const vectors = await embedder.embed(chunks.map((c) => c.text));
    store.addChunks(
      sourceId,
      chunks.map((chunk, i) => ({
        text: chunk.text,
        embedding: vectors[i]!,
        sourceBlockIds: chunk.sourceBlockIds,
        sectionTitle: chunk.sectionTitle,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        tokenEstimate: chunk.tokenEstimate,
        contentType: chunk.contentType,
      })),
      revisionId,
    );

    // (4) Derived semantic extraction off the saved revision. Failure leaves the
    // index intact (searchable), parks the revision incomplete, and is retryable.
    try {
      const merge = await this.withMergeLock(async () => {
        const merge = await mergeExtraction(
          store,
          embedder,
          input.extraction,
          sourceId,
          input.normalizedContent,
          revisionId,
        );
        for (const id of merge.staleEntityIds) store.recordStaleSource(id, sourceId);
        // A re-sync may leave facts on the just-superseded revision; flag their
        // pages so the wiki reflects the now-outdated provenance.
        for (const id of store.entityIdsWithStaleBackedFacts()) store.markWikiStale(id);
        return merge;
      });

      await this.deps.events?.emit("onMemoryWrite", {
        sourceId,
        newObservationIds: merge.newObservationIds,
      });
      await this.deps.events?.emit("onNewSource", { sourceId, merge });

      // Index-only mode stops here: entities/links are merged and the item is
      // searchable + flagged stale, but the sync doesn't author the wiki itself.
      if (!input.skipWikiRefresh) {
        if (this.deps.scheduleWikiRefresh) {
          this.deps.scheduleWikiRefresh();
        } else {
          await this.deps.wiki.regenerateStale();
        }
      }

      return { sourceId, sourceRevisionId: revisionId, status: "done", merge };
    } catch {
      // Searchable, extraction retryable — mirror ingest()'s "indexed" outcome.
      store.setRevisionStatus(revisionId, "incomplete");
      return { sourceId, sourceRevisionId: revisionId, status: "indexed" };
    }
  }

  async ingest(input: IngestInput, existingInboxItemId?: number): Promise<IngestOutcome> {
    const { store, embedder, wiki } = this.deps;
    const title = input.kind === "file" ? input.filename : input.title;
    const inboxItemId = existingInboxItemId ?? store.createInboxItem(title);

    try {
      store.updateInboxItem(inboxItemId, "parsing");
      let parsed: { title: string; text: string; blocks?: Block[] } | null;
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

      // Meeting auto-detection (#85). A GENERIC file/text ingest is screened for
      // meeting shape; on a confident hit it is routed into the existing meeting
      // machinery (#26) — meeting source type, meeting extraction lens, and an
      // onExtraction that persists the structured row + link suggestions — WITHOUT
      // rewriting the document (it stays the citable source). Inputs that already
      // declare the meeting origin (the explicit POST /api/meetings path) are
      // skipped to avoid double-processing, as are connector materialize paths
      // (which don't flow through ingest()). Detection never breaks ingestion:
      // any failure logs and falls through to normal ingestion below.
      const detection = await this.maybeDetectMeeting(input, parsed);
      const origin = detection ? MEETING_SOURCE_TYPE : input.origin;
      const extractionLens = detection
        ? MEETING_EXTRACTION_LENS
        : input.kind === "text"
          ? input.extractionLens
          : undefined;

      // Logical-source identity (#16): a watched/uploaded file (or keyed text,
      // e.g. a meeting note) re-ingested at a known path advances the SAME
      // source's revision history instead of forking a fresh source row — so an
      // edit supersedes the prior version's facts rather than accumulating
      // duplicates. New paths (and all unkeyed pasted text) open a new source.
      const sourcePath = input.kind === "file" ? (input.path ?? input.filename) : input.path;
      const existing = sourcePath ? store.findSourceByPath(sourcePath) : undefined;
      let sourceId: number;
      if (existing) {
        sourceId = existing.id;
        store.updateSourceContent(sourceId, parsed.text);
        store.clearChunksForSource(sourceId);
      } else {
        sourceId = store.createSource({
          type: origin ?? input.kind,
          title: parsed.title,
          path: sourcePath,
          content: parsed.text,
        });
      }
      // Open this ingest's revision; if the source already had an active one it is
      // superseded here, so the facts it backed become flag-able as outdated.
      const revisionId = store.createSourceRevision({
        sourceId,
        contentHash: createHash("sha256").update(parsed.text).digest("hex"),
        normalizedContent: parsed.text,
      });
      store.updateInboxItem(inboxItemId, "parsing", undefined, sourceId);

      // Structure-aware chunking (#14): use the parser's blocks when available
      // (PDF pages, DOCX headings, CSV/JSON rows), else derive blocks from the
      // normalized text. Chunks carry section/page/span metadata for citations.
      // This is the SEARCH/INDEX commit — it lands independently of extraction
      // (#13), so a source is searchable even if the LLM extraction later fails.
      const blocks = parsed.blocks?.length ? parsed.blocks : blocksFromText(parsed.text);
      const chunks = chunkBlocks(blocks);
      const vectors = await embedder.embed(chunks.map((c) => c.text));
      // Idempotent re-index: drop any chunks a prior (crashed) attempt left on
      // this source before re-adding, so a re-run never duplicates search rows.
      store.clearChunksForSource(sourceId);
      store.addChunks(
        sourceId,
        chunks.map((chunk, i) => ({
          text: chunk.text,
          embedding: vectors[i]!,
          sourceBlockIds: chunk.sourceBlockIds,
          sectionTitle: chunk.sectionTitle,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          tokenEstimate: chunk.tokenEstimate,
          contentType: chunk.contentType,
        })),
        revisionId,
      );

      // The semantic-extraction stage. It is wrapped separately so its failure
      // doesn't undo the search index above: the source stays searchable, the
      // revision is parked `incomplete`, and the durable worker can retry just
      // this stage later (#13) without re-reading or re-parsing the file.
      try {
        await this.extractAndMerge({
          sourceId,
          revisionId,
          parsed,
          inboxItemId,
          extractionLens,
          // A detected meeting (#85) persists its structured row + link
          // suggestions here; an explicit text ingest uses its own callback.
          onExtraction: detection
            ? ({ sourceId: sid, extraction }) =>
                this.persistDetectedMeeting(sid, extraction, parsed.title, detection)
            : input.kind === "text"
              ? input.onExtraction
              : undefined,
        });
      } catch (error) {
        // Mark the revision incomplete so it doesn't look fully ingested, and
        // surface a retryable state. The caller (durable worker) re-runs the
        // extraction stage; on success the revision is promoted back to active.
        const message = error instanceof Error ? error.message : String(error);
        store.setRevisionStatus(revisionId, "incomplete");
        store.updateInboxItem(
          inboxItemId,
          "extract-failed",
          `searchable — extraction failed: ${message}`,
          sourceId,
        );
        return {
          inboxItemId,
          sourceId,
          sourceRevisionId: revisionId,
          status: "indexed",
          failedStage: "extraction",
          error: message,
        };
      }

      return { inboxItemId, sourceId, sourceRevisionId: revisionId, status: "done" };
    } catch (error) {
      store.updateInboxItem(
        inboxItemId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      return { inboxItemId, status: "failed" };
    }
  }

  /**
   * Run meeting auto-detection (#85) over a freshly-parsed generic ingest, or
   * return undefined when detection is disabled, the input is already a meeting
   * (the explicit POST /api/meetings path, which sets `origin === "meeting"`), or
   * the document doesn't clear the confidence threshold. Fully guarded: any
   * detection error logs and returns undefined so ingestion proceeds normally.
   */
  private async maybeDetectMeeting(
    input: IngestInput,
    parsed: { title: string; text: string },
  ): Promise<MeetingDetectionResult | undefined> {
    if (this.deps.detectMeetings === false) return undefined;
    // Never re-detect an explicit meeting (or any pre-typed origin): the meeting
    // flow already routes through here with origin "meeting".
    if (input.kind === "text" && input.origin) return undefined;
    if (input.kind === "file" && input.origin) return undefined;
    try {
      const result = await detectMeeting(parsed.text, parsed.title, this.deps.llm);
      if (!result.isMeeting) return undefined;
      log.info(
        { title: parsed.title, confidence: result.confidence },
        "ingest auto-classified as a meeting note",
      );
      return result;
    } catch (error) {
      log.warn({ err: error }, "meeting detection failed; ingesting as a normal source");
      return undefined;
    }
  }

  /**
   * Persist the structured meeting row + reviewable link suggestions for an
   * auto-detected meeting (#85), mirroring {@link processMeetingNote}'s
   * post-extraction step. Best-effort link matching to a synced calendar event is
   * attempted when a date is known. Never throws back into extraction in a way
   * that would undo the index: it logs and returns on failure.
   */
  private persistDetectedMeeting(
    sourceId: number,
    extraction: Extraction,
    parsedTitle: string,
    detection: MeetingDetectionResult,
  ): void {
    const { store } = this.deps;
    try {
      const suggestions = suggestMeetingLinks(store, extraction, sourceId);
      store.replaceMeetingLinkSuggestions(
        sourceId,
        suggestions.map((s) => ({
          entityId: s.entityId,
          rationale: s.rationale,
          method: s.method,
        })),
      );

      const attendees = detection.attendees ?? [];
      const date = detection.date ?? null;
      // Best-effort calendar linking (#85): match a synced google:calendar event
      // by date proximity + title/attendee overlap. Guarded — no calendar, no match.
      let linkedCalendarSourceId: number | null = null;
      if (date) {
        try {
          const match = store.findCalendarEventForMeeting({
            date,
            title: detection.title ?? parsedTitle,
            attendees,
          });
          linkedCalendarSourceId = match?.sourceId ?? null;
        } catch (error) {
          log.warn({ err: error, sourceId }, "calendar match failed for detected meeting");
        }
      }

      store.upsertMeetingNote({
        sourceId,
        meetingDate: date,
        attendees,
        detectionMethod: "auto",
        detectionConfidence: detection.confidence,
        linkedCalendarSourceId,
      });
    } catch (error) {
      // The source is still indexed + extracted; only the structured meeting
      // overlay failed. Log and leave it as a normal extracted source.
      log.warn({ err: error, sourceId }, "failed to persist detected meeting structure");
    }
  }

  /**
   * The semantic-extraction stage, factored out so it can run inline during a
   * fresh ingest OR be retried standalone for a source whose index already
   * landed but whose extraction failed (#13). Re-running is safe: `mergeExtraction`
   * reinforces near-duplicate observations rather than inserting new ones, and a
   * successful run re-promotes the revision to `active`. Throws on failure so the
   * caller can record a retryable error.
   */
  async extractAndMerge(args: {
    sourceId: number;
    revisionId: number;
    parsed: { title: string; text: string; blocks?: Block[] };
    inboxItemId?: number;
    /** A per-ingest extraction lens folded into the profile context (#26). */
    extractionLens?: string;
    /** Called with the merged extraction (meeting link suggestions ride here). */
    onExtraction?: (context: {
      sourceId: number;
      revisionId: number;
      extraction: Extraction;
    }) => void | Promise<void>;
  }): Promise<MergeResult> {
    const { store, embedder, wiki } = this.deps;
    const { sourceId, revisionId, parsed, inboxItemId } = args;

    if (inboxItemId) store.updateInboxItem(inboxItemId, "extracting");
    const schema = this.deps.dataDir ? loadSchema(this.deps.dataDir) : undefined;
    const baseProfile = this.deps.dataDir ? loadProfileContext(this.deps.dataDir) : "";
    // The per-ingest lens (e.g. a meeting note's decision/action focus) is folded
    // into the profile context so it steers the same extractor without changing
    // the shared prompt or the user's stored profile.
    const profile = args.extractionLens
      ? `${baseProfile ? `${baseProfile}\n\n` : ""}${args.extractionLens}`
      : baseProfile;
    // #15: size-gated extraction. Small documents keep the single-pass fast path;
    // large ones are extracted section-by-section (cached per revision + section
    // hash + version tuple) and deterministically reduced before the merge seam.
    const { extraction } = await extractKnowledgeMapReduce(this.deps.llm, parsed, {
      store,
      sourceRevisionId: revisionId,
      modelId: this.deps.extractionModelId ?? "unknown",
      schemaMd: schema,
      profileContext: profile,
      // Knowledge focus (#86): bias extraction toward enabled types/kinds. Unset
      // prefs resolve to all-enabled, so this is a no-op for an unconfigured install.
      preferences: store.getKnowledgePreferences(),
    });

    if (inboxItemId) store.updateInboxItem(inboxItemId, "merging");
    const { merge, postMergeNote } = await this.withMergeLock(async () => {
      const merge = await mergeExtraction(
        store,
        embedder,
        extraction,
        sourceId,
        parsed.text,
        revisionId,
      );
      // Credit this document for the pages it made stale; consumed when the
      // wiki regenerates and the resulting commit is attributed back to it.
      for (const id of merge.staleEntityIds) store.recordStaleSource(id, sourceId);
      // A re-ingest may leave facts behind that now hang off the just-superseded
      // revision — flag their pages so the wiki reflects the outdated provenance.
      for (const id of store.entityIdsWithStaleBackedFacts()) store.markWikiStale(id);
      const postMergeNote = await this.deps.postMerge?.({ sourceId, merge });
      return { merge, postMergeNote };
    });

    // A retried extraction on a previously-incomplete revision: promote it back
    // to active now that its facts have landed.
    if (store.getRevision(revisionId)?.status === "incomplete") {
      store.setRevisionStatus(revisionId, "active");
    }

    // Post-extraction hook (#26): the meeting flow derives + persists its link
    // suggestions from the same Extraction that was just merged. Runs after the
    // merge so the candidate entities (newly created or reinforced) already exist.
    await args.onExtraction?.({ sourceId, revisionId, extraction });

    // Automation hooks: a source landed, and memory was written. Subscribers
    // (contradiction checks, crystallization, etc.) react without the pipeline
    // knowing them. Awaited so failures surface to the caller.
    await this.deps.events?.emit("onMemoryWrite", {
      sourceId,
      newObservationIds: merge.newObservationIds,
    });
    await this.deps.events?.emit("onNewSource", { sourceId, merge });

    if (this.deps.scheduleWikiRefresh) {
      this.deps.scheduleWikiRefresh();
    } else {
      await wiki.regenerateStale();
    }

    if (inboxItemId) {
      store.updateInboxItem(
        inboxItemId,
        "done",
        `${merge.affectedEntityIds.length} entities touched, ` +
          `${merge.newObservationIds.length} new observations, ` +
          `${merge.reinforcedObservationIds.length} reinforced` +
          (postMergeNote ? ` — ${postMergeNote}` : ""),
        sourceId,
      );
    }
    return merge;
  }

  /**
   * Retry just the extraction stage for a source that was indexed but whose
   * extraction failed (#13). Reconstructs the parsed text from the revision's
   * stored normalized content — no file re-read, no re-parse — and re-runs
   * extract→merge. Returns the merge result, or null if the source/revision has
   * no recoverable content. Throws on extraction failure so the durable worker
   * can record a retryable error and re-queue with backoff.
   */
  async retryExtractionForSource(
    sourceId: number,
    inboxItemId?: number,
  ): Promise<MergeResult | null> {
    const { store } = this.deps;
    const revision = store.latestRevision(sourceId);
    const text = revision?.normalized_content ?? store.getSourceContent(sourceId);
    if (!revision || !text) return null;
    const title = store.getSourceTitle(sourceId) ?? "Document";
    return this.extractAndMerge({
      sourceId,
      revisionId: revision.id,
      parsed: { title, text },
      inboxItemId,
    });
  }
}
