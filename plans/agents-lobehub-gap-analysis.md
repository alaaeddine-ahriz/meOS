# Agents: LobeHub vs meOS — gap analysis & roadmap

_Goal: study how LobeHub (`lobehub/lobehub@canary`, `apps/desktop`) implements agents, then make meOS's
agent system stronger and broader._

## 1. What LobeHub is now

LobeHub rebranded around agents: _"your Chief Agent Operator, organizing your agents into 7×24
operations by hiring, scheduling, and reporting on your entire AI team."_ The evolution (from the
changelog) is the tell:

- **2026-03-30 Agent Management** — assign work to agents, in-app notifications, slash-command skills.
- **2026-04-27 Heterogeneous Agent** — Claude Code & Codex as first-class desktop runtimes; an Agent
  Signal runtime; Quick Chat (screen capture → ask).
- **2026-05-11 Agent Tasks GA** — file a task like an issue (title/description/template) and assign it
  to an _agent_; subtasks with dependencies; cron/recurring/batch; nightly self-review → briefs;
  cloud heterogeneous agents (sessions survive restarts); `lh hetero exec` CLI; **mid-run questions**
  (Claude Code pauses to ask); bot platforms (Messenger/Line/Telegram).
- **2026-05-19 CAO** — the agent loops autonomously: reviews its own work, picks the next step,
  continues without "next", and only pauses when a decision genuinely needs you. Spins up a **team of
  sub-agents** and hands off parts while staying in charge; you can open any sub-agent's conversation.
- **2026-05-31 Platform Agents & Skills** — platform agents run **local or on a remote device** (device
  switcher in the composer); **drag-and-drop skills** + `/` skill menu (built-ins, Skill Market, your
  agents'); export/share an agent as Markdown.

### Architecture (the parts that matter for us)

- `packages/agent-runtime` — the **native** agent loop: `core/runtime.ts`, `InterventionChecker.ts`
  (when to pause for the human), `UsageCounter.ts`, `audit/` (security blacklist on tool use),
  `groupOrchestration/` (supervisor + worker agents = teams), typed `event`/`state`/`hooks`.
- `packages/heterogeneous-agents` — the **CLI** runtime (Claude Code, Codex). Direct analog to meOS's
  `coding-agent`: `adapters/{claudeCode,codex}.ts`, `spawn/{cliSpawn,agentStreamPipeline}.ts`,
  `registry.ts`, `config.ts`. **Plus what meOS lacks:**
  - `askUser/{AskUserMcpServer,AskUserBridge}.ts` — a process-wide HTTP/SSE MCP server exposing one
    `ask_user_question` tool (mirroring CC's built-in `AskUserQuestion` schema: 1–4 questions, each
    with a header ≤12 chars, 2–4 `{label,description}` options, optional multiSelect). The agent calls
    it mid-run; a per-operation bridge surfaces the question to the user and **blocks** until answered;
    `notifications/progress` every 30s keeps CC's SSE alive past its idle timeout.
  - `mainAgentCoordinator/` — the CAO loop (reducer + sub-agent fan-out).
  - `spawn/codexFileChangeTracker.ts` — track which files a run changed.
- `packages/agent-manager-runtime` — manage many agents.
- Supporting: `context-engine`, `conversation-flow`, `builtin-tool-*` (memory, knowledge-base,
  task, skills, cloud-sandbox, local-system, remote-device, web-browsing, self-iteration,
  agent-builder…), `chat-adapter-*` (feishu/line/qq/wechat/imessage), `agent-tracing`/`observability-otel`.

## 2. Where meOS is today

meOS "agent mode" routes a chat turn to a local coding-agent CLI and streams its trace into the
existing chat UI. It's already a clean, well-factored **heterogeneous runtime**:

- `packages/core/src/coding-agent/` — `registry.ts` (5 agents: Claude/Codex/Cursor/Gemini/Copilot),
  `detect.ts` (PATH + `--version` identity probe), `adapter.ts` + `adapters/*` (per-CLI stream → one
  `AgentEvent` shape), `spawn.ts` (child process, readline, abort = process-group kill).
- `packages/server/src/coding-agent-command.ts` — per-turn run: resolves cwd/model/resume session,
  builds the meOS MCP injection, streams events over the chat SSE, persists the turn + citations.
- `packages/server/src/routes/{chat,agent-tools}.ts` — `/api/coding-agents`, the `/api/chat` SSE
  branch, and the connector-tool discover/invoke endpoints.
- `packages/wiki-mcp/` — two stdio MCP servers (wiki knowledge + live connectors) that proxy back to
  meOS over HTTP, so the spawned CLI reuses meOS's OAuth and never re-authenticates.
- `packages/web/src/views/ChatView.tsx` — agent picker, per-agent model picker, chronological trace
  (reasoning → tool → text), grounded citations.

**meOS's distinctive strength vs LobeHub:** 5 CLI runtimes (vs LobeHub's 2), and a connector/OAuth
bridge that gives any agent live access to the user's calendar/tasks/email/contacts + personal
knowledge graph — _through meOS's own auth_. LobeHub has nothing equivalent to the personal-knowledge
grounding.

