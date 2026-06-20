import path from "node:path";
import type { MeosConfig } from "../config.js";
import { getCodingAgent } from "../coding-agent/registry.js";
import type { McpServerSpec } from "../coding-agent/types.js";
import { CodingAgentLlmClient } from "./coding-agent-client.js";
import { createLlmClient } from "./index.js";
import type { LlmClient } from "./types.js";

/**
 * The three task families meOS resolves an LLM client for. They no longer route
 * independently — the whole app runs on a SINGLE backend (see
 * {@link IntelligenceRouting}) — but the runtime still keeps one
 * {@link import("./switchable.js").SwitchableLlmClient} per family so consumers
 * (the pipeline, the wiki maintainer, the profile helpers) each hold a stable
 * reference, and so an agent-backed run gets its own scratch dir:
 *
 *  - `background` — ingestion extraction, contradiction detection, nightly
 *    consolidation, image OCR, session crystallization. The default home for
 *    "the work the system does on its own".
 *  - `wiki` — the agentic wiki maintainer (page rewrites).
 *  - `assistant` — the interactive profile-drafting/editing helpers.
 *
 * Interactive chat is deliberately NOT a group: API-mode chat stays on the
 * `background` client and agent-mode chat already drives a CLI through its own
 * per-message path, so neither needs resolving here.
 */
export type TaskGroup = "background" | "wiki" | "assistant";

/** The task groups in their canonical order — the iteration order everywhere. */
export const TASK_GROUPS: readonly TaskGroup[] = ["background", "wiki", "assistant"];

/**
 * Where the WHOLE app's intelligence runs — a single, global, binary choice:
 *  - `"api"`   — the cloud provider configured in Settings.
 *  - `"agent"` — a local coding-agent CLI (free on the user's subscription).
 *
 * `agentId` pins the CLI (defaults to {@link DEFAULT_ROUTING_AGENT_ID}); `model`
 * pins its model. Both are ignored when `backend === "api"`.
 */
export interface IntelligenceRouting {
  backend: "agent" | "api";
  /** The coding agent to run when `backend === "agent"` (defaults to Claude). */
  agentId?: string;
  /** The agent's model when `backend === "agent"`. */
  model?: string;
}

/** The default coding agent when `agentId` isn't pinned. */
export const DEFAULT_ROUTING_AGENT_ID = "claude";

/**
 * The default routing: the cloud API. Safe on any machine — it needs no CLI, so
 * the app works out of the box; the user opts INTO an agent explicitly.
 */
export function defaultIntelligenceRouting(): IntelligenceRouting {
  return { backend: "api" };
}

/**
 * Coerce a (possibly partial / legacy / corrupt) stored value into a complete
 * {@link IntelligenceRouting}. Anything that isn't an explicit `{ backend:
 * "agent" }` resolves to the safe `{ backend: "api" }` default — including the
 * old per-group shape (`{ background, wiki, assistant }`), which predates this
 * single-backend model and is simply dropped to API. A junk/forward-incompatible
 * value can therefore never strand the app on a broken backend.
 */
export function withRoutingDefaults(stored?: Partial<IntelligenceRouting> | null): IntelligenceRouting {
  if (stored?.backend === "agent") {
    return {
      backend: "agent",
      agentId: typeof stored.agentId === "string" ? stored.agentId : undefined,
      model: typeof stored.model === "string" ? stored.model : undefined,
    };
  }
  return { backend: "api" };
}

/**
 * Build the concrete {@link LlmClient} a task group should use, given the active
 * config, the global routing, and the set of coding agents currently installed
 * (their ids). Pure and synchronous: agent detection is done once by the caller
 * and passed in as `installedAgents`, so resolving every group is a cheap,
 * side-effect-free fan-out that the boot path and the hot-swap path share.
 *
 * Every group resolves from the SAME global `routing.backend`; the `group` arg
 * only names the per-group scratch dir so concurrent agent runs never collide.
 *
 * Resolution:
 *  - `backend === "api"`   → the cloud client (`createLlmClient(config)`).
 *  - `backend === "agent"` → a {@link CodingAgentLlmClient} over the resolved
 *    agent + model, with the cloud client as its fallback (so a multimodal
 *    completion or a structured call the CLI can't satisfy never regresses).
 *    GUARD: if the resolved agent id is NOT installed, fall back to the cloud
 *    client — a misconfigured/uninstalled agent must never brick the app.
 *
 * `mcpServers` (optional) exposes meOS's own MCP tools to a tool-using run. The
 * server layer supplies it only for the `wiki` group (the agentic maintainer),
 * so a coding agent rewriting a page can look the user's knowledge up via the
 * `meos` wiki/knowledge tools while it edits. Transform groups (background,
 * assistant) pass nothing and run tool-less — correct for extraction/OCR/profile
 * work, which only needs the model. Built in the server layer because the spec
 * points at this server's own running port (unknown to core).
 */
export function resolveGroupClient(
  group: TaskGroup,
  config: MeosConfig,
  routing: IntelligenceRouting,
  installedAgents: ReadonlySet<string>,
  mcpServers?: Record<string, McpServerSpec>,
): LlmClient {
  if (routing.backend !== "agent") return createLlmClient(config);

  const agentId = routing.agentId ?? DEFAULT_ROUTING_AGENT_ID;
  // A misconfigured/uninstalled agent must never brick the app — fall back to
  // the cloud client so intelligence keeps working until the CLI is installed.
  if (!installedAgents.has(agentId)) return createLlmClient(config);

  return new CodingAgentLlmClient({
    agent: getCodingAgent(agentId),
    model: routing.model,
    // A per-group scratch dir under the data dir: each agent run gets a fresh
    // unique subdir here, kept apart so concurrent group runs never collide.
    scratchDir: path.join(config.dataDir, "intelligence", group),
    // The cloud client backstops what a CLI can't do (images, hard structured
    // output), so moving work onto a local agent never loses correctness.
    fallback: createLlmClient(config),
    // meOS knowledge tools for tool-using runs (the wiki maintainer); undefined
    // for transform groups, which run tool-less. Supplied by the server layer.
    mcpServers,
  });
}
