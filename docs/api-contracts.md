# API contracts

The meOS HTTP surface is governed by a single source of truth: the
**`@meos/contracts`** package. Every request and response shape is a Zod schema
there; the server validates against it, the web client is typed by it, and the
OpenAPI spec is generated from it. This document is the contract between server
and client — read it before changing any endpoint.

## The pieces

| Concern                  | Where                                                               | Notes                                                                                   |
| ------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Request/response schemas | `packages/contracts/src/schemas/*`                                  | One file per route group; Zod v4.                                                       |
| Inferred TS types        | `packages/contracts/src/index.ts`                                   | Re-exported for the web client (types only).                                            |
| Error envelope           | `packages/contracts/src/error.ts`                                   | `ErrorEnvelopeSchema`, `ErrorCode`.                                                     |
| Server error handler     | `packages/server/src/errors.ts`                                     | Maps every thrown error → the envelope.                                                 |
| Per-route schema attach  | `packages/server/src/route-schema.ts`                               | `routeSchema(...)` → Fastify `schema`.                                                  |
| OpenAPI spec             | `packages/server/src/openapi.ts` → `/api/openapi.json`, `/api/docs` | Built from the route schemas + shared `ErrorEnvelope` component.                        |
| Typed client             | `packages/web/src/api.ts`                                           | Hand-written; every method returns a contract-inferred type; failures throw `ApiError`. |

## The error model

Every failure — validation, not-found, conflict, upstream, or an uncaught
exception — is serialized as the one envelope:

```ts
{
  code: "VALIDATION_ERROR" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT" | "UPSTREAM_ERROR" | "INTERNAL_ERROR";
  message: string;        // already user-facing
  details?: unknown;      // optional structured context (e.g. Zod issues)
  requestId: string;      // correlates with the server log line
  recoverable: boolean;   // true for 4xx client-fixable errors, false for 5xx faults
}
```

- The server produces it via `setErrorHandler` (see `errors.ts`). Throw an
  `ApiError` or use the `httpError.*` constructors; Fastify schema-validation
  failures are mapped to `VALIDATION_ERROR` automatically.
- The client parses it in `throwApiError` and raises a typed `ApiError`
  (`packages/web/src/api.ts`) carrying the same fields, so UI code can branch on
  `error.code` and show `error.message` directly.

This shape is **stable**: the codes and field names do not change without a major
version bump of `@meos/contracts`.

## Backwards-compatibility rules

The contract is a public interface between two independently shipped layers
(server and the desktop/web client, which can be on different versions). Treat
changes the way you would treat a published API:

- **Additive only.** You may add a new optional response field, a new endpoint,
  or a new `ErrorCode`. New request fields must be optional (the server must
  accept a body that omits them).
- **Never remove or rename a response field** without a version bump. The web
  client and any in-the-wild desktop builds read those fields by name.
- **Never repurpose a field's meaning or narrow its type.** Widening (e.g.
  adding an enum member to a response) is additive; narrowing (removing one) is
  breaking.
- **The error envelope is frozen.** Do not change `code`/`message`/`details`/
  `requestId`/`recoverable` names or types, and do not remove an `ErrorCode`.
- Response schemas are enforced at runtime: handlers parse their output through
  the contract schema before sending, and Fastify serializes against the same
  schema. A field that isn't in the contract is **stripped** from the response —
  so adding a field to a response means adding it to the contract first.

## How to add or change an endpoint

Schema-first, in this order. Each step has a guard that fails CI if you skip it.

1. **Contract.** Add or extend the Zod schema in
   `packages/contracts/src/schemas/<group>.ts`. Export the inferred response type
   from `packages/contracts/src/index.ts` if the client needs it. Build the
   package: `pnpm --filter @meos/contracts build`.
2. **Route.** In `packages/server/src/routes/<group>.ts`, register the handler
   with a `schema` built by `routeSchema({ tags, summary, body, params,
querystring, response })`. Validate the request with `parseOrThrow(schema,
…)` and **parse the response object through its contract schema** before
   returning (`Schema.parse({ … })`). This is what keeps the server honest.
3. **Client.** Add a method to `packages/web/src/api.ts` whose return type is the
   contract-inferred type (no `any`, no inline duplicate shape). Use the `json<T>`
   helper so failures surface as a typed `ApiError`.
4. **Test.** Add to `packages/server/test/<group>.test.ts`: a success-path test
   that parses the response through the contract schema, and an error-path test
   that asserts the body matches `ErrorEnvelopeSchema` with the expected `code`.
   The OpenAPI smoke test (`test/openapi.test.ts`) checks the spec parses and
   documents the shared error component and a representative set of paths.

### Streaming endpoints

`POST /api/chat` and `GET /api/activity/stream` hijack the socket to emit
Server-Sent Events. They have no JSON response schema (the reply is hijacked);
their event shapes are still defined in the contracts (`chat.ChatEventSchema`,
`activity.ActivityStreamEventSchema`) and consumed by the client's
`streamChat` / `streamActivity` generators.

### Endpoints that return Markdown

`GET /api/outputs/*` returns portable Markdown as `text/markdown` by default and
`{ markdown }` JSON only when `?format=json` is set. Because one handler serves
both shapes, no JSON response schema is attached; the JSON branch is typed by
`outputs.OutputJsonResponse`.

## Verifying

```sh
pnpm --filter @meos/contracts build   # contract types compile
pnpm --filter @meos/server build      # routes type-check against the contracts
pnpm --filter @meos/server test       # success + error contract tests, OpenAPI smoke
pnpm --filter @meos/web build         # the client type-checks against the contracts
pnpm boundaries                       # web imports only @meos/contracts (no server/core)
```

CI runs `pnpm build`, `pnpm typecheck`, and `pnpm test` (which includes the
server contract suite) on every push, so the contract tests are the CI gate.
