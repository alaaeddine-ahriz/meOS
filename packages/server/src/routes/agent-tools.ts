import { agentTools as agentToolsSchema, chat as chatSchema } from "@meos/contracts";
import { buildConnectorAgentTools, connectorToolDescriptors } from "@meos/core";
import type { FastifyInstance } from "fastify";
import { deliverAskAnswer, requestAsk } from "../ask-registry.js";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import type { McpManifest } from "../mcp-manifest.js";

const tags = ["agent-tools"];

/**
 * Connector agent tools over HTTP, for agent mode (the local Claude Code CLI).
 *
 * The CLI can't hold the user's OAuth tokens, so it never talks to Google (or any
 * provider) directly — it talks to meOS. The connector-tools MCP server proxies
 * to these two endpoints: `GET` to discover the live tools (one per connected
 * connector + enabled kind), `POST …/:name` to run one. Execution happens HERE,
 * in the server process that owns the credentials, reusing the SAME assembled
 * {@link buildConnectorAgentTools} toolset the in-app chat uses — so a tool runs
 * against the account's already-authorized token (refreshed as needed), never a
 * second authentication. Loopback-only, like the wiki-agent endpoints.
 */
export function registerAgentToolRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  mcpManifest: McpManifest,
): void {
  // The live connector toolset for this user, rebuilt per request so connecting or
  // disconnecting a service (or toggling a kind) takes effect on the next turn.
  const assemble = () => buildConnectorAgentTools({ store: ctx.store, embedder: ctx.embedder });

  // The GENERATED MCP tool surface: one entry per route that opted in via
  // `routeSchema({ mcp: { expose: true, safety } })`, collected by the onRoute hook
  // in buildServer. The wiki-mcp generator fetches this and registers a matching MCP
  // tool for each entry, so the app's annotated API IS the agent's toolset. No
  // strict response schema — each entry's `inputSchema` is an arbitrary JSON-Schema
  // blob Fastify's response serializer would strip (same reason as connector-tools).
  app.get(
    "/api/agent/tool-manifest",
    { schema: { tags, summary: "List the generated MCP tools projected from the annotated API" } },
    async () => agentToolsSchema.ToolManifestResponse.parse({ tools: mcpManifest.list() }),
  );

  // Discover: the tools the agent may call, as transport-neutral descriptors
  // (name + prose + JSON-Schema inputs) the MCP server registers verbatim. No
  // strict response schema — `inputSchema` is an arbitrary JSON-Schema blob that
  // Fastify's response serializer would strip.
  app.get(
    "/api/agent/connector-tools",
    { schema: { tags, summary: "List the connector agent tools available to agent mode" } },
    async () => {
      const { tools, hints } = assemble();
      return { tools: connectorToolDescriptors(tools), hints };
    },
  );

  // Invoke one tool by name with its JSON arguments, server-side. A connector tool
  // catches provider errors and returns an explanatory string, so the usual path
  // is a plain `{ result }`. A THROW means the account is unusable (e.g. no refresh
  // token) — surface it as `isError` text so the agent tells the user to reconnect
  // in meOS rather than attempting its own auth flow.
  app.post<{ Params: { name: string }; Body: unknown }>(
    "/api/agent/connector-tools/:name",
    { schema: { tags, summary: "Run a connector agent tool by name" } },
    async (request) => {
      const { name } = request.params;
      const { tools } = assemble();
      const tool = tools[name];
      if (!tool || typeof tool.execute !== "function") {
        throw httpError.notFound(`No connector tool named "${name}" is available.`);
      }
      const args = (request.body ?? {}) as Record<string, unknown>;
      try {
        const output = await tool.execute(args, { toolCallId: `agent-mode:${name}`, messages: [] });
        const result = typeof output === "string" ? output : JSON.stringify(output, null, 2);
        return { result, isError: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { result: message, isError: true };
      }
    },
  );

  // Mid-run questions. The `ask_user` MCP tool POSTs here and the request BLOCKS
  // until the user answers (over the chat SSE stream → /api/agent/ask/answer),
  // the run is aborted, or the wait times out — see ../ask-registry.ts. A
  // run-less or unanswered `op` resolves with a non-"answered" status the MCP
  // tool turns into "proceed with your best judgment", so the agent never hangs.
  app.post<{ Body: unknown }>(
    "/api/agent/ask",
    { schema: { tags, summary: "Ask the user a question mid-run (long-poll)" } },
    async (request) => {
      const { op, questions } = parseOrThrow(chatSchema.AskUserBody, request.body, "body");
      const result = await requestAsk(op, questions);
      return chatSchema.AskUserResult.parse(result);
    },
  );

  // The web client delivering the user's choice, unblocking the parked ask above.
  app.post<{ Body: unknown }>(
    "/api/agent/ask/answer",
    { schema: { tags, summary: "Answer a mid-run question" } },
    async (request) => {
      const { op, id, answers } = parseOrThrow(chatSchema.AskAnswerBody, request.body, "body");
      return chatSchema.AskAnswerResponse.parse({ ok: deliverAskAnswer(op, id, answers) });
    },
  );
}
