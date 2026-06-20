import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for live agent-run frames, keyed by conversation id.
 *
 * Interactive chat streams its run straight down the requesting socket, but a
 * scheduled/"run now" agent task runs headlessly in the same process with no
 * client attached. This bus lets such a run broadcast the exact same SSE frames
 * ({@link runCodingAgent}'s `send` shape: reasoning / tool-call / delta / …) so the
 * Tasks view can open the task's conversation and watch it work in real time. It's
 * a transient fan-out only — every frame is also persisted onto the message — so a
 * viewer that connects mid-run simply refetches the finished transcript on `done`.
 */
export class ConversationStreamBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Each conversation is its own event name; many runs/viewers may coexist.
    this.emitter.setMaxListeners(0);
  }

  /** Broadcast one frame to everyone watching `conversationId`. */
  publish(conversationId: number, frame: object): void {
    this.emitter.emit(String(conversationId), frame);
  }

  /** Subscribe to a conversation's live frames; returns an unsubscribe function. */
  subscribe(conversationId: number, listener: (frame: object) => void): () => void {
    const key = String(conversationId);
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }
}
