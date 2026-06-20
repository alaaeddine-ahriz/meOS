import path from "node:path";
import type { MeosConfig } from "../config.js";
import { getCodingAgent } from "../coding-agent/registry.js";
import { CodingAgentLlmClient } from "./coding-agent-client.js";
import { createLlmClient } from "./index.js";
import type { LlmClient } from "./types.js";

/**
 * The three task families whose LLM calls meOS routes independently. Each can
 * run on the cloud API or a local coding-agent CLI — chosen per family because
 * their cost/latency/quality tradeoffs differ:
 *
 *  - `background` — ingestion extraction, contradiction detection, nightly
 *    consolidation, image OCR, session crystallization. High-volume, latency-
 *    tolerant, deterministic-output sensitive (structured JSON). The default
 *    home for "the work the system does on its own".
 *  - `wiki` — the agentic wiki maintainer (page rewrites). Tool-using, long-
 *    running, benefits most from a free local agent on the user's subscription.
 *  - `assistant` — the interactive profile-drafting/editing helpers. User-facing
 *    and latency-sensitive, so a user may prefer the snappier cloud API here even
 *    while the rest runs on a local agent.
 *
 * Interactive chat is deliberately NOT a group: API-mode chat stays on the
 * `background` client and agent-mode chat already drives a CLI through its own
 * per-message path, so neither needs routing here.
 */
export type TaskGroup = "background" | "wiki" | "assistant";

/** The task groups in their canonical order — the iteration order everywhere. */
export const TASK_GROUPS: readonly TaskGroup[] = ["background", "wiki", "assistant"];

/**
 * Where a single task group's LLM calls go:
 *  - `"api"`   — always the cloud provider configured in Settings.
 *  - `"agent"` — always a local coding-agent CLI (free on the user's subscription).
 *  - `"auto"`  — the agent WHEN one is installed (it costs nothing), the API
 *    otherwise. This is the default for every group: prefer the free local agent
 *    if it's there, fall back to the paid API so the system always works.
 *
 * `agentId`/`model` pin a specific CLI + model for this group; absent, they fall
 * back to {@link IntelligenceRouting.defaultAgent} and finally to Claude.
 */
export interface GroupRoute {
  source: "auto" | "api" | "agent";
  /** Pin a coding agent for this group (overrides {@link IntelligenceRouting.defaultAgent}). */
  agentId?: string;
  /** Pin the agent's model for this group. */
  model?: string;
}

/**
 * The persisted routing object (settings key `"intelligence-routing"`). One
 * {@link GroupRoute} per task group plus a `defaultAgent` the `auto`/`agent`
 * sources fall back to when a group doesn't pin its own.
 */
export interface IntelligenceRouting {
  background: GroupRoute;
  wiki: GroupRoute;
  assistant: GroupRoute;
  /** Fallback agent id + model for any group whose route doesn't pin its own. */
  defaultAgent?: { agentId?: string; model?: string };
}

/** The default coding agent when neither the group nor `defaultAgent` pins one. */
export const DEFAULT_ROUTING_AGENT_ID = "claude";

/** A group with no opinion: prefer the free local agent, fall back to the API. */
export const DEFAULT_GROUP_ROUTE: GroupRoute = { source: "auto" };

/**
 * The default routing — every group on `"auto"`. On a machine with a coding
 * agent installed this routes all three groups to the (free) agent; with none
 * installed it routes them to the cloud API. No `defaultAgent`, so `auto`/`agent`
 * resolve to Claude unless a group pins otherwise.
 */
export function defaultIntelligenceRouting(): IntelligenceRouting {
  return {
    background: { ...DEFAULT_GROUP_ROUTE },
    wiki: { ...DEFAULT_GROUP_ROUTE },
    assistant: { ...DEFAULT_GROUP_ROUTE },
  };
}

/**
 * Fill any missing pieces of a (possibly partial / legacy) stored routing object
 * with defaults, so callers always see a complete {@link IntelligenceRouting}.
 * A group absent from the stored blob resolves to `"auto"`; an unknown `source`
 * is coerced to `"auto"` so a corrupt/forward-incompatible value can never strand
 * a group on a broken route.
 */
export function withRoutingDefaults(stored?: Partial<IntelligenceRouting> | null): IntelligenceRouting {
  const route = (r?: Partial<GroupRoute> | null): GroupRoute => {
    const source = r?.source;
    return {
      source: source === "api" || source === "agent" ? source : "auto",
      agentId: r?.agentId,
      model: r?.model,
    };
  };
  return {
    background: route(stored?.background),
    wiki: route(stored?.wiki),
    assistant: route(stored?.assistant),
    defaultAgent: stored?.defaultAgent,
  };
}

/**
 * The agent id a route resolves to: its own pin, then the routing-wide default,
 * then Claude. Used both to pick the CLI for an `"agent"` route and to decide
 * whether an `"auto"` route has an installed agent to use.
 */
export function resolvedAgentId(route: GroupRoute, routing: IntelligenceRouting): string {
  return route.agentId ?? routing.defaultAgent?.agentId ?? DEFAULT_ROUTING_AGENT_ID;
}

/**
 * Build the concrete {@link LlmClient} a task group should use, given the active
 * config, the routing setting, and the set of coding agents currently installed
 * (their ids). Pure and synchronous: agent detection is done once by the caller
 * and passed in as `installedAgents`, so resolving every group is a cheap,
 * side-effect-free fan-out that the boot path and the hot-swap path share.
 *
 * Resolution per source:
 *  - `"api"`   → the cloud client (`createLlmClient(config)`).
 *  - `"agent"` → a {@link CodingAgentLlmClient} over the resolved agent + model,
 *    with the cloud client as its fallback (so a multimodal completion or a
 *    structured call the CLI can't satisfy never regresses correctness).
 *  - `"auto"`  → the agent client WHEN the resolved agent id is installed (it's
 *    free), otherwise the cloud client.
 *
 * The agent client is intentionally TOOL-LESS here (no `mcpServers`): wiring the
 * meOS MCP into the wiki/agent path needs the running server's port, which isn't
 * known at this layer. That is a documented follow-up — see the wiki/agent MCP
 * injection note in the PR. Until then a group routed to an agent runs the model
 * without meOS tools, which is correct for extraction/consolidation/profile work.
 */
export function resolveGroupClient(
  group: TaskGroup,
  config: MeosConfig,
  routing: IntelligenceRouting,
  installedAgents: ReadonlySet<string>,
): LlmClient {
  const route = routing[group];
  const agentId = resolvedAgentId(route, routing);
  const useAgent = route.source === "agent" || (route.source === "auto" && installedAgents.has(agentId));
  if (!useAgent) return createLlmClient(config);

  return new CodingAgentLlmClient({
    agent: getCodingAgent(agentId),
    model: route.model ?? routing.defaultAgent?.model,
    // A per-group scratch dir under the data dir: each agent run gets a fresh
    // unique subdir here, kept apart so concurrent group runs never collide.
    scratchDir: path.join(config.dataDir, "intelligence", group),
    // The cloud client backstops what a CLI can't do (images, hard structured
    // output), so moving a task onto a local agent never loses correctness.
    fallback: createLlmClient(config),
    // NOTE: no `mcpServers` — tool-less for now. Injecting the meOS MCP into the
    // wiki/agent path requires the running server port (a documented FOLLOW-UP).
  });
}