## 3. Gap analysis (LobeHub has → meOS lacks)

| #   | Capability                                             | LobeHub                    | meOS                                 | Impact | Effort |
| --- | ------------------------------------------------------ | -------------------------- | ------------------------------------ | ------ | ------ |
| 1   | **Mid-run questions** (agent pauses, asks, resumes)    | `askUser` MCP bridge       | ✗ fully headless `bypassPermissions` | ★★★    | M      |
| 2   | **Run telemetry** (cost/turns/duration) surfaced       | yes                        | computed then discarded              | ★★     | S      |
| 3   | **File-change tracking** (what the run touched + diff) | `codexFileChangeTracker`   | ✗                                    | ★★     | M      |
| 4   | **Trace persistence** (reasoning/tools survive reload) | yes                        | live-only                            | ★★     | M      |
| 5   | **Autonomous loop / self-review** (CAO)                | `mainAgentCoordinator`     | single turn + resume                 | ★★★    | L      |
| 6   | **Sub-agent teams**                                    | `groupOrchestration`       | ✗ (CC's own Task tool only)          | ★★     | L      |
| 7   | **Scheduled / recurring agent tasks**                  | Agent Tasks GA             | ✗                                    | ★★★    | L      |
| 8   | **Skills** (drag-drop, `/` menu, market)               | builtin-skills             | connectors only                      | ★★     | L      |
| 9   | **Agent memory tool**                                  | builtin-tool-memory        | wiki only                            | ★★     | M      |
| 10  | **Remote / cloud execution**                           | platform agents on devices | local only                           | ★★     | XL     |
| 11  | **Multi-channel bots**                                 | 8 chat adapters            | ✗                                    | ★      | XL     |
| 12  | **Agent profiles / market / export**                   | yes                        | ✗                                    | ★      | M      |
| 13  | **Per-run safety audit**                               | `audit/` blacklist         | none (bypass)                        | ★      | M      |

## 4. Roadmap (recommended order)

**Now (this change): #1 Mid-run questions.** The single biggest gap and the marquee LobeHub feature.
It removes meOS's fully-headless limitation and — because it rides the existing MCP-over-HTTP bridge —
works for **every** agent that speaks MCP (Claude/Codex/Cursor/Gemini/Copilot), not just Claude Code
as in LobeHub. That is literally "stronger and with larger support." See §5.

**Next (small, high-ROI, server/core-only, render through existing SSE):**

- #2 Run telemetry footer (cost · N turns · duration) — the `result` event already carries it.
- #3 File-change tracking — snapshot cwd before/after a run, emit a `files-changed` summary part.
- #4 Persist the agent trace on the message so reload keeps reasoning/tool steps.

**Then (platform bets, each its own project):** #7 scheduled/recurring agent tasks (meOS already has a
job/activity loop to build on), #5 autonomous self-review loop, #9 agent memory tool, #6 sub-agent
teams, #13 safety audit, then #8/#10/#12.

