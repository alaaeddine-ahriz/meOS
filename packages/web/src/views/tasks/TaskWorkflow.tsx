import { Clock, FileText, Sparkles, type LucideIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { brandLogo, type LogoComponent } from "@/components/brand-logos";
import type { ConnectorCatalogApi } from "../../hooks/use-connector-catalog.js";
import type { TaskConnectorLink } from "../../api.js";

/**
 * The editable-workflow view of a scheduled agent task: a left-to-right graph of
 * Trigger → Connectors → Agent → Delivers, with dashed edges that "flow" while the
 * task is active. The connector lane is the point — it makes the data sources the
 * agent auto-identified from the instruction explicit and tangible, instead of
 * implied by prose. Edges are drawn as measured SVG béziers (node refs → anchor
 * points) so the lane scales to any number of connectors without hand-placed lines.
 */

/** One resolved connector node in the graph (a task link joined to the catalog). */
export interface WorkflowConnector {
  provider: string;
  kind: string;
  /** Display label, e.g. "Gmail". */
  label: string;
  /** A short "what it reads" line, e.g. "reads inbox". */
  sublabel: string;
  Logo: LogoComponent;
  /** Brand accent (hex) for the icon tint, if the catalog supplies one. */
  brandColor?: string;
  /** Whether the owning connector's account is actually connected. */
  connected: boolean;
}

/** Short "what the agent reads" line per source type; falls back to the kind noun. */
const SUBLABEL: Record<string, string> = {
  "google:gmail": "reads inbox",
  "google:calendar": "events & invites",
  "google:contacts": "address book",
  "google:tasks": "your to-dos",
  "imap:messages": "reads mailbox",
};

/**
 * Resolve a task's `{ provider, kind }` links into renderable connector nodes via
 * the catalog (labels, logos, brand colors) and the live connected-provider set.
 * Unknown links (a connector that was unregistered) are dropped. Shared by the
 * card and the composer so both render the same lane.
 */
export function buildWorkflowConnectors(
  links: readonly TaskConnectorLink[],
  catalog: ConnectorCatalogApi,
  connectedProviders: ReadonlySet<string>,
): WorkflowConnector[] {
  const out: WorkflowConnector[] = [];
  for (const link of links) {
    const connector = catalog.connector(link.provider);
    const kind = connector?.kinds.find((k) => k.kind === link.kind);
    if (!connector || !kind) continue;
    out.push({
      provider: link.provider,
      kind: link.kind,
      label: kind.displayName,
      sublabel: SUBLABEL[kind.sourceType] ?? `reads ${kind.noun.many}`,
      Logo: brandLogo(kind.logo),
      brandColor: connector.brandColor,
      connected: connectedProviders.has(link.provider),
    });
  }
  return out;
}

/** A 12%-opacity tint of a hex brand color for an icon backdrop. */
function tint(hex: string | undefined): string | undefined {
  return hex ? `color-mix(in srgb, ${hex} 14%, transparent)` : undefined;
}

interface NodeBoxProps {
  /** Stable node id used to anchor edges. */
  nodeId: string;
  register: (id: string) => (el: HTMLDivElement | null) => void;
  lane?: string;
  children: ReactNode;
  className?: string;
}

/** One graph node: a bordered card that occludes the edges passing under it. */
function NodeBox({ nodeId, register, lane, children, className }: NodeBoxProps) {
  return (
    <div className="flex flex-col items-stretch gap-1">
      {lane && (
        <span className="px-1 font-mono text-[9px] uppercase tracking-wider text-dim">{lane}</span>
      )}
      <div
        ref={register(nodeId)}
        className={`relative z-10 rounded-xl border border-line bg-card px-3 py-2.5 shadow-sm ${className ?? ""}`}
      >
        {children}
      </div>
    </div>
  );
}

/** An icon tile + a two-line label/sublabel, the body of most nodes. */
function NodeBody({
  icon,
  iconBg,
  iconColor,
  Logo,
  title,
  sub,
  badge,
}: {
  icon?: LucideIcon;
  iconBg?: string;
  iconColor?: string;
  Logo?: LogoComponent;
  title: ReactNode;
  sub?: ReactNode;
  badge?: ReactNode;
}) {
  const Icon = icon;
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: iconBg ?? "var(--color-desk)" }}
      >
        {Logo ? (
          <Logo className="size-4" />
        ) : Icon ? (
          <Icon className="size-4" style={iconColor ? { color: iconColor } : undefined} />
        ) : null}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-paper">{title}</span>
          {badge}
        </div>
        {sub && <div className="truncate text-[11px] text-dim">{sub}</div>}
      </div>
    </div>
  );
}

