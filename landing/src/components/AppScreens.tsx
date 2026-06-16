import { Activity, Library, MessageSquare, NotebookPen } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Lightweight, faithful mock-ups of the real meOS surfaces. Not screenshots —
// they're drawn with the same palette and layout so they render crisp at any
// size and stay honest about what the app looks like.

const NAV: Array<{ icon: LucideIcon; id: string }> = [
  { icon: MessageSquare, id: "chat" },
  { icon: NotebookPen, id: "notes" },
  { icon: Library, id: "wiki" },
  { icon: Activity, id: "activity" },
];

function Chrome() {
  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-bg-soft px-3 py-2.5">
      <span className="size-2 rounded-full bg-dim/60" />
      <span className="size-2 rounded-full bg-dim/40" />
      <span className="size-2 rounded-full bg-dim/30" />
    </div>
  );
}

function Sidebar({ active }: { active: string }) {
  return (
    <div className="flex w-9 shrink-0 flex-col items-center gap-1 border-r border-border bg-bg-soft py-3">
      {NAV.map(({ icon: Icon, id }) => (
        <div
          key={id}
          className={
            "grid size-6 place-items-center rounded-md " +
            (id === active ? "bg-surface text-accent" : "text-dim")
          }
        >
          <Icon className="size-3.5" />
        </div>
      ))}
    </div>
  );
}

function Screen({ active, children }: { active: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden">
      <Chrome />
      <div className="flex h-56">
        <Sidebar active={active} />
        <div className="min-w-0 flex-1 overflow-hidden p-4">{children}</div>
      </div>
    </div>
  );
}

/** Chat — "Ask your own life" */
export function ChatScreen() {
  return (
    <Screen active="chat">
      <div className="flex h-full flex-col gap-3 text-[11px] leading-relaxed">
        <div className="self-end max-w-[80%] rounded-lg rounded-br-sm bg-accent/15 px-3 py-2 text-text">
          When did I last talk to Sarah about the Q3 launch?
        </div>
        <div className="max-w-[88%] rounded-lg rounded-bl-sm border border-border bg-bg-soft px-3 py-2 text-muted">
          You met Sarah on <span className="text-text">May 28</span> and agreed to ship the Q3
          launch the week of <span className="text-text">July 14</span>.
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded border border-border px-1.5 py-0.5 text-[9px] text-dim">
              note · 1-on-1
            </span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[9px] text-dim">
              wiki · Sarah Chen
            </span>
          </div>
        </div>
        <div className="mt-auto flex items-center gap-2 rounded-lg border border-border bg-bg-soft px-3 py-2 text-dim">
          Ask anything…
          <span className="ml-auto rounded bg-accent px-1.5 py-0.5 text-[9px] text-bg">↵</span>
        </div>
      </div>
    </Screen>
  );
}

/** Wiki — "A wiki you never write" */
export function WikiScreen() {
  return (
    <Screen active="wiki">
      <div className="flex h-full flex-col gap-2.5 text-[11px] leading-relaxed">
        <div className="text-[9px] uppercase tracking-wider text-accent">Person</div>
        <div className="text-lg font-semibold text-text">Sarah Chen</div>
        <div className="h-1.5 w-3/4 rounded bg-border" />
        <div className="h-1.5 w-full rounded bg-border" />
        <div className="h-1.5 w-5/6 rounded bg-border" />
        <div className="mt-1 grid grid-cols-2 gap-2">
          {[
            ["Role", "Head of Product"],
            ["Company", "Acme"],
            ["Last seen", "May 28"],
            ["Confidence", "High"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-md border border-border bg-bg-soft px-2.5 py-1.5">
              <div className="text-[9px] text-dim">{k}</div>
              <div className="text-text">{v}</div>
            </div>
          ))}
        </div>
      </div>
    </Screen>
  );
}

/** Graph — "It connects the dots" */
export function GraphScreen() {
  const nodes: Array<[number, number, string, boolean]> = [
    [130, 90, "You", true],
    [40, 40, "Sarah", false],
    [225, 45, "Acme", false],
    [235, 130, "Q3 Launch", false],
    [40, 145, "Berlin", false],
  ];
  const edges: Array<[number, number]> = [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [1, 2],
    [2, 3],
  ];
  return (
    <Screen active="wiki">
      <svg viewBox="0 0 270 185" className="h-full w-full">
        {edges.map(([a, b], i) => (
          <line
            key={i}
            x1={nodes[a][0]}
            y1={nodes[a][1]}
            x2={nodes[b][0]}
            y2={nodes[b][1]}
            stroke="var(--accent)"
            strokeOpacity="0.35"
            strokeWidth="1"
          />
        ))}
        {nodes.map(([x, y, label, hub], i) => {
          // keep labels inside the viewBox: right-half nodes label leftward.
          const right = x > 135;
          return (
            <g key={i}>
              <circle
                cx={x}
                cy={y}
                r={hub ? 7 : 5}
                fill={hub ? "var(--accent)" : "var(--bg-soft)"}
                stroke="var(--accent)"
                strokeWidth={hub ? 0 : 1.25}
              />
              <text
                x={hub ? x : x + (right ? -9 : 9)}
                y={hub ? y + 18 : y + 3}
                textAnchor={hub ? "middle" : right ? "end" : "start"}
                fontSize="9"
                fill="var(--muted)"
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </Screen>
  );
}
