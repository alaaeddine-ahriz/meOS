import { ExternalLink, FileText, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ENTITY_TYPES, ENTITY_TYPE_ORDER, typeColor } from "@/lib/entity-meta";
import { cn } from "@/lib/utils";
import { ForceGraph, type EdgeSelection } from "../components/ForceGraph.js";
import { api, type GraphLink, type GraphNode } from "../api.js";

/** Confidence floor below which edges/nodes are hidden by default — calm by default. */
const DEFAULT_THRESHOLD = 0.4;

/** Bucketed confidence thresholds, sharing WikiPage's tier breakpoints. */
const THRESHOLDS: { value: number; label: string; tone: string }[] = [
  { value: 0, label: "All", tone: "text-faded" },
  { value: 0.4, label: "Medium+", tone: "text-lamp" },
  { value: 0.7, label: "High", tone: "text-moss" },
];

/**
 * The knowledge graph. With no props it maps the whole wiki; pass `focusSlug`
 * to draw only one page and its connections (an ego graph). `embedded`
 * drops the floating title so it can sit inside another surface.
 *
 * #89 turns the old "show everything" map into a filtered knowledge map: type
 * chips, a confidence threshold (hides low-confidence by default), search +
 * focus around an entity with neighbour-depth control, a hide-weak-nodes
 * default, a confirmed-vs-generated edge legend, and an edge inspector that
 * opens the source evidence. All filtering happens here, in the scoping block
 * that feeds {@link ForceGraph}; the simulation/interaction stay in that engine.
 */
