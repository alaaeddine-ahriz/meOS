import { ExternalLink, FileText, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ENTITY_TYPES, ENTITY_TYPE_ORDER, typeColor } from "@/lib/entity-meta";
import { cn } from "@/lib/utils";
import { ForceGraph, type EdgeSelection } from "../components/ForceGraph.js";
import { api, type GraphLink, type GraphNode } from "../api.js";

/**
 * The knowledge graph. With no props it maps the whole wiki under an inline
 * toolbar (an entity search, hide-weak, and a clickable legend that shows /
 * hides entity types). Pass `focusSlug` to render a single page and its
 * neighbours as a clean ego graph (the WikiPage side panel) with no toolbar.
 *
 * All filtering happens here, in the scoping block that feeds {@link ForceGraph};
 * the simulation/interaction stay in that engine.
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
  const [hideWeak, setHideWeak] = useState(true);
  const [query, setQuery] = useState("");
  // Keyboard cursor into the search results (↑/↓ to move, Enter to pick).
  const [activeIndex, setActiveIndex] = useState(0);
  // The entity the graph centres on. Seeded from focusSlug; the user can re-focus
  // by picking from search. null = whole graph (no ego focus).
  const [focusId, setFocusId] = useState<number | null>(null);
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

    // 2. Edge filter: keep edges whose endpoints are both visible.
    let links = graph.links.filter((l) => nodeIds.has(l.from) && nodeIds.has(l.to));

    // 3. Focus: keep the focus node and its direct neighbours (ego graph).
    if (focusId != null && nodeIds.has(focusId)) {
      const reachable = new Set<number>([focusId]);
      for (const l of links) {
        if (l.from === focusId) reachable.add(l.to);
        if (l.to === focusId) reachable.add(l.from);
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
  }, [graph, enabledTypes, focusId, hideWeak]);

  // Search matches by name; the matched ids drive the dropdown + focus.
  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return graph.nodes.filter((n) => n.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, graph.nodes]);

  const presentTypes = useMemo(
    () => ENTITY_TYPE_ORDER.filter((type) => graph.nodes.some((n) => n.type === type)),
    [graph.nodes],
  );

  const emptyAfterFilter = loaded && graph.nodes.length > 0 && data.nodes.length === 0;
  const typeOn = (type: string) => enabledTypes === null || enabledTypes.has(type);
  const toggleType = (type: string) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev ?? presentTypes);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // The graph canvas + its overlays (empty states, edge inspector). The sizing
  // wrapper is applied at each call site (h-full in the side panel; flex-1 below
  // the toolbar in the full view).
  const canvas = (sizing: string) => (
    <div className={cn("relative overflow-hidden", sizing)}>
      <ForceGraph nodes={data.nodes} links={data.links} onEdgeSelect={setSelectedEdge} />

      {loaded && graph.nodes.length === 0 && (
        <p className="absolute left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 px-6 text-center text-sm text-faded">
          Nothing to map yet. Add watched folders in{" "}
          <Link className="text-lamp" to="/settings">
            Settings
          </Link>{" "}
          and the graph will grow on its own.
        </p>
      )}

      {emptyAfterFilter && (
        <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-dim">
          No connections match these filters. Lower the confidence threshold or turn types back on.
        </p>
      )}

      {selectedEdge && <EdgeInspector edge={selectedEdge} onClose={() => setSelectedEdge(null)} />}
    </div>
  );

  // Side panel (WikiPage): a clean ego graph, no toolbar.
  if (embedded) return canvas("h-full");

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-3 px-10 pb-4">
        {/* Row 1: search · hide weak · count */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(e) => {
                if (searchMatches.length === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIndex((i) => Math.min(i + 1, searchMatches.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const pick = searchMatches[activeIndex];
                  if (pick) {
                    setFocusId(pick.id);
                    setQuery("");
                  }
                } else if (e.key === "Escape") {
                  setQuery("");
                }
              }}
              placeholder="Find an entity…"
              className="h-8 pl-8 text-sm"
            />
            {searchMatches.length > 0 && (
              <ul className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-line bg-popover shadow-md">
                {searchMatches.map((n, i) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => {
                        setFocusId(n.id);
                        setQuery("");
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-faded",
                        i === activeIndex && "bg-line/50",
                      )}
                    >
                      <span
                        className="inline-block size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: typeColor(n.type) }}
                      />
                      <span className="truncate">{n.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-faded">
            <Switch checked={hideWeak} onCheckedChange={setHideWeak} />
            Hide weak / isolated
          </label>

          <span className="ml-auto text-xs text-dim">
            {data.nodes.length} pages · {data.links.length} connections
          </span>
        </div>

        {/* Row 2: the legend doubles as the entity-type show/hide filter. */}
        {presentTypes.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {presentTypes.map((type) => {
              const on = typeOn(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleType(type)}
                  aria-pressed={on}
                  title={on ? "Hide" : "Show"}
                  className={cn(
                    "flex items-center gap-2 text-xs transition-opacity",
                    on ? "text-faded" : "text-dim opacity-50",
                  )}
                >
                  <span
                    className="inline-block size-2.5 rounded-full"
                    style={{ backgroundColor: typeColor(type) }}
                  />
                  {ENTITY_TYPES[type]?.plural ?? type}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {canvas("min-h-0 flex-1")}
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
