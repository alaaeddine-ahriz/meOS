import { createLogger } from "./logger.js";
import type { MergeResult } from "./knowledge/merge.js";

const log = createLogger("events");

/**
 * Event bus (gist item 9): the seam that turns MeOS from a set of hand-wired
 * calls into an event-driven memory system. Core stages *emit* lifecycle events;
 * the server (or tests) *subscribe* to drive automation — re-ingest, contradiction
 * checks, crystallization, digests — without the stages knowing their consumers.
 *
 * Handlers are awaited so an emit can't outrun the work it triggers, and one
 * handler throwing never blocks the others (errors are reported, not swallowed
 * silently).
 */
export interface MeosEventMap {
  /** A source finished ingesting and merged into the graph. */
  onNewSource: { sourceId: number; merge: MergeResult };
  /** New observations were written (the seam contradiction checks hang off). */
  onMemoryWrite: { sourceId: number; newObservationIds: number[] };
  /** The assistant answered a chat turn — candidate to file back (crystallize). */
  onChatAnswer: { conversationId: number; messageId: number; question: string; answer: string };
  /** A conversation was closed / went idle — distill it into a session source. */
  onSessionEnd: { conversationId: number };
  /** The scheduled maintenance window fired. */
  onSchedule: { reason: "cron" | "manual" };
  /** A contradiction was detected and recorded for resolution. */
  onContradiction: { contradictionId: number; entityId: number };
}

export type MeosEvent = keyof MeosEventMap;
export type MeosEventHandler<E extends MeosEvent> = (
  payload: MeosEventMap[E],
) => void | Promise<void>;

export class MeosEvents {
  // One handler list per event. Stored loosely (the public on/emit signatures
  // keep each event's payload type sound; the variance across the union is only
  // an internal-storage concern).
  private readonly handlers = new Map<MeosEvent, Array<(payload: never) => void | Promise<void>>>();
  /** Reports a handler that threw; defaults to the structured logger, overridable for tests. */
  constructor(
    private readonly onError: (event: MeosEvent, error: unknown) => void = defaultOnError,
  ) {}

  on<E extends MeosEvent>(event: E, handler: MeosEventHandler<E>): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const current = this.handlers.get(event);
      if (current)
        this.handlers.set(
          event,
          current.filter((h) => h !== handler),
        );
    };
  }

  /** Fire an event, awaiting every handler. One failure never blocks the rest. */
  async emit<E extends MeosEvent>(event: E, payload: MeosEventMap[E]): Promise<void> {
    const list = this.handlers.get(event);
    if (!list || list.length === 0) return;
    await Promise.all(
      list.map(async (handler) => {
        try {
          await (handler as MeosEventHandler<E>)(payload);
        } catch (error) {
          this.onError(event, error);
        }
      }),
    );
  }
}

function defaultOnError(event: MeosEvent, error: unknown): void {
  log.error({ err: error, event }, `handler for "${event}" failed`);
}
