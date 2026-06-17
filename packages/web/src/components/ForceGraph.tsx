import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { typeColor } from "@/lib/entity-meta";
import { cn } from "@/lib/utils";
import type { GraphLink, GraphNode } from "../api.js";

interface SimNode {
  id: number;
  type: string;
  name: string;
  slug: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  degree: number;
}

interface SimLink {
  source: SimNode;
  target: SimNode;
  label: string;
  /** Backing relationship confidence (0–1); drives edge opacity/width. */
  confidence: number;
  /** Corroborated (multi-source / capped) → solid; otherwise generated → dashed. */
  confirmed: boolean;
  /** Representative source id, so the inspector can open the evidence. */
  sourceId: number | null;
  sourceCount: number;
}

/** What the caller's edge inspector receives when an edge is clicked. */
export interface EdgeSelection {
  from: { id: number; name: string; slug: string };
  to: { id: number; name: string; slug: string };
  label: string;
  confidence: number;
  confirmed: boolean;
  sourceId: number | null;
  sourceCount: number;
}

interface Sim {
  nodes: SimNode[];
  links: SimLink[];
  alpha: number;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const LINK_DISTANCE = 90;
// Cap per-tick speed so the explicit integrator can't diverge: with many nodes
// the repulsion impulses overshoot and positions otherwise explode to infinity.
const MAX_SPEED = 30;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** One step of a small force simulation: repulsion, link springs, weak gravity. */
function tick(sim: Sim): void {
  const { nodes, links, alpha } = sim;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 === 0) {
        dx = (Math.random() - 0.5) * 0.1;
        dy = (Math.random() - 0.5) * 0.1;
        d2 = dx * dx + dy * dy;
      }
      const d = Math.sqrt(d2);
      const force = Math.min(1200 / d2, 12) * alpha;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }
  for (const link of links) {
    const dx = link.target.x - link.source.x;
    const dy = link.target.y - link.source.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const stretch = ((d - LINK_DISTANCE) / d) * 0.08 * alpha;
    const fx = dx * stretch;
    const fy = dy * stretch;
    link.source.vx += fx;
    link.source.vy += fy;
    link.target.vx -= fx;
    link.target.vy -= fy;
  }
  for (const node of nodes) {
    node.vx -= node.x * 0.012 * alpha;
    node.vy -= node.y * 0.012 * alpha;
    node.vx *= 0.85;
    node.vy *= 0.85;
    const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    if (speed > MAX_SPEED) {
      node.vx = (node.vx / speed) * MAX_SPEED;
      node.vy = (node.vy / speed) * MAX_SPEED;
    }
    node.x += node.vx;
    node.y += node.vy;
  }
  sim.alpha *= 0.995;
}

/**
 * A self-contained force-directed graph on a canvas: small physics simulation,
 * drag to move a node, drag the background to pan, wheel to zoom, click a node to
 * open its wiki page. The data-fetching and chrome (header, legend, empty states)
 * live in the callers — {@link GraphView} for the whole wiki, the chat for the
 * subgraph an answer traversed — so the engine stays one implementation.
 */
