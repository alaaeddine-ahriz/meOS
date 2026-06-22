# AI Backend Parity Ledger

> Single source of truth for: **does every AI-powered feature work under BOTH
> intelligence backends** — `{backend:"api"}` (metered cloud key) and
> `{backend:"agent"}` (local coding-agent CLI) — and is it **proven by tests**?
>
> The whole app runs on one global switch: `IntelligenceRouting.backend` in
> `packages/core/src/llm/intelligence-routing.ts`. `resolveGroupClient(group,
config, routing, installedAgents, mcpServers?)` returns the cloud
> `createLlmClient(config)` (→ `AiSdkClient`) for `"api"`, or a
> `CodingAgentLlmClient` (`packages/core/src/llm/coding-agent-client.ts`) for
> `"agent"`. Every feature must obtain its client through this seam
> (`ctx.llm` / `ctx.llmFor(group)` / a passed-in `llm` param tracing back to a
> group client) — never a directly-constructed provider/AI-SDK client.

## Status legend

- ⬜ todo · 🟡 wip / partial coverage · ✅ proven this run (passing run quoted in the iteration report) · 🚫 documented N/A (code-enforced)

## Bootstrap finding (iteration 1)

A full audit (`graphify query` + greps for `@ai-sdk`, `createOpenRouter`,
`generateText`, `streamText`, `generateObject`, `anthropic`, `openai`, `google`,
`createLlmClient(` outside the seam) found:

- **ZERO direct-SDK bypasses.** Every `generateText`/`generateObject`/`streamText`
  lives inside the seam body `packages/core/src/llm/ai-sdk.ts`. Provider SDK
  imports (`@ai-sdk/anthropic|google|openai`) appear only in `llm/index.ts`.
  `createLlmClient(` is called outside `intelligence-routing.ts` only in the
  server boot/swap/probe wiring (`server/src/context.ts:210,300,388`,
  `server/src/routes/settings.ts:69`) — all legitimate.
- **Every feature already routes through the seam.** No row needs the §2a
  "reroute through the switch" fix. `CodingAgentLlmClient` already implements all
  five `LlmClient` methods (`complete`, `completeStructured` w/ schema-in-prompt
  - retry×2 + API fallback, `stream`, `runAgent` w/ sandbox bridge, `streamAgent`).
- **Therefore the remaining work is PROOF, not rerouting.** Each row needs (i) an
  ungated offline CONTRACT test that the feature's real method path returns correct
  output through the routed client on BOTH backends (api via a conforming stub /
  cloud-shaped client; agent via `CodingAgentLlmClient` over a scripted fake agent),
  and (ii) a LIVE test in the `MEOS_LIVE_AGENT=1` family running the real agent.

`api` column convention: existing offline suites drive each feature with
`StubLlmClient` (a deterministic stand-in for a well-behaved structured cloud
client). That proves the api-side method-path wiring; it is marked 🟡 until
re-verified in that feature's iteration, then ✅. The real cloud `AiSdkClient` is
the shipped default and is not exercised offline (needs a key).

`agent` column convention: ✅ requires the feature's real method path returning
correct output through `CodingAgentLlmClient` — proven offline (scripted fake
agent) AND, where feasible, live.

## Ledger

