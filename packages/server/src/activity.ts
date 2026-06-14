import { EventEmitter } from "node:events";
import type { KnowledgeStore, WikiRunHook, WikiRunSink, WikiRunStart } from "@meos/core";

/**
 * A live wiki-maintainer event, fanned out to any connected Activity clients.
 * `run-start` announces a new run (so the feed can show a card), `event` carries
 * one transcript step (reasoning/text arrive as incremental deltas; tool steps
 * are discrete), and `run-finish` stamps the terminal status. The shape mirrors
 * what gets persisted so live and replayed transcripts render identically.
 */
export type ActivityStreamEvent =
  | { type: "run-start"; runId: number; name: string; entityType: string; slug: string }
  | {
      type: "event";
      runId: number;
      kind: "reasoning" | "tool-call" | "tool-result" | "text";
      toolName?: string;
      /** Incremental text for reasoning/text; JSON-ish payload for tool steps. */
      payload: string;
    }
  | { type: "run-finish"; runId: number; status: "done" | "failed" };

/** Cap on a single tool payload so large file reads/writes don't bloat the DB or stream. */
const MAX_PAYLOAD = 4000;

function truncate(text: string): string {
  return text.length > MAX_PAYLOAD ? `${text.slice(0, MAX_PAYLOAD)}… (truncated)` : text;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return truncate(value);
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return truncate(String(value));
  }
}

/**
 * In-process pub/sub for wiki-maintainer transcripts. It is the {@link WikiRunHook}
 * the WikiWriter calls: each run's chunks are coalesced and persisted (so they
 * can be replayed later) and simultaneously published live to subscribers (so the
 * Activity view animates as the agent works).
 */
export class ActivityBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly store: KnowledgeStore) {
    // Many SSE clients may listen at once; lift Node's default 10-listener cap.
    this.emitter.setMaxListeners(0);
  }

  /** Subscribe to the live feed; returns an unsubscribe function. */
  subscribe(listener: (event: ActivityStreamEvent) => void): () => void {
    this.emitter.on("activity", listener);
    return () => this.emitter.off("activity", listener);
  }

  private publish(event: ActivityStreamEvent): void {
    this.emitter.emit("activity", event);
  }

  /** The hook handed to WikiWriter — opens a recording+broadcasting sink per run. */
  readonly hook: WikiRunHook = (start: WikiRunStart): WikiRunSink => {
    const runId = this.store.createWikiRun({
      entityId: start.entityId,
      name: start.name,
      type: start.type,
      slug: start.slug,
      sourceIds: start.sourceIds,
    });
    this.publish({ type: "run-start", runId, name: start.name, entityType: start.type, slug: start.slug });

    // Persist coalesced rows (consecutive reasoning/text deltas merge into one),
    // but publish deltas live for an incremental, IDE-like stream.
    let seq = 0;
    let buffer: { kind: "reasoning" | "text"; text: string } | null = null;
    const flush = () => {
      if (!buffer) return;
      this.store.appendWikiRunEvent(runId, { seq: seq++, kind: buffer.kind, payload: buffer.text });
      buffer = null;
    };

    return {
      event: (chunk) => {
        try {
          if (chunk.type === "reasoning" || chunk.type === "text") {
            if (buffer && buffer.kind === chunk.type) buffer.text += chunk.text;
            else {
              flush();
              buffer = { kind: chunk.type, text: chunk.text };
            }
            this.publish({ type: "event", runId, kind: chunk.type, payload: chunk.text });
            return;
          }
          flush();
          const isCall = chunk.type === "tool-call";
          const payload = stringify(isCall ? chunk.input : chunk.output);
          this.store.appendWikiRunEvent(runId, { seq: seq++, kind: chunk.type, toolName: chunk.toolName, payload });
          this.publish({ type: "event", runId, kind: chunk.type, toolName: chunk.toolName, payload });
        } catch (error) {
          // A persistence/broadcast hiccup must never break the agent run.
          console.error("[activity] failed to record run event:", error instanceof Error ? error.message : error);
        }
      },
      finish: (status) => {
        try {
          flush();
          this.store.finishWikiRun(runId, status);
        } catch (error) {
          console.error("[activity] failed to finish run:", error instanceof Error ? error.message : error);
        }
        this.publish({ type: "run-finish", runId, status });
      },
    };
  };
}
