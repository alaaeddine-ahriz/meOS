import {
  CalendarLogo,
  ContactsLogo,
  FilesLogo,
  GmailLogo,
  KeepLogo,
  NotesLogo,
  type LogoItem,
} from "../lib/logos.tsx";
import { Logo } from "./Logo.tsx";

// Sources you already use feed into one brain — that's the whole pitch, drawn.
// Positions are in a 0–100 square so the SVG lines and the HTML bubbles align.
const NODES: Array<{ x: number; y: number } & Pick<LogoItem, "name" | "Logo">> = [
  { x: 50, y: 7, name: "Gmail", Logo: GmailLogo },
  { x: 88, y: 27, name: "Calendar", Logo: CalendarLogo },
  { x: 85, y: 71, name: "Keep", Logo: KeepLogo },
  { x: 50, y: 93, name: "Contacts", Logo: ContactsLogo },
  { x: 15, y: 71, name: "Notes", Logo: NotesLogo },
  { x: 12, y: 27, name: "Files", Logo: FilesLogo },
];

export function HeroVisual() {
  return (
    <div className="relative aspect-square w-full max-w-md">
      {/* ambient glow */}
      <div className="pointer-events-none absolute inset-1/4 rounded-full bg-accent/15 blur-3xl" />

      {/* connecting lines flow from each source into the centre */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full"
        aria-hidden="true"
      >
        {NODES.map((n, i) => (
          <line
            key={n.name}
            x1={n.x}
            y1={n.y}
            x2="50"
            y2="50"
            stroke="var(--accent)"
            strokeOpacity="0.35"
            strokeWidth="1"
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
            style={{ animation: `dash ${5 + (i % 3)}s linear infinite` }}
          />
        ))}
      </svg>

      {/* source bubbles */}
      {NODES.map((n, i) => (
        <div
          key={n.name}
          className="absolute grid size-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl border border-border bg-surface text-muted shadow-sm sm:size-14"
          style={{
            left: `${n.x}%`,
            top: `${n.y}%`,
            animation: `float ${4 + (i % 3)}s ease-in-out ${i * 0.35}s infinite`,
          }}
          title={n.name}
        >
          <span className="size-6 sm:size-7">
            <n.Logo />
          </span>
        </div>
      ))}

      {/* the brain */}
      <div className="absolute left-1/2 top-1/2 grid size-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-2xl bg-accent shadow-lg shadow-accent/30 sm:size-24">
        <Logo className="size-10 text-bg sm:size-12" />
      </div>
    </div>
  );
}
