import type { CSSProperties } from "react";
import { useState } from "react";
import { ChatScreen, GraphScreen, WikiScreen } from "./AppScreens.tsx";

const SCREENS = [
  {
    label: "Chat",
    title: "Ask your own life",
    body: "Ask anything in plain language. meOS answers from your own notes, emails, and files — with sources you can open.",
    screen: <ChatScreen />,
  },
  {
    label: "Wiki",
    title: "A wiki you never write",
    body: "meOS keeps a living page for every person, project, and idea in your world — updated automatically as you capture more.",
    screen: <WikiScreen />,
  },
  {
    label: "Knowledge graph",
    title: "It connects the dots",
    body: "People, projects, and events link into a graph you can explore — so you see how everything fits together.",
    screen: <GraphScreen />,
  },
];

const N = SCREENS.length;

// How a card sits given its distance from the front of the deck.
function deckStyle(pos: number): CSSProperties {
  const depth = [
    { x: 0, y: 0, scale: 1, opacity: 1, z: 30 },
    { x: 26, y: 20, scale: 0.94, opacity: 0.55, z: 20 },
    { x: 52, y: 40, scale: 0.88, opacity: 0.3, z: 10 },
  ][Math.min(pos, 2)];
  return {
    transform: `translate3d(${depth.x}px, ${depth.y}px, 0) scale(${depth.scale})`,
    opacity: depth.opacity,
    zIndex: depth.z,
    transition: "transform 0.4s cubic-bezier(0.2,0.7,0.3,1), opacity 0.4s ease",
    transformOrigin: "top center",
  };
}

export function Showcase() {
  const [active, setActive] = useState(0);
  const next = () => setActive((a) => (a + 1) % N);

  return (
    <section id="inside" className="border-b border-border px-5 py-16 sm:px-8">
      <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Inside meOS</h2>
      <p className="mt-3 max-w-xl text-muted">Three surfaces, one brain. Click through them.</p>

      <div className="mt-12 grid items-center gap-12 lg:grid-cols-2">
        {/* explanations double as the stepper */}
        <ol className="order-2 flex flex-col gap-3 lg:order-1">
          {SCREENS.map((s, i) => {
            const on = i === active;
            return (
              <li key={s.label}>
                <button
                  type="button"
                  onClick={() => setActive(i)}
                  aria-current={on}
                  className={
                    "flex w-full gap-4 rounded-lg border p-4 text-left transition-colors " +
                    (on
                      ? "border-accent-soft bg-surface"
                      : "border-transparent hover:bg-surface/60")
                  }
                >
                  <span className={"mt-0.5 font-mono text-sm " + (on ? "text-accent" : "text-dim")}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <span className="block font-semibold">{s.title}</span>
                    <span
                      className={
                        "mt-1 block text-sm leading-relaxed " + (on ? "text-muted" : "text-dim")
                      }
                    >
                      {s.body}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {/* the stacked deck */}
        <div className="order-1 lg:order-2">
          <div className="relative mx-auto h-[300px] w-full max-w-md">
            {SCREENS.map((s, i) => {
              const pos = (i - active + N) % N;
              const front = pos === 0;
              return (
                <button
                  type="button"
                  key={s.label}
                  onClick={() => (front ? next() : setActive(i))}
                  aria-label={front ? `${s.title} — next` : `Show ${s.title}`}
                  className="absolute inset-x-0 top-0 block cursor-pointer overflow-hidden rounded-xl border border-border bg-surface text-left shadow-2xl shadow-black/20"
                  style={deckStyle(pos)}
                >
                  {s.screen}
                </button>
              );
            })}
          </div>

          {/* dots */}
          <div className="mt-6 flex justify-center gap-2">
            {SCREENS.map((s, i) => (
              <button
                type="button"
                key={s.label}
                onClick={() => setActive(i)}
                aria-label={`Show ${s.title}`}
                className={
                  "h-1.5 rounded-full transition-all " +
                  (i === active ? "w-6 bg-accent" : "w-1.5 bg-border hover:bg-dim")
                }
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