export function GraphView({
  focusSlug,
  embedded = false,
}: { focusSlug?: string; embedded?: boolean } = {}) {
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({
    nodes: [],
    links: [],
  });
  const [loaded, setLoaded] = useState(false);

  // --- Controls (client-side filters, layered on top of the endpoint) ---------
  // null = no explicit type filter yet → all present types shown.
  const [enabledTypes, setEnabledTypes] = useState<Set<string> | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [hideWeak, setHideWeak] = useState(true);
  const [query, setQuery] = useState("");
  // The entity the graph centres on. Seeded from focusSlug; the user can re-focus
  // by picking from search. null = whole graph (no ego focus).
  const [focusId, setFocusId] = useState<number | null>(null);
  const [depth, setDepth] = useState(1);
  const [selectedEdge, setSelectedEdge] = useState<EdgeSelection | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    api
      .getGraph()
      .then((g) => {
        if (cancelled) return;
        setGraph({ nodes: g.nodes, links: g.links });
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed/refresh the focus node from the focusSlug prop (the WikiPage side panel).
  useEffect(() => {
    if (!focusSlug) {
      setFocusId(null);
      return;
    }
    const node = graph.nodes.find((n) => n.slug === focusSlug);
    setFocusId(node ? node.id : null);
  }, [focusSlug, graph.nodes]);

  // The single scoping block: take the full graph and apply every filter, in an
  // order that keeps the result a consistent node/edge set.
  const data = useMemo(() => {
    const typeOk = (type: string) => enabledTypes === null || enabledTypes.has(type);

    // 1. Type filter on nodes.
    let nodes = graph.nodes.filter((n) => typeOk(n.type));
    let nodeIds = new Set(nodes.map((n) => n.id));

    // 2. Edge filter: both endpoints visible AND confidence ≥ threshold.
    let links = graph.links.filter(
      (l) => nodeIds.has(l.from) && nodeIds.has(l.to) && (l.confidence ?? 1) >= threshold,
    );

    // 3. Focus + neighbour depth: keep only nodes within `depth` hops of the
    //    focus node (over the already-thresholded edges), plus the focus itself.
    if (focusId != null && nodeIds.has(focusId)) {
      const adj = new Map<number, number[]>();
      for (const l of links) {
        (adj.get(l.from) ?? adj.set(l.from, []).get(l.from)!).push(l.to);
        (adj.get(l.to) ?? adj.set(l.to, []).get(l.to)!).push(l.from);
      }
      const reachable = new Set<number>([focusId]);
      let frontier = [focusId];
      for (let hop = 0; hop < depth; hop++) {
        const next: number[] = [];
        for (const id of frontier) {
          for (const nb of adj.get(id) ?? []) {
            if (!reachable.has(nb)) {
              reachable.add(nb);
              next.push(nb);
            }
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
      nodeIds = reachable;
      nodes = nodes.filter((n) => reachable.has(n.id));
      links = links.filter((l) => reachable.has(l.from) && reachable.has(l.to));
    }

    // 4. Hide weak/isolated nodes (default ON): a node with no surviving edge is
    //    isolated. The focus node is always kept so the ego view never empties.
    if (hideWeak) {
      const degree = new Map<number, number>();
      for (const l of links) {
        degree.set(l.from, (degree.get(l.from) ?? 0) + 1);
        degree.set(l.to, (degree.get(l.to) ?? 0) + 1);
      }
      nodes = nodes.filter((n) => n.id === focusId || (degree.get(n.id) ?? 0) > 0);
      nodeIds = new Set(nodes.map((n) => n.id));
      links = links.filter((l) => nodeIds.has(l.from) && nodeIds.has(l.to));
    }

    return { nodes, links };
  }, [graph, enabledTypes, threshold, focusId, depth, hideWeak]);

  // Search matches by name; the matched ids drive highlight + a "focus" affordance.
  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return graph.nodes.filter((n) => n.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, graph.nodes]);

  const presentTypes = useMemo(
    () => ENTITY_TYPE_ORDER.filter((type) => graph.nodes.some((n) => n.type === type)),
    [graph.nodes],
  );

  const focusNode = focusId != null ? graph.nodes.find((n) => n.id === focusId) : undefined;
  const emptyAfterFilter = loaded && graph.nodes.length > 0 && data.nodes.length === 0;

  const toggleType = (type: string) => {
    setEnabledTypes((prev) => {
      const base = prev ?? new Set(presentTypes);
      const next = new Set(base);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };
  const typeOn = (type: string) => enabledTypes === null || enabledTypes.has(type);

  return (
    <div className="relative h-full overflow-hidden">
      <ForceGraph nodes={data.nodes} links={data.links} onEdgeSelect={setSelectedEdge} />

      {!embedded && (
        <header className="pointer-events-none absolute left-10 top-10">
          <h2 className="font-serif text-2xl text-paper">{focusNode ? focusNode.name : "Graph"}</h2>
          <p className="mt-1 text-sm text-dim">
            {data.nodes.length} pages · {data.links.length} connections. Click a node to open its
            page, an edge to inspect it.
          </p>
        </header>
      )}

      {/* Controls. A compact popover in the embedded side panel; an open bar otherwise. */}
      <Controls
        embedded={embedded}
        presentTypes={presentTypes}
        typeOn={typeOn}
        toggleType={toggleType}
        threshold={threshold}
        setThreshold={setThreshold}
        hideWeak={hideWeak}
        setHideWeak={setHideWeak}
        query={query}
        setQuery={setQuery}
        searchMatches={searchMatches}
        onPickSearch={(id) => {
          setFocusId(id);
          setQuery("");
        }}
        focusNode={focusNode}
        clearFocus={focusSlug ? undefined : () => setFocusId(null)}
        depth={depth}
        setDepth={setDepth}
      />

      {loaded && graph.nodes.length === 0 && (
        <p className="pointer-events-auto absolute left-10 top-32 text-sm text-faded">
          Nothing to map yet. Add watched folders in{" "}
          <Link className="text-lamp" to="/settings">
            Settings
          </Link>{" "}
          and the graph will grow on its own.
        </p>
      )}

      {emptyAfterFilter && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-dim">
          No connections match these filters. Lower the confidence threshold or turn types back on.
        </p>
      )}

      {/* Legend: entity types + the confirmed-vs-generated edge idiom. */}
      {presentTypes.length > 0 && !embedded && (
        <div className="pointer-events-none absolute bottom-6 left-10 flex flex-col gap-1.5">
          {presentTypes.map((type) => (
            <div key={type} className="flex items-center gap-2 text-xs text-faded">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: typeColor(type) }}
              />
              {ENTITY_TYPES[type]!.plural}
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2 text-xs text-faded">
            <svg width="22" height="6" aria-hidden>
              <line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            confirmed
          </div>
          <div className="flex items-center gap-2 text-xs text-faded">
            <svg width="22" height="6" aria-hidden>
              <line
                x1="0"
                y1="3"
                x2="22"
                y2="3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="4 3"
              />
            </svg>
            generated
          </div>
        </div>
      )}

      {selectedEdge && <EdgeInspector edge={selectedEdge} onClose={() => setSelectedEdge(null)} />}
    </div>
  );
}

/** The filter controls. Inline bar (full view) or a popover (embedded panel). */
function Controls(props: {
  embedded: boolean;
  presentTypes: string[];
  typeOn: (type: string) => boolean;
  toggleType: (type: string) => void;
  threshold: number;
  setThreshold: (v: number) => void;
  hideWeak: boolean;
  setHideWeak: (v: boolean) => void;
  query: string;
  setQuery: (v: string) => void;
  searchMatches: GraphNode[];
  onPickSearch: (id: number) => void;
  focusNode: GraphNode | undefined;
  clearFocus?: () => void;
  depth: number;
  setDepth: (v: number) => void;
}) {
  const body = (
    <div className="flex flex-col gap-3">
      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
        <Input
          value={props.query}
          onChange={(e) => props.setQuery(e.target.value)}
          placeholder="Find an entity…"
          className="h-8 pl-8 text-sm"
        />
        {props.searchMatches.length > 0 && (
          <ul className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-line bg-popover shadow-md">
            {props.searchMatches.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => props.onPickSearch(n.id)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-faded hover:bg-line/50"
                >
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: typeColor(n.type) }}
                  />
                  <span className="truncate">{n.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Focus chip + neighbour depth */}
      {props.focusNode && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 text-faded">
            Focused:
            <span className="truncate font-medium text-paper">{props.focusNode.name}</span>
            {props.clearFocus && (
              <button
                type="button"
                onClick={props.clearFocus}
                className="text-dim hover:text-paper"
                aria-label="Clear focus"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
          <label className="flex shrink-0 items-center gap-1 text-dim">
            depth
            <select
              value={props.depth}
              onChange={(e) => props.setDepth(Number(e.target.value))}
              className="rounded border border-line bg-transparent px-1 py-0.5 text-xs text-paper"
            >
              {[1, 2, 3].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Confidence threshold buckets, coloured with WikiPage's tiers */}
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-dim">confidence</span>
        <div className="flex gap-1">
          {THRESHOLDS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => props.setThreshold(t.value)}
              className={cn(
                "flex-1 rounded border px-2 py-1 text-xs transition-colors",
                props.threshold === t.value
                  ? cn("border-current", t.tone)
                  : "border-line text-dim hover:text-faded",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Type chips */}
      {props.presentTypes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {props.presentTypes.map((type) => {
            const on = props.typeOn(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => props.toggleType(type)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-opacity",
                  on ? "border-line text-faded" : "border-line/50 text-dim opacity-50",
                )}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: typeColor(type) }}
                />
                {ENTITY_TYPES[type]?.plural ?? type}
              </button>
            );
          })}
        </div>
      )}

      {/* Hide weak/isolated toggle */}
      <label className="flex cursor-pointer items-center justify-between text-xs text-faded">
        Hide weak / isolated nodes
        <input
          type="checkbox"
          checked={props.hideWeak}
          onChange={(e) => props.setHideWeak(e.target.checked)}
          className="accent-lamp"
        />
      </label>
    </div>
  );

  if (props.embedded) {
    return (
      <div className="absolute right-3 top-3 z-10">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon" className="size-8" aria-label="Graph filters">
              <SlidersHorizontal className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64">
            {body}
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  return (
    <div className="absolute right-6 top-6 z-10 w-64 rounded-lg border border-line bg-desk/95 p-4 shadow-lg backdrop-blur">
      {body}
    </div>
  );
}

/** Inspector for a clicked edge: the two entities, the link, confidence, evidence. */
function EdgeInspector({ edge, onClose }: { edge: EdgeSelection; onClose: () => void }) {
  const tone =
    edge.confidence >= 0.7 ? "text-moss" : edge.confidence >= 0.4 ? "text-lamp" : "text-ember";
  return (
    <div className="absolute bottom-6 right-6 z-20 w-72 rounded-lg border border-line bg-desk/95 p-4 shadow-lg backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm leading-snug text-paper">
          <Link to={`/wiki/${edge.from.slug}`} className="font-medium hover:underline">
            {edge.from.name}
          </Link>{" "}
          <span className="text-dim">{edge.label}</span>{" "}
          <Link to={`/wiki/${edge.to.slug}`} className="font-medium hover:underline">
            {edge.to.name}
          </Link>
        </p>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-dim hover:text-paper"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-3 flex items-center gap-3 font-mono text-[11px]">
        <span className={tone}>{edge.confidence.toFixed(2)}</span>
        <span className="text-dim">
          {edge.confirmed ? "confirmed" : "generated"}
          {edge.sourceCount > 0 &&
            ` · ${edge.sourceCount} ${edge.sourceCount === 1 ? "source" : "sources"}`}
        </span>
      </div>
      {edge.sourceId != null && (
        <Link
          to={`/sources/${edge.sourceId}`}
          className="mt-3 flex items-center gap-1.5 text-xs text-lamp hover:underline"
        >
          <FileText className="size-3.5" />
          Open source evidence
          <ExternalLink className="size-3" />
        </Link>
      )}
    </div>
  );
}
