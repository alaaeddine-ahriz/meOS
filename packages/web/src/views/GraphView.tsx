import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ENTITY_TYPES, ENTITY_TYPE_ORDER, typeColor } from "@/lib/entity-meta";
import { ForceGraph } from "../components/ForceGraph.js";
import { api, type GraphLink, type GraphNode } from "../api.js";

/**
 * The knowledge graph. With no props it maps the whole wiki; pass `focusSlug`
 * to draw only one page and its direct connections (an ego graph). `embedded`
 * drops the floating title so it can sit inside another surface. The force
 * simulation and interaction live in {@link ForceGraph}; this view fetches the
 * data, scopes it, and frames it with a header and legend.
 */
export function GraphView({
  focusSlug,
  embedded = false,
}: { focusSlug?: string; embedded?: boolean } = {}) {
  const [data, setData] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({
    nodes: [],
    links: [],
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    api
      .getGraph()
      .then((graph) => {
        if (cancelled) return;
        // In focus mode keep only the page and its 1-hop neighbours, then the
        // edges induced among that set — "this page and its connections".
        if (focusSlug) {
          const focus = graph.nodes.find((n) => n.slug === focusSlug);
          const allowed = new Set<number>(focus ? [focus.id] : []);
          if (focus) {
            for (const link of graph.links) {
              if (link.from === focus.id) allowed.add(link.to);
              if (link.to === focus.id) allowed.add(link.from);
            }
          }
          setData({
            nodes: graph.nodes.filter((n) => allowed.has(n.id)),
            links: graph.links.filter((l) => allowed.has(l.from) && allowed.has(l.to)),
          });
        } else {
          setData({ nodes: graph.nodes, links: graph.links });
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [focusSlug]);

  const presentTypes = useMemo(
    () => ENTITY_TYPE_ORDER.filter((type) => data.nodes.some((n) => n.type === type)),
    [data.nodes],
  );

  // In focus mode the focus page itself is one of the nodes, so connections = nodes − 1.
  const connectionCount = focusSlug ? Math.max(0, data.nodes.length - 1) : data.links.length;
  const emptyFocus = focusSlug != null && loaded && connectionCount === 0;

  return (
    <div className="relative h-full overflow-hidden">
      <ForceGraph nodes={data.nodes} links={data.links} />

      {!embedded && (
        <header className="pointer-events-none absolute left-10 top-10">
          <h2 className="font-serif text-2xl text-paper">{focusSlug ? "Connections" : "Graph"}</h2>
          <p className="mt-1 text-sm text-dim">
            {focusSlug
              ? `${connectionCount} connected ${connectionCount === 1 ? "page" : "pages"}. Click a node to open it.`
              : `${data.nodes.length} pages · ${data.links.length} connections. Click a node to open its page.`}
          </p>
        </header>
      )}

      {loaded && !focusSlug && data.nodes.length === 0 && (
        <p className="pointer-events-auto absolute left-10 top-32 text-sm text-faded">
          Nothing to map yet. Add watched folders in{" "}
          <Link className="text-lamp" to="/settings">
            Settings
          </Link>{" "}
          and the graph will grow on its own.
        </p>
      )}

      {emptyFocus && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-dim">
          No connections yet.
        </p>
      )}

      {presentTypes.length > 0 && (
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
        </div>
      )}
    </div>
  );
}