export function ForceGraph({
  nodes: nodeData,
  links: linkData,
  className,
  wheelZoom = true,
  onEdgeSelect,
}: {
  nodes: GraphNode[];
  links: GraphLink[];
  className?: string;
  /** Allow wheel-to-zoom. Off inside a scrolling page (e.g. chat) so it doesn't trap scroll. */
  wheelZoom?: boolean;
  /**
   * Called when an edge is clicked (#89): the caller opens an inspector showing
   * the two entities, the relationship, confidence, and a link to the source
   * evidence. When omitted, edges aren't clickable (e.g. the chat subgraph).
   */
  onEdgeSelect?: (edge: EdgeSelection | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<Sim>({ nodes: [], links: [], alpha: 0 });
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const hoverRef = useRef<SimNode | null>(null);
  const hoverEdgeRef = useRef<SimLink | null>(null);
  const navigate = useNavigate();
  // Keep the latest callback without re-subscribing pointer handlers each render.
  const onEdgeSelectRef = useRef(onEdgeSelect);
  onEdgeSelectRef.current = onEdgeSelect;

  // Rebuild the simulation only when the actual graph content changes, not on
  // every render (the node/link arrays are fresh objects each time).
  const signature = useMemo(
    () =>
      `${nodeData.map((n) => n.id).join(",")}|${linkData
        .map((l) => `${l.from}-${l.to}-${l.label}-${l.confidence ?? ""}-${l.confirmed ? 1 : 0}`)
        .join(",")}`,
    [nodeData, linkData],
  );

  useEffect(() => {
    const nodes = new Map<number, SimNode>();
    const degree = new Map<number, number>();
    for (const link of linkData) {
      degree.set(link.from, (degree.get(link.from) ?? 0) + 1);
      degree.set(link.to, (degree.get(link.to) ?? 0) + 1);
    }
    nodeData.forEach((node, index) => {
      // golden-angle spiral keeps initial positions spread out
      const angle = index * 2.39996;
      const r = 24 * Math.sqrt(index + 1);
      const deg = degree.get(node.id) ?? 0;
      nodes.set(node.id, {
        ...node,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        degree: deg,
        radius: 4 + Math.min(8, Math.sqrt(deg) * 2),
      });
    });
    const links: SimLink[] = [];
    for (const link of linkData) {
      const source = nodes.get(link.from);
      const target = nodes.get(link.to);
      if (source && target)
        links.push({
          source,
          target,
          label: link.label,
          confidence: link.confidence ?? 1,
          confirmed: link.confirmed ?? false,
          sourceId: link.sourceId ?? null,
          sourceCount: link.sourceCount ?? 0,
        });
    }
    const sim: Sim = { nodes: [...nodes.values()], links, alpha: 1 };
    // settle the layout before first paint so it doesn't fly in from a spiral
    for (let i = 0; i < 150; i++) tick(sim);
    sim.alpha = 0.3;
    simRef.current = sim;

    // fit the settled layout into the viewport
    const canvas = canvasRef.current;
    if (canvas && sim.nodes.length > 0) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const node of sim.nodes) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x);
        maxY = Math.max(maxY, node.y);
      }
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      const spanX = maxX - minX + 160;
      const spanY = maxY - minY + 160;
      const k = Math.max(MIN_ZOOM, Math.min(1.4, Math.min(w / spanX, h / spanY)));
      viewRef.current = {
        k,
        x: w / 2 - ((minX + maxX) / 2) * k,
        y: h / 2 - ((minY + maxY) / 2) * k,
      };
    }
  }, [signature]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = container.clientWidth * dpr;
      canvas.height = container.clientHeight * dpr;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    // Theme tokens are constant between theme switches; reading them via
    // getComputedStyle forces a style recalc, so cache them and refresh only when
    // the <html> mode/palette actually changes rather than five reads per frame.
    // Read the shadcn base tokens directly. The role aliases (--line, --lamp …)
    // only exist as Tailwind utilities (--color-*), not as queryable custom
    // properties, so getComputedStyle returns "" for them — which the canvas
    // silently ignores, leaving edges black and labels tinted by the last node.
    const readTheme = () => ({
      line: cssVar("--dim"), // edge stroke: an opaque neutral that stays light on dark
      lamp: cssVar("--primary"), // hover highlight + active edge
      faded: cssVar("--muted-foreground"), // node labels
      paper: cssVar("--foreground"), // hovered label
      ink: cssVar("--background"), // node ring
    });
    let theme = readTheme();
    const themeObserver = new MutationObserver(() => {
      theme = readTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-palette"],
    });

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const sim = simRef.current;
      if (sim.alpha > 0.005) tick(sim);

      const dpr = window.devicePixelRatio || 1;
      const view = viewRef.current;
      const hover = hoverRef.current;
      const {
        line: lineColor,
        lamp: lampColor,
        faded: fadedColor,
        paper: paperColor,
        ink: inkColor,
      } = theme;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);

      const hoverEdge = hoverEdgeRef.current;
      const neighbors = new Set<SimNode>();
      if (hover) {
        neighbors.add(hover);
        for (const link of sim.links) {
          if (link.source === hover) neighbors.add(link.target);
          if (link.target === hover) neighbors.add(link.source);
        }
      }

      for (const link of sim.links) {
        const touchesHover = hover !== null && (link.source === hover || link.target === hover);
        const active = touchesHover || link === hoverEdge;
        // Trust shows in the stroke: a confirmed (corroborated) edge is solid, a
        // generated single-source one is dashed; opacity/width scale with confidence.
        const conf = link.confidence;
        ctx.strokeStyle = active ? lampColor : lineColor;
        const baseAlpha = 0.18 + conf * 0.42; // ~0.18 (weak) … ~0.6 (strong)
        ctx.globalAlpha = hover || hoverEdge ? (active ? 0.95 : 0.1) : baseAlpha;
        ctx.lineWidth = ((active ? 1.4 : 0.6 + conf * 0.9) as number) / view.k;
        ctx.setLineDash(link.confirmed ? [] : [4 / view.k, 3 / view.k]);
        ctx.beginPath();
        ctx.moveTo(link.source.x, link.source.y);
        ctx.lineTo(link.target.x, link.target.y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (active && link.label) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = fadedColor;
          ctx.font = `${10 / view.k}px "IBM Plex Mono", monospace`;
          ctx.textAlign = "center";
          ctx.fillText(
            link.label,
            (link.source.x + link.target.x) / 2,
            (link.source.y + link.target.y) / 2 - 4 / view.k,
          );
        }
      }

      for (const node of sim.nodes) {
        const muted = hover !== null && !neighbors.has(node);
        ctx.globalAlpha = muted ? 0.25 : 1;
        ctx.fillStyle = typeColor(node.type);
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fill();
        if (node === hover) {
          ctx.strokeStyle = lampColor;
          ctx.lineWidth = 1.5 / view.k;
          ctx.stroke();
        } else {
          ctx.strokeStyle = inkColor;
          ctx.lineWidth = 1 / view.k;
          ctx.stroke();
        }
      }

      // labels fade in with zoom; zoomed out only well-connected nodes are named
      const labelAlpha = Math.max(0, Math.min(1, (view.k - 0.6) / 0.5));
      ctx.textAlign = "center";
      for (const node of sim.nodes) {
        const highlighted = neighbors.has(node);
        const base = highlighted ? 1 : node.degree >= 3 ? Math.max(labelAlpha, 0.55) : labelAlpha;
        const alpha = hover && !highlighted ? base * 0.2 : base * 0.9;
        if (alpha < 0.05) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = node === hover ? paperColor : fadedColor;
        ctx.font = `${11 / view.k}px "IBM Plex Sans Variable", system-ui, sans-serif`;
        ctx.fillText(node.name, node.x, node.y + node.radius + 13 / view.k);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);

    const toWorld = (sx: number, sy: number) => {
      const view = viewRef.current;
      return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
    };

    const hitTest = (sx: number, sy: number): SimNode | null => {
      const { x, y } = toWorld(sx, sy);
      const slack = 4 / viewRef.current.k;
      // iterate backwards so the node drawn on top wins
      const nodes = simRef.current.nodes;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i]!;
        const dx = node.x - x;
        const dy = node.y - y;
        if (dx * dx + dy * dy <= (node.radius + slack) ** 2) return node;
      }
      return null;
    };

    // Distance from a point to the segment, to hit-test edges (#89). Only used
    // when the caller wants edge inspection, and only when no node was hit.
    const edgeHitTest = (sx: number, sy: number): SimLink | null => {
      if (!onEdgeSelectRef.current) return null;
      const { x, y } = toWorld(sx, sy);
      const tol = 5 / viewRef.current.k;
      let best: SimLink | null = null;
      let bestDist = tol;
      for (const link of simRef.current.links) {
        const ax = link.source.x;
        const ay = link.source.y;
        const bx = link.target.x;
        const by = link.target.y;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1;
        let t = ((x - ax) * dx + (y - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const px = ax + t * dx;
        const py = ay + t * dy;
        const dist = Math.hypot(x - px, y - py);
        if (dist < bestDist) {
          bestDist = dist;
          best = link;
        }
      }
      return best;
    };

    const toSelection = (link: SimLink): EdgeSelection => ({
      from: { id: link.source.id, name: link.source.name, slug: link.source.slug },
      to: { id: link.target.id, name: link.target.name, slug: link.target.slug },
      label: link.label,
      confidence: link.confidence,
      confirmed: link.confirmed,
      sourceId: link.sourceId,
      sourceCount: link.sourceCount,
    });

    let dragNode: SimNode | null = null;
    let panning = false;
    let moved = 0;
    let last = { x: 0, y: 0 };

    const onPointerDown = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      last = { x: event.offsetX, y: event.offsetY };
      moved = 0;
      dragNode = hitTest(event.offsetX, event.offsetY);
      panning = dragNode === null;
    };

    const onPointerMove = (event: PointerEvent) => {
      const view = viewRef.current;
      if (dragNode) {
        const world = toWorld(event.offsetX, event.offsetY);
        dragNode.x = world.x;
        dragNode.y = world.y;
        dragNode.vx = 0;
        dragNode.vy = 0;
        simRef.current.alpha = Math.max(simRef.current.alpha, 0.25);
        moved += Math.abs(event.offsetX - last.x) + Math.abs(event.offsetY - last.y);
        last = { x: event.offsetX, y: event.offsetY };
      } else if (panning) {
        view.x += event.offsetX - last.x;
        view.y += event.offsetY - last.y;
        moved += Math.abs(event.offsetX - last.x) + Math.abs(event.offsetY - last.y);
        last = { x: event.offsetX, y: event.offsetY };
      } else {
        const hit = hitTest(event.offsetX, event.offsetY);
        hoverRef.current = hit;
        // Only fall through to edge hover when not over a node, so node hover wins.
        hoverEdgeRef.current = hit ? null : edgeHitTest(event.offsetX, event.offsetY);
        canvas.style.cursor = hit || hoverEdgeRef.current ? "pointer" : "grab";
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (dragNode && moved < 5) {
        navigate(`/wiki/${dragNode.slug}`);
      } else if (!dragNode && !panning && moved < 5) {
        // A click on empty canvas: open an edge inspector if one was hit, else
        // clear any open inspector.
        const edge = edgeHitTest(event.offsetX, event.offsetY);
        onEdgeSelectRef.current?.(edge ? toSelection(edge) : null);
      }
      dragNode = null;
      panning = false;
      canvas.releasePointerCapture(event.pointerId);
    };

    const onPointerLeave = () => {
      hoverRef.current = null;
      hoverEdgeRef.current = null;
    };

    const onWheel = (event: WheelEvent) => {
      if (!wheelZoom) return;
      event.preventDefault();
      const view = viewRef.current;
      const factor = Math.exp(-event.deltaY * 0.002);
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
      // keep the point under the cursor fixed while zooming
      view.x = event.offsetX - ((event.offsetX - view.x) / view.k) * k;
      view.y = event.offsetY - ((event.offsetY - view.y) / view.k) * k;
      view.k = k;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    if (wheelZoom) canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      themeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [navigate, wheelZoom]);

  return (
    <div ref={containerRef} className={cn("relative h-full w-full overflow-hidden", className)}>
      <canvas ref={canvasRef} className="h-full w-full" style={{ cursor: "grab" }} />
    </div>
  );
}
