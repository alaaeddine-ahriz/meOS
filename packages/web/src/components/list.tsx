import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

// Rows and headings bleed 0.5rem past the content box (-mx-2 + px-2) so their
// hover/selected background has padding while the text itself stays flush with
// the page title's left edge.
const BLEED = "-mx-2 w-[calc(100%+1rem)] rounded-md px-2";

/**
 * A collapsible category: an uppercase heading with a count that toggles its
 * rows. The heading and its rows align flush-left with the page title.
 */
export function ListSection({
  label,
  count,
  defaultOpen = true,
  children,
}: {
  label: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-5 last:mb-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          BLEED,
          "flex items-center gap-1.5 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span>{label}</span>
        {count != null && <span className="opacity-70">· {count}</span>}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </section>
  );
}

/** One list row: leading icon, label, optional trailing meta. The single row
 * idiom used across Wiki, Activity and Notes. Renders a Link when `to` is set. */
export function ListRow({
  icon,
  label,
  meta,
  active = false,
  onClick,
  to,
  title,
}: {
  icon?: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  to?: string;
  title?: string;
}) {
  const className = cn(
    BLEED,
    "flex items-center gap-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-accent text-accent-foreground" : "hover:bg-accent",
  );
  const inner = (
    <>
      {icon !== undefined && (
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta !== undefined && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</span>
      )}
    </>
  );
  if (to)
    return (
      <Link to={to} title={title} className={className}>
        {inner}
      </Link>
    );
  return (
    <button type="button" onClick={onClick} title={title} className={className}>
      {inner}
    </button>
  );
}
