import { z } from "zod";

/**
 * The single error envelope every API error response follows. The server's
 * `setErrorHandler` produces this shape for every failure — validation errors,
 * not-found, conflicts, and uncaught exceptions alike — so the UI never has to
 * special-case ad-hoc `{ error: string }` bodies.
 *
 * - `code`        — a stable machine-readable identifier (see {@link ErrorCode}).
 * - `message`     — a human-readable, already-user-facing explanation.
 * - `details`     — optional structured context (e.g. Zod issues).
 * - `requestId`   — Fastify's `request.id`, for correlating logs to a response.
 * - `recoverable` — whether retrying or fixing the input can succeed (true for
 *                   4xx client errors, false for 5xx server faults).
 */
export const ErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  requestId: z.string(),
  recoverable: z.boolean(),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Stable, machine-readable error codes the client can branch on. */
export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
  CONFLICT: "CONFLICT",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
