import { ErrorCode, type ErrorEnvelope } from "@meos/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, type z } from "zod";

/**
 * A typed application error. Throw it from any route handler (or via the
 * {@link httpError} helpers) and the server's error handler turns it into the
 * standard error envelope with the right HTTP status. This replaces the ad-hoc
 * `reply.code(...).send({ error })` pattern.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** Whether the caller can fix the request and retry (true for 4xx). */
  readonly recoverable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { details?: unknown; recoverable?: boolean },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options?.details;
    // 4xx are client-fixable by default; 5xx are server faults.
    this.recoverable = options?.recoverable ?? status < 500;
  }
}

/** Concise constructors for the common HTTP error cases. */
export const httpError = {
  badRequest: (message: string, details?: unknown) =>
    new ApiError(400, ErrorCode.BAD_REQUEST, message, { details }),
  validation: (message: string, details?: unknown) =>
    new ApiError(400, ErrorCode.VALIDATION_ERROR, message, { details }),
  notFound: (message: string, details?: unknown) =>
    new ApiError(404, ErrorCode.NOT_FOUND, message, { details }),
  conflict: (message: string, details?: unknown) =>
    new ApiError(409, ErrorCode.CONFLICT, message, { details }),
  upstream: (message: string, details?: unknown) =>
    new ApiError(502, ErrorCode.UPSTREAM_ERROR, message, { details }),
  internal: (message: string, details?: unknown) =>
    new ApiError(500, ErrorCode.INTERNAL_ERROR, message, { details, recoverable: false }),
};

/** Flatten a ZodError into a stable, serialisable issue list for `details`. */
function zodDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Validate `data` against `schema`, throwing a VALIDATION_ERROR `ApiError`
 * (which becomes a 400 envelope) on failure. Use this in `preValidation` hooks
 * or inline at the top of a handler for body/params/query.
 */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  data: unknown,
  what = "request",
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw httpError.validation(`Invalid ${what}`, zodDetails(result.error));
  }
  return result.data;
}

/**
 * Register the single error handler that turns every thrown error — typed
 * {@link ApiError}, Fastify validation/serialization errors, and uncaught
 * exceptions — into the one error envelope shape, tagged with `request.id`.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    const envelope = (
      status: number,
      code: string,
      message: string,
      recoverable: boolean,
      details?: unknown,
    ): void => {
      const body: ErrorEnvelope = { code, message, requestId, recoverable };
      if (details !== undefined) body.details = details;
      void reply.code(status).send(body);
    };

    if (error instanceof ApiError) {
      envelope(error.status, error.code, error.message, error.recoverable, error.details);
      return;
    }

    // Zod errors that escaped a handler (e.g. a schema parse not wrapped).
    if (error instanceof ZodError) {
      envelope(400, ErrorCode.VALIDATION_ERROR, "Invalid request", true, zodDetails(error));
      return;
    }

    // Fastify's own schema validation failures (a per-route body/params/query
    // JSON schema rejected the request) carry `validation` context — surface
    // them as the same VALIDATION_ERROR a handler's `parseOrThrow` would, with
    // the offending fields in `details`, so the error code is identical whether
    // the route validates via an attached schema or inline.
    const fastifyError = error as {
      statusCode?: number;
      code?: string;
      message?: string;
      validation?: Array<{ instancePath?: string; message?: string }>;
    };
    if (fastifyError.code === "FST_ERR_VALIDATION" || fastifyError.validation) {
      const details = fastifyError.validation?.map((v) => ({
        path: (v.instancePath ?? "").replace(/^\//, "").replace(/\//g, "."),
        message: v.message ?? "invalid",
      }));
      envelope(400, ErrorCode.VALIDATION_ERROR, "Invalid request", true, details);
      return;
    }

    // Other Fastify 4xx faults (e.g. malformed JSON body, unsupported media
    // type) surface as a generic bad request.
    const statusCode = fastifyError.statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      envelope(statusCode, ErrorCode.BAD_REQUEST, fastifyError.message ?? "Bad request", true);
      return;
    }

    // Anything else is an unexpected server fault.
    request.log.error({ err: error }, "unhandled route error");
    envelope(500, ErrorCode.INTERNAL_ERROR, "Internal server error", false);
  });
}