## 5. Flagship spec — Mid-run questions

Mirror LobeHub's `ask_user_question` but fit meOS's HTTP-proxy MCP architecture (no second MCP HTTP
server — reuse the stdio connectors server that already proxies to meOS).

**Flow:** agent calls `mcp__meos-connectors__ask_user({questions})` → the stdio tool POSTs
`/api/agent/ask {op, questions}` (long-poll) → server looks up the run by `op`, emits an `ask-user`
SSE frame to the web client, and awaits → user answers in the chat → web POSTs `/api/agent/ask/answer
{op, id, answers}` → server resolves the pending promise → long-poll returns answers → tool returns
them to the agent → the run continues. `op` (a per-run id) is threaded to the MCP child via the same
env channel as `MEOS_SERVER_URL`. MCP `notifications/progress` keep the agent's tool-call alive during
the human wait (LobeHub's trick). Graceful degradation: no interactive session / timeout / abort all
return a clear "proceed with best judgment" string so the agent never hard-fails.

**Touchpoints:** `contracts/chat.ts` (new `ask-user` event + `AskUserBody`/`AskAnswerBody`),
`wiki-mcp/{client,connectors}.ts` (the `ask_user` tool + keepalive), `server/ask-registry.ts` (new) +
`routes/agent-tools.ts` (`/api/agent/ask`, `/api/agent/ask/answer`) + `coding-agent-command.ts` (mint
`op`, register/unregister, env, prompt guidance), `web/{api.ts,ChatView.tsx}` (render the question
card, post the answer). Tested via `app.inject` route tests for the ask/answer correlation.

## 6. POST-TEST BUG (found in the running app) + fix — VERIFIED

First live test in the meOS app "didn't work": the agent surfaced an `AskUserQuestion`-shaped payload
but no answerable card. Root cause, confirmed empirically against the `claude` binary the app spawns
(Homebrew `/opt/homebrew/bin/claude` **2.1.172**, not the nvm 1.0.61):

- Headless, Claude Code **still lists its built-in `AskUserQuestion`** (41 tools), the model **prefers
  it over our MCP `ask_user`**, and with no TTY it **auto-resolves to empty answers in ~37 ms**
  ([claude-code#50728](https://github.com/anthropics/claude-code/issues/50728)) — the user is never
  asked. So our whole ask path was dead code; the trace just showed the dead built-in call.
- A system-prompt nudge cannot beat a built-in. **Fix: `--disallowedTools AskUserQuestion`** — verified
  to remove it from the headless tool list (41→40, absent) **even under `bypassPermissions`** (the
  [#50303](https://github.com/anthropics/claude-code/issues/50303) bug is `--allowedTools`-specific).
- Second half: the `ask_user` call must block minutes for the human. Claude's default MCP tool timeout
  is **60 s** and headless it does **not** extend on `notifications/progress`
  ([#58687](https://github.com/anthropics/claude-code/issues/58687)) — but **`MCP_TOOL_TIMEOUT` (ms)
  is honored in `-p` mode**. Fix: set `MCP_TOOL_TIMEOUT=600000` on the spawned `claude` process; the
  server already caps the wait at ~270 s and returns a `timeout` result first, so the tool resolves
  cleanly. (Kept the progress keepalive — harmless for Claude, may help other agents.)

Both fixes are in `packages/core/src/coding-agent/runner.ts` (`buildClaudeArgs` + `runClaudeCodeAgent`),
with a `buildClaudeArgs` unit test. **Requires the branch built + dev server restarted** to take effect
(`pnpm --filter @meos/core --filter @meos/contracts --filter @meos/wiki-mcp build`, then restart).
Other agents (Codex/Cursor/Gemini/Copilot) audited separately for the same built-in-shadowing class;
Copilot is text-only so it cannot render the card regardless.
