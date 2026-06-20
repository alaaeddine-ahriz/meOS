#!/usr/bin/env node
/**
 * meOS connector agent tools as a stdio MCP server, for meOS's OWN agent mode
 * (the local Claude Code CLI launched from chat). Unlike the wiki MCP (the
 * external-agent surface, wiki-only), this exposes the user's LIVE connected
 * services — Google calendar/tasks/email/contacts, and any future connector —
 * so the agent can read and act on them.
 *
 * Crucially, the CLI never sees a credential or runs an OAuth flow: it discovers
 * the available tools from the running meOS server and proxies every call back to
 * meOS, which executes the tool against the account's already-authorized token
 * (refreshing as needed). The meOS app/server must be running; override its
 * location with MEOS_SERVER_URL (default http://127.0.0.1:4321).
 *
 * Tools are registered from raw JSON Schema fetched at startup, so this uses the
 * low-level Server API (the high-level McpServer wants Zod shapes the meOS server
 * doesn't ship across the process boundary).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  askUser,
  getConnectorTools,
  invokeConnectorTool,
  type AskQuestionInput,
  type AskUserResult,
  type ConnectorToolDescriptor,
} from "./client.js";

/** The slice of the MCP request handler's `extra` the ask tool uses (progress keepalive). */
interface AskExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

/**
 * The mid-run question tool. Mirrors Claude Code's built-in `AskUserQuestion`
 * schema so any MCP-speaking agent can call it with the shape it already knows.
 * The call blocks (server-side long-poll) until the user answers in meOS chat.
 */
const ASK_USER_TOOL = "ask_user";
const askUserToolDescriptor = {
  name: ASK_USER_TOOL,
  description:
    "Ask the user one or more clarifying questions with multiple-choice options, then continue " +
    "with their answer. Use ONLY when the request is genuinely ambiguous or a decision is the " +
    "user's to make — never to stall on something you can resolve yourself. You run headless, so " +
    "this is the only way to reach the user mid-task.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        description: "1–4 questions to ask at once.",
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "Short ≤12-char category label, e.g. 'Scope'." },
            question: { type: "string", description: "The full question." },
            options: {
              type: "array",
              minItems: 1,
              maxItems: 6,
              description: "The choices offered.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "The choice shown to the user." },
                  description: { type: "string", description: "Short gloss on this choice." },
                },
                required: ["label"],
              },
            },
            multiSelect: { type: "boolean", description: "Allow choosing more than one option." },
          },
          required: ["header", "question", "options"],
        },
      },
    },
    required: ["questions"],
  } as { type: "object" } & Record<string, unknown>,
};

/** A human-wait can outlast the agent's MCP tool-call timeout; periodic progress resets it. */
const KEEPALIVE_MS = 25_000;

/** Turn the server's long-poll result into text the agent can act on (always non-throwing). */
function formatAskResult(result: AskUserResult): { text: string; isError: boolean } {
  if (result.status === "answered" && result.answers.length > 0) {
    const lines = result.answers.map(
      (a) => `- ${a.question}\n  → ${a.answers.join(", ") || "(no choice)"}`,
    );
    return { text: `The user answered:\n${lines.join("\n")}`, isError: false };
  }
  const why =
    result.status === "timeout"
      ? "The user didn't answer in time."
      : result.status === "cancelled"
        ? "The question was cancelled (the user stopped the run or it ended)."
        : "No interactive meOS session is available to ask the user.";
  return {
    text: `${why} Proceed with your best judgment and state any assumption you make in your reply.`,
    isError: false,
  };
}

/** Run an `ask_user` call: keep the tool-call alive while the user decides, then format the answer. */
async function handleAskUser(
  args: unknown,
  extra: AskExtra,
): Promise<{ content: { type: "text"; text: string }[]; isError: boolean }> {
  const op = process.env.MEOS_AGENT_OP?.trim();
  const questions = (args as { questions?: AskQuestionInput[] })?.questions;
  if (!op || !Array.isArray(questions) || questions.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "Can't ask the user right now (no interactive session). Proceed with your best judgment.",
        },
      ],
      isError: false,
    };
  }

  // While we wait on the human, emit progress so the agent's client doesn't time
  // the tool call out. Only meaningful when the call carried a progress token.
  const progressToken = extra._meta?.progressToken;
  let ticks = 0;
  const keepalive =
    progressToken === undefined
      ? undefined
      : setInterval(() => {
          extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: ++ticks, message: "Waiting for the user…" },
            })
            .catch(() => {});
        }, KEEPALIVE_MS);

  try {
    const result = await askUser(op, questions);
    const { text, isError } = formatAskResult(result);
    return { content: [{ type: "text", text }], isError };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Couldn't reach meOS to ask the user (${message}). Proceed with your best judgment.`,
        },
      ],
      isError: false,
    };
  } finally {
    if (keepalive) clearInterval(keepalive);
  }
}

/** Fetch the live tool list from meOS; an unreachable/empty server yields none. */
async function loadTools(): Promise<ConnectorToolDescriptor[]> {
  try {
    const { tools } = await getConnectorTools();
    return tools;
  } catch (err) {
    // stdout is the MCP transport — diagnostics go to stderr only. A missing
    // server just means no connector tools this run, not a crash.
    console.error(
      "[meos-connectors-mcp] could not load connector tools:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

async function main(): Promise<void> {
  const tools = await loadTools();
  const known = new Set(tools.map((t) => t.name));

  const server = new Server(
    { name: "meos-connectors", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // `ask_user` is always offered (it needs no connected service) alongside the
    // user's live connector tools.
    tools: [
      askUserToolDescriptor,
      ...tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: "object" } & Record<string, unknown>,
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    if (name === ASK_USER_TOOL) {
      return handleAskUser(args, extra as unknown as AskExtra);
    }
    if (!known.has(name)) {
      return {
        content: [{ type: "text", text: `Unknown connector tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const { result, isError } = await invokeConnectorTool(name, args ?? {});
      return { content: [{ type: "text", text: result }], isError };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[meos-connectors-mcp] fatal:", err);
  process.exit(1);
});
