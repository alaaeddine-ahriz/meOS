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
import { getConnectorTools, invokeConnectorTool, type ConnectorToolDescriptor } from "./client.js";

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
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object" } & Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
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
