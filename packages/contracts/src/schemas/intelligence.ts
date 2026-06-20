import { z } from "zod";

/**
 * The intelligence-routing contract (#native-agent-intelligence). meOS routes
 * each task group's LLM calls to either the cloud API or a local coding agent,
 * per this persisted, hot-swappable setting. The web Settings UI reads/writes it
 * through GET/PUT `/api/intelligence-routing`.
 *
 * Mirrors the core `IntelligenceRouting`/`GroupRoute` shapes exactly so the wire
 * format and the server's resolver can't drift. Response objects are explicit
 * `z.object`s (never `z.record`) — a record in a Fastify response schema
 * serializes malformed under this stack.
 */

/** The three task families routed independently (mirrors core `TaskGroup`). */
export const TaskGroupSchema = z.enum(["background", "wiki", "assistant"]);

/**
 * Where one group's LLM calls go. `"auto"` = the free local agent when one is
 * installed, the cloud API otherwise (the default). `agentId`/`model` pin a
 * specific CLI + model for the group.
 */
export const GroupRouteSchema = z.object({
  source: z.enum(["auto", "api", "agent"]),
  agentId: z.string().optional(),
  model: z.string().optional(),
});

/** The persisted routing object — one route per group plus a fallback agent. */
export const IntelligenceRoutingSchema = z.object({
  background: GroupRouteSchema,
  wiki: GroupRouteSchema,
  assistant: GroupRouteSchema,
  defaultAgent: z
    .object({ agentId: z.string().optional(), model: z.string().optional() })
    .optional(),
});

/**
 * One supported coding agent, projected for the routing picker — the same shape
 * the chat agent picker uses, so the UI can render which agents are installable
 * and which are installed here.
 */
export const RoutingAgentSchema = z.object({
  id: z.string(),
  label: z.string(),
  models: z.array(z.object({ value: z.string(), label: z.string() })),
  defaultModel: z.string(),
  streaming: z.boolean(),
  installed: z.boolean(),
  installHint: z.string(),
});

/**
 * GET `/api/intelligence-routing` — the current routing (defaults filled) plus
 * every supported coding agent (with an `installed` flag) so the UI can render
 * the picker without a second round-trip.
 */
export const IntelligenceRoutingResponse = z.object({
  routing: IntelligenceRoutingSchema,
  agents: z.array(RoutingAgentSchema),
});

/** PUT `/api/intelligence-routing` — the desired routing to persist + apply. */
export const UpdateIntelligenceRoutingBody = IntelligenceRoutingSchema;

export type TaskGroup = z.infer<typeof TaskGroupSchema>;
export type GroupRoute = z.infer<typeof GroupRouteSchema>;
export type IntelligenceRouting = z.infer<typeof IntelligenceRoutingSchema>;
export type RoutingAgent = z.infer<typeof RoutingAgentSchema>;
