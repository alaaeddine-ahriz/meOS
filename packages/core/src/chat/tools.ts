import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Embedder } from "../embedding/embedder.js";
import type { KnowledgeStore, SourceRef, SubgraphEdge, SubgraphNode } from "../knowledge/store.js";
import { temporalTag } from "../memory/temporal.js";
import { buildContextPack } from "./retrieval.js";

/** The union of every entity/edge the agent traversed this turn, deduped. */
export interface TraversalGraph {
  nodes: Map<number, SubgraphNode>;
  edges: Map<string, SubgraphEdge>;
}

/**
 * The knowledge tools the agentic chat drives. They turn the formerly one-shot
 * retrieval into a loop the model steers: it can search, read a compiled wiki
 * page, inspect a single entity's facts, and walk the graph across as many hops
 * as the question needs — calling as many as it takes. Every tool that surfaces
 * evidence records the documents it drew on into the shared `sources` map (so the
 * answer cites them), and graph exploration accumulates every node/edge it visits
 * into `graph` (so the UI can draw the exact traversal behind the answer).
 */
export interface ChatTools {
  tools: ToolSet;
  /** Documents touched across every tool call this turn, deduped by id. */
  sources: Map<number, SourceRef>;
  /** The entities/edges traversed this turn, deduped — drawn under the answer. */
  graph: TraversalGraph;
}

/** Resolve an entity by exact/auto name first, then by slug — what users type. */
function resolveEntity(store: KnowledgeStore, name: string) {
  return store.findEntityByName(name) ?? store.getEntityBySlug(name.toLowerCase().replace(/\s+/g, "-"));
}

export function buildChatTools(store: KnowledgeStore, embedder: Embedder): ChatTools {
  const sources = new Map<number, SourceRef>();
  const remember = (refs: SourceRef[]) => {
    for (const source of refs) sources.set(source.id, source);
  };
  const graph: TraversalGraph = { nodes: new Map(), edges: new Map() };

  const tools: ToolSet = {
    search_knowledge: tool({
      description:
        "Search the user's knowledge base (their wiki, curated facts, and source documents) for anything relevant to a query. Use this first for almost any question, and again with refined queries to dig deeper or follow a new thread.",
      inputSchema: z.object({
        query: z.string().describe("What to look for, in natural language."),
      }),
      execute: async ({ query }) => {
        const pack = await buildContextPack(store, embedder, query);
        remember(pack.sources);
        return pack.text;
      },
    }),

    read_wiki_page: tool({
      description:
        "Read the full compiled wiki page for one entity — the synthesised summary of everything known about it. Use when a question centres on a specific person, project, or topic.",
      inputSchema: z.object({
        entity: z.string().describe("The entity's name (or slug)."),
      }),
      execute: async ({ entity }) => {
        const row = resolveEntity(store, entity);
        if (!row) return `No entity named "${entity}" exists in the knowledge base.`;
        const page = store.wikiPageBodies().find((p) => p.entity_id === row.id);
        if (!page || !page.body.trim()) {
          return `"${row.name}" exists but has no wiki page yet. Try get_entity for its raw facts.`;
        }
        remember(store.sourcesForEntity(row.id));
        return `# ${page.entity_name} (${page.type})\n${page.body}`;
      },
    }),

    get_entity: tool({
      description:
        "Get one entity's curated facts and relationships, each tagged with a date, confidence, and memory tier. Use to ground claims in specific observations or to hedge weakly-supported ones.",
      inputSchema: z.object({
        name: z.string().describe("The entity's name (or slug)."),
      }),
      execute: async ({ name }) => {
        const entity = resolveEntity(store, name);
        if (!entity) return `No entity named "${name}" exists in the knowledge base.`;
        const observations = store.activeObservations(entity.id).slice(0, 25);
        const relationships = store.relationshipsFor(entity.id).slice(0, 25);
        const lines = [
          `### ${entity.name} (${entity.type})`,
          entity.summary ? `Summary: ${entity.summary}` : "",
          ...observations.map((o) => {
            const source = o.source_id ? store.getSource(o.source_id) : undefined;
            if (source) sources.set(source.id, source);
            const tier = o.memory_tier !== "working" ? `, ${o.memory_tier}` : "";
            return `- [${temporalTag(o)}, confidence ${o.confidence.toFixed(2)}${source ? `, source: ${source.title}` : ""}${tier}] ${o.text}`;
          }),
          ...relationships.map((r) =>
            r.from_entity === entity.id ? `- ${entity.name} ${r.label} ${r.to_name}` : `- ${r.from_name} ${r.label} ${entity.name}`,
          ),
        ].filter(Boolean);
        return lines.join("\n");
      },
    }),

    explore_graph: tool({
      description:
        "Walk the knowledge graph outward from an entity, following relationships across MULTIPLE hops to assemble the full connected picture around it — dependents, decisions, people, and risks that share no query text with it. Use for impact and dependency questions ('what's affected if X changes?') and any time you need the complete neighbourhood, not just direct links. Call it again on a pivotal entity you discover to extend the map further. Everything you traverse is drawn for the user as an interactive graph beneath the answer.",
      inputSchema: z.object({
        name: z.string().describe("The entity to expand from (name or slug)."),
        depth: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe("How many hops to follow outward. Default 2; raise it for a fuller picture."),
      }),
      execute: async ({ name, depth }) => {
        const entity = resolveEntity(store, name);
        if (!entity) return `No entity named "${name}" exists in the knowledge base.`;
        const { nodes, edges } = store.exploreSubgraph(entity.id, depth ?? 2, 50);
        if (edges.length === 0) return `"${entity.name}" has no recorded connections yet.`;
        // Accumulate into the turn-level traversal graph the UI draws.
        for (const node of nodes) graph.nodes.set(node.id, node);
        for (const edge of edges) graph.edges.set(`${edge.from}->${edge.to}:${edge.label}`, edge);
        // A readable adjacency list keeps the multi-hop result legible to the model.
        const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
        const lines = edges.map((e) => `- ${nameOf.get(e.from)} ${e.label} ${nameOf.get(e.to)}`);
        return [
          `Explored ${nodes.length} ${nodes.length === 1 ? "entity" : "entities"} within ${depth ?? 2} hops of ${entity.name}:`,
          ...lines,
        ].join("\n");
      },
    }),
  };

  return { tools, sources, graph };
}
