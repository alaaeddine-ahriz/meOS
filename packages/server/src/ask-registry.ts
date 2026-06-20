import { randomUUID } from "node:crypto";
import type { AskAnswerItem, AskQuestion } from "@meos/contracts";

/**
 * Mid-run questions: the rendezvous between a running coding agent and the user.
 *
 * An agent in agent mode runs headless (no TTY to prompt), so to ask the user
 * something it calls the `ask_user` MCP tool, which POSTs to `/api/agent/ask`.
 * That request must BLOCK until the user answers — but the user answers over a
 * *different* connection (the chat SSE stream → a click → POST
 * `/api/agent/ask/answer`). This module is the in-process bridge between the two:
 * a run registers its SSE `send` under an opaque `op` id (threaded to the agent's
 * MCP child via the `MEOS_AGENT_OP` env var); `requestAsk` emits the question on
 * that stream and parks a promise; `deliverAskAnswer` resolves it. Everything is
 * in the one server process, so a plain `Map` suffices — no IPC, no persistence.
 */

type Send = (event: Record<string, unknown>) => void;

export type AskStatus = "answered" | "timeout" | "cancelled" | "unavailable";
export interface AskResult {
  status: AskStatus;
  answers: AskAnswerItem[];
}

interface Operation {
  send: Send;
  /** Aborts when the chat client disconnects (Stop button / tab close); cancels open questions. */
  signal?: AbortSignal;
  pending: Map<string, (result: AskResult) => void>;
}

/** Default ceiling for a single question, kept under Node's 300s request timeout. */
const DEFAULT_ASK_TIMEOUT_MS = 270_000;

const operations = new Map<string, Operation>();

/** Begin a run: future `ask_user` calls tagged with `op` route to this stream. */
export function registerAskOperation(op: string, send: Send, signal?: AbortSignal): void {
  operations.set(op, { send, signal, pending: new Map() });
}

/** End a run: drop it and resolve any still-open questions as cancelled. */
export function unregisterAskOperation(op: string): void {
  const operation = operations.get(op);
  if (!operation) return;
  for (const resolve of operation.pending.values()) {
    resolve({ status: "cancelled", answers: [] });
  }
  operation.pending.clear();
  operations.delete(op);
}

/**
 * Pose questions to the user and wait for the answer. Emits an `ask-user` frame
 * on the run's chat SSE stream, then parks until {@link deliverAskAnswer} fires,
 * the run is aborted/unregistered, or the wait times out. Returns a `status`
 * the caller turns into agent-readable text, so the agent always gets a usable
 * reply — even when there's no one to answer.
 */
export function requestAsk(
  op: string,
  questions: AskQuestion[],
  timeoutMs: number = DEFAULT_ASK_TIMEOUT_MS,
): Promise<AskResult> {
  const operation = operations.get(op);
  // No live run for this op (e.g. the turn already ended): tell the agent to proceed.
  if (!operation) return Promise.resolve({ status: "unavailable", answers: [] });
  if (operation.signal?.aborted) return Promise.resolve({ status: "cancelled", answers: [] });

  const id = randomUUID();
  return new Promise<AskResult>((resolve) => {
    let settled = false;
    const settle = (result: AskResult) => {
      if (settled) return;
      settled = true;
      operation.pending.delete(id);
      clearTimeout(timer);
      operation.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => settle({ status: "cancelled", answers: [] });
    const timer = setTimeout(() => settle({ status: "timeout", answers: [] }), timeoutMs);

    operation.pending.set(id, (result) => settle(result));
    operation.signal?.addEventListener("abort", onAbort, { once: true });
    operation.send({ type: "ask-user", op, id, questions });
  });
}

/**
 * Deliver the user's answer to a parked question. Returns false when no such
 * question is open (already answered, timed out, or the run ended) so the
 * answer route can report it instead of silently dropping the click.
 */
export function deliverAskAnswer(op: string, id: string, answers: AskAnswerItem[]): boolean {
  const resolve = operations.get(op)?.pending.get(id);
  if (!resolve) return false;
  resolve({ status: "answered", answers });
  return true;
}
