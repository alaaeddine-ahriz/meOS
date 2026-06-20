import { z } from "zod";

/**
 * The intelligence-routing contract (#native-agent-intelligence). The whole
 * app's intelligence runs on a SINGLE backend — either the cloud API or one
 * local coding agent — per this persisted, hot-swappable setting. The web
 * Settings UI reads/writes it through GET/PUT `/api/intelligence-routing`.
 *
 * Mirrors the core `IntelligenceRouting` shape exactly so the wire format and
 * the server's resolver can't drift. Response objects are explicit `z.object`s
 * (never `z.record`) — a record in a Fastify response schema serializes
 * malformed under this stack.
 */

/**
 * Where the whole app's LLM work runs: `"api"` = the cloud provider configured
 * in Settings (the default); `"agent"` = a local coding agent (free on the
 * user's subscription). `agentId`/`model` pin the CLI + model for `"agent"`.
 */
export const IntelligenceRoutingSchema = z.object({
  backend: z.enum(["agent", "api"]),
  agentId: z.string().optional(),
  model: z.string().optional(),
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

export type IntelligenceRouting = z.infer<typeof IntelligenceRoutingSchema>;
export type RoutingAgent = z.infer<typeof RoutingAgentSchema>;