| #   | Feature                 | Call site (file:fn:line)                                                                                        | Method                  | api | agent | contract test                                                 | live test                            | notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------- | --- | ----- | ------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Knowledge extraction    | `core/src/extract/extractor.ts:extractKnowledge:42` (+ map-reduce wrapper `extract/map-reduce.ts:167`)          | `completeStructured`    | ✅  | ✅    | `extraction-parity.test.ts` (api+agent)                       | `live-agent-ingest.test.ts` ✓        | background. PROVEN iter 2: offline contract `extraction-parity.test.ts` (3/3) — api via conforming stub, agent via `CodingAgentLlmClient` over a scripted agent (raw JSON + ```json-fence recovery, throwing fallback). Live `live-agent-ingest.test.ts`(2/2, real claude 2.1.172). New shared harness`fixtures/index.ts:makeAgentClient/ScriptedAgent/failingFallback`.                                                            |
| 2   | Meeting detection       | `core/src/ingest/meeting-detect.ts:detectMeeting:154`                                                           | `completeStructured`    | ✅  | ✅    | `meeting-detect-parity.test.ts` (api+agent)                   | `live-agent-meeting.test.ts` ✓       | background. PROVEN iter 3: contract `meeting-detect-parity.test.ts` (2/2) + live `live-agent-meeting.test.ts` (1/1, real claude, 16.5s). detectMeeting SWALLOWS LLM errors → heuristic-only, so tests assert LLM-only outputs (date + attendees) to prove the model classification flowed through, not the heuristic/fallback. Shared fixtures: `meetingNoteDocument`, `meetingClassification`.                                     |
| 3   | Contradiction judgement | `core/src/memory/contradictions.ts:detectContradictions:61`                                                     | `completeStructured`    | ✅  | ✅    | `contradiction-parity.test.ts` (api+agent)                    | `live-agent-contradiction.test.ts` ✓ | background. PROVEN iter 4: contract `contradiction-parity.test.ts` (2/2) + live `live-agent-contradiction.test.ts` (1/1, real claude, 17.8s). Seeds Dana Paris→Berlin supersession. Feature does NOT swallow LLM errors → throwing fallback surfaces failures, so agent must produce schema-valid JSON referencing the prompt's numeric ids. Two wiring points (nightly `consolidate.ts:73`, per-ingest `context.ts:368`); same fn. |
| 4   | Session crystallization | `core/src/memory/crystallize.ts:crystallizeSession:83`                                                          | `completeStructured`    | ✅  | ✅    | `crystallize-parity.test.ts` (api+agent)                      | `live-agent-crystallize.test.ts` ✓   | background. PROVEN iter 5: contract `crystallize-parity.test.ts` (2/2) + live `live-agent-crystallize.test.ts` (1/1, real claude, 71.7s). Makes TWO sequential structured calls (session_digest → knowledge_extraction); agent scripted reply branches on the schema name in the prompt, throwing fallback proves the agent produced valid JSON for BOTH.                                                                           |
| 5   | Nightly digest          | `core/src/memory/consolidate.ts:runConsolidation:143`                                                           | `complete`              | ✅  | ✅    | `digest-parity.test.ts` (api+agent)                           | `live-agent-digest.test.ts` ✓        | background. Plain text output. PROVEN iter 6: contract `digest-parity.test.ts` (2/2) + live `live-agent-digest.test.ts` (1/1, real claude, 18.3s). Isolated the digest `complete` by omitting embedder (skip crystallizeChat) + `regenerateWiki:false` (skip wiki runAgent); assert the routed client's own text is persisted as the digest (store + disk), throwing fallback. First non-structured `complete` row.                 |
| 6   | Image OCR               | `core/src/extract/image.ts:readImage:22`                                                                        | `complete` (multimodal) | 🟡  | 🟫    | —                                                             | —                                    | background. Agent CLI can't ingest images → `CodingAgentLlmClient` delegates to the cloud `fallback` BY DESIGN (§4.1). Must be proven as an EXPLICIT, asserted fallback (not silent).                                                                                                                                                                                                                                               |
| 7   | Profile assistant ×3    | `core/src/profile/profile-assistant.ts:proposeProfile:81` (draft-from-context/knowledge, edit-with-instruction) | `completeStructured`    | 🟡  | ⬜    | `profile.test.ts` (stub)                                      | —                                    | assistant group. All 3 entry points share `proposeProfile`.                                                                                                                                                                                                                                                                                                                                                                         |
| 8   | Wiki maintainer         | `core/src/wiki/writer.ts:WikiWriter.regenerate:576`                                                             | `runAgent`              | 🟡  | ⬜    | `wiki-runs.test.ts` / `pipeline.test.ts` (stub)               | —                                    | wiki group; server supplies meos MCP servers. Sandbox bridge tested at client level (`coding-agent-client.test.ts`) but not wired through `WikiWriter`.                                                                                                                                                                                                                                                                             |
| 9   | Agentic chat            | `core/src/chat/chat.ts:ChatService.respond:123`                                                                 | `streamAgent`           | 🟡  | ⬜    | `chat.test.ts` (stub)                                         | —                                    | rides background client. Per-message `agent` toggle path.                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | Health / circuit probe  | `server/src/context.ts:probe:418`                                                                               | `complete`              | ✅  | 🚫    | `server/test/source-health.test.ts` / `provider-hold.test.ts` | n/a                                  | **Forced API by design** (a CLI "ping" is absurd). Code-enforced: uses a dedicated `probeClient = new SwitchableLlmClient(createLlmClient(config))` (`context.ts:388`), never a group client. Verify the code-enforcement assertion in that feature's iteration.                                                                                                                                                                    |

## Out of scope (not LLM inference through the seam)

| Concern                   | Where                                                                                    | Why N/A                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🚫 Embeddings             | `core/src/embedding/embedder.ts` (`LocalEmbedder` ONNX worker; `HashEmbedder` for tests) | On-device vector generation, no network, not an `LlmClient` call. Parallel intelligence path; not backend-switched.                                                                                                           |
| 🚫 Connector `agentTools` | `core/src/connectors/{google,github,template}`                                           | `AgentToolContext` has `{store, embedder, enabledKinds, getAccessToken}` — no `LlmClient`. Tools call provider REST / local store; they do NOT perform inference. The LLM that drives them is the chat `streamAgent` (row 9). |

