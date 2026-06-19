import { asSchema, type ToolSet } from "ai";
import type { Embedder } from "../embedding/embedder.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import { connectorRegistry, type ConnectorRegistry } from "./registry.js";
import { ensureAccessToken } from "./sync.js";

/**
 * The chat-agent tools every currently-connected connector contributes, plus a
 * one-line prompt hint per contributing connector. This is the single place that
 * turns the connector registry into a live {@link ToolSet}: the in-app chat
 * ({@link "../chat/chat.js".ChatService}) and the local coding agent (agent mode,
 * via the connector-tools MCP) both build from here, so a connector's tools reach
 * every surface identically — and, crucially, BOTH reuse the account's already
 * authorized OAuth through {@link ensureAccessToken}. No surface ever runs its own
 * auth flow; the token is minted lazily server-side inside each tool's `execute`.
 */
export interface ConnectorAgentTools {
  tools: ToolSet;
  hints: string[];
}

/**
 * Assemble the agent tools from every connector whose account is connected and
 * has a usable token. Re-evaluate per turn (cheap — building a tool definition
 * costs no network; the access token is resolved lazily only when a tool runs).
 *
 * The lazy `getAccessToken` re-reads the account and refreshes through the
 * connector's OAuth surface, so a tool always runs against a live token derived
 * from the credentials the user already granted — never a second authentication.
 */
export function buildConnectorAgentTools(deps: {
  store: KnowledgeStore;
  embedder: Embedder;
  /** Defaults to the shared registry; injectable so tests can slot in a fake. */
  connectors?: ConnectorRegistry;
}): ConnectorAgentTools {
  const { store, embedder } = deps;
  const connectors = deps.connectors ?? connectorRegistry;
  const tools: ToolSet = {};
  const hints: string[] = [];
  for (const connector of connectors.list()) {
    if (!connector.agentTools) continue;
    const account = store.getConnectorAccount(connector.manifest.id);
    if (!account || !(account.refresh_token || account.access_token)) continue;
    const enabledKinds = new Set(
      store
        .listSyncState(account.id)
        .filter((s) => s.enabled)
        .map((s) => s.kind),
    );
    const contributed = connector.agentTools({
      store,
      embedder,
      enabledKinds,
      getAccessToken: async () => {
        const fresh = store.getConnectorAccount(connector.manifest.id);
        if (!fresh) throw new Error(`${connector.manifest.displayName} is no longer connected.`);
        return ensureAccessToken(store, fresh, connector);
      },
    });
    if (Object.keys(contributed).length === 0) continue;
    Object.assign(tools, contributed);
    if (connector.promptHint) hints.push(connector.promptHint);
  }
  return { tools, hints };
}

/** One tool's transport-neutral description: name, prose, and JSON-Schema inputs. */
export interface ConnectorToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema (draft-07) for the tool's input, for an MCP client to advertise. */
  inputSchema: unknown;
}

/**
 * Project a {@link ToolSet} into transport-neutral descriptors an MCP server can
 * advertise over the wire (the AI-SDK `tool()` objects don't cross a process
 * boundary; their schema does). The connector-tools MCP fetches these and
 * registers one MCP tool each, then proxies calls back to meOS for execution.
 */
export function connectorToolDescriptors(tools: ToolSet): ConnectorToolDescriptor[] {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema: asSchema(tool.inputSchema).jsonSchema,
  }));
}