export interface TaskWorkflowProps {
  trigger: { label: string; sub: string };
  connectors: WorkflowConnector[];
  agent: { label: string; sub: string };
  delivers: { label: string; sub: string };
  /** Drives the edge flow animation + accent (paused tasks show static edges). */
  active: boolean;
}

/**
 * Render the Trigger → Connectors → Agent → Delivers graph. Edge paths are
 * recomputed from node geometry after layout and on resize, so they stay attached
 * however the lane reflows.
 */
export function TaskWorkflow({ trigger, connectors, agent, delivers, active }: TaskWorkflowProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const [paths, setPaths] = useState<string[]>([]);

  const register = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) nodes.current.set(id, el);
      else nodes.current.delete(id);
    },
    [],
  );

  // The edge list: with connectors, fan the trigger out to each and back into the
  // agent; with none, wire the trigger straight through. The agent always delivers.
  const edges: Array<[string, string]> =
    connectors.length === 0
      ? [
          ["trigger", "agent"],
          ["agent", "delivers"],
        ]
      : [
          ...connectors.map((c): [string, string] => ["trigger", `c:${c.provider}:${c.kind}`]),
          ...connectors.map((c): [string, string] => [`c:${c.provider}:${c.kind}`, "agent"]),
          ["agent", "delivers"],
        ];

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const compute = () => {
      const c = container.getBoundingClientRect();
      const next: string[] = [];
      for (const [from, to] of edges) {
        const s = nodes.current.get(from);
        const t = nodes.current.get(to);
        if (!s || !t) continue;
        const sr = s.getBoundingClientRect();
        const tr = t.getBoundingClientRect();
        const x1 = sr.right - c.left;
        const y1 = sr.top - c.top + sr.height / 2;
        const x2 = tr.left - c.left;
        const y2 = tr.top - c.top + tr.height / 2;
        const dx = Math.max(36, (x2 - x1) * 0.5);
        next.push(`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
      }
      setPaths(next);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    for (const el of nodes.current.values()) ro.observe(el);
    window.addEventListener("resize", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
    };
    // Re-measure whenever the lane composition or active state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors.map((c) => `${c.provider}:${c.kind}`).join(","), active]);

  return (
    <div className="overflow-x-auto">
      <div ref={containerRef} className="relative min-w-[680px] py-2">
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          {paths.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              strokeWidth={1.5}
              stroke={active ? "var(--color-lamp)" : "var(--color-line)"}
              strokeOpacity={active ? 0.7 : 1}
              className={`meos-flow-edge${active ? " is-active" : ""}`}
            />
          ))}
        </svg>

        <div className="relative flex items-stretch justify-between gap-6">
          {/* Trigger */}
          <div className="flex items-center">
            <NodeBox nodeId="trigger" register={register} lane="Trigger">
              <NodeBody icon={Clock} title={trigger.label} sub={trigger.sub} />
            </NodeBox>
          </div>

          {/* Connectors */}
          {connectors.length > 0 && (
            <div className="flex flex-col justify-center gap-3">
              {connectors.map((c) => (
                <NodeBox
                  key={`${c.provider}:${c.kind}`}
                  nodeId={`c:${c.provider}:${c.kind}`}
                  register={register}
                  className="min-w-[180px]"
                >
                  <NodeBody
                    Logo={c.Logo}
                    iconBg={tint(c.brandColor)}
                    title={c.label}
                    sub={c.sublabel}
                    badge={
                      c.connected ? (
                        <span className="rounded-full bg-moss/15 px-1.5 py-px text-[9px] font-medium text-moss">
                          connected
                        </span>
                      ) : (
                        <span className="rounded-full bg-ember/10 px-1.5 py-px text-[9px] font-medium text-ember">
                          connect
                        </span>
                      )
                    }
                  />
                </NodeBox>
              ))}
            </div>
          )}

          {/* Agent */}
          <div className="flex items-center">
            <NodeBox nodeId="agent" register={register} lane="Agent">
              <NodeBody
                icon={Sparkles}
                iconBg="color-mix(in srgb, var(--color-lamp) 16%, transparent)"
                iconColor="var(--color-lamp)"
                title={agent.label}
                sub={agent.sub}
              />
            </NodeBox>
          </div>

          {/* Delivers */}
          <div className="flex items-center">
            <NodeBox nodeId="delivers" register={register} lane="Delivers">
              <NodeBody icon={FileText} title={delivers.label} sub={delivers.sub} />
            </NodeBox>
          </div>
        </div>
      </div>
    </div>
  );
}