## Definition of done

1. Every ledger row ✅, or 🚫 documented AND code-enforced, on BOTH backends.
2. A fresh audit surfaces ZERO LLM call sites outside the seam and ZERO features
   missing from this ledger.
3. Repo typecheck + full offline suite pass, AND the entire `MEOS_LIVE_AGENT=1`
   suite passes against a real agent.

## Iteration log

- **Iter 1 (bootstrap)** — Built this inventory from design §6 + a full graphify/grep
  audit. Branch `feat/ai-backend-parity` created. Finding: seam is clean (no
  bypasses); `CodingAgentLlmClient` complete; remaining work is per-feature proof.
  No fixes this iteration. Next: row 1 (knowledge extraction) — add an offline
  agent-backed contract test (scripted fake agent) to complement the existing live test.
- **Iter 2 (row 1: knowledge extraction)** — Added shared offline agent harness
  (`ScriptedAgent`, `failingFallback`, `makeAgentClient`) to `test/fixtures/index.ts`
  and `test/extraction-parity.test.ts` proving `extractKnowledge` on both backends.
  Contract: `pnpm --filter @meos/core exec vitest run test/extraction-parity.test.ts`
  → 3/3 passed. Live: `MEOS_LIVE_AGENT=1 … test/live-agent-ingest.test.ts` → 2/2
  passed (real claude 2.1.172, 81s). Row 1 🟡/🟡 → ✅/✅. Next: row 2 (meeting detection).
- **Iter 3 (row 2: meeting detection)** — Added shared meeting fixtures
  (`meetingNoteDocument`, `meetingClassification`), `test/meeting-detect-parity.test.ts`
  (both backends), and `test/live-agent-meeting.test.ts`. Contract:
  `pnpm --filter @meos/core exec vitest run test/meeting-detect-parity.test.ts` → 2/2.
  Live: `MEOS_LIVE_AGENT=1 … test/live-agent-meeting.test.ts` → 1/1 (real claude, 16.5s).
  Key: detectMeeting swallows LLM errors to heuristic-only, so the proof asserts
  LLM-only outputs (date + attendees). Row 2 🟡/⬜ → ✅/✅. Next: row 3 (contradiction judgement).
- **Iter 4 (row 3: contradiction judgement)** — Added `test/contradiction-parity.test.ts`
  (both backends) and `test/live-agent-contradiction.test.ts`, seeding the Dana
  Paris→Berlin supersession in a real KnowledgeStore. Contract:
  `pnpm --filter @meos/core exec vitest run test/contradiction-parity.test.ts` → 2/2.
  Live: `MEOS_LIVE_AGENT=1 … test/live-agent-contradiction.test.ts` → 1/1 (real claude, 17.8s).
  Feature doesn't swallow LLM errors, so the throwing fallback guarantees the agent
  produced schema-valid JSON. Row 3 🟡/⬜ → ✅/✅. Next: row 4 (session crystallization).
- **Iter 5 (row 4: session crystallization)** — Added `test/crystallize-parity.test.ts`
  (both backends) and `test/live-agent-crystallize.test.ts`. Feature makes two
  sequential structured calls (session_digest → knowledge_extraction); the agent
  scripted reply branches on the schema name in the prompt. Contract:
  `pnpm --filter @meos/core exec vitest run test/crystallize-parity.test.ts` → 2/2.
  Live: `MEOS_LIVE_AGENT=1 … test/live-agent-crystallize.test.ts` → 1/1 (real claude, 71.7s).
  Row 4 🟡/⬜ → ✅/✅. Next: row 5 (nightly digest, `complete`, plain text).
- **Iter 6 (row 5: nightly digest)** — Added `test/digest-parity.test.ts` (both
  backends) and `test/live-agent-digest.test.ts`. Isolated the digest `complete`
  call (omit embedder → skip crystallizeChat; `regenerateWiki:false` → skip wiki
  runAgent). Asserts the routed client's own text is persisted as the digest.
  Contract: `pnpm --filter @meos/core exec vitest run test/digest-parity.test.ts` → 2/2.
  Live: `MEOS_LIVE_AGENT=1 … test/live-agent-digest.test.ts` → 1/1 (real claude, 18.3s).
  Row 5 🟡/⬜ → ✅/✅. Next: row 6 (image OCR — multimodal complete, agent→API fallback by design).
