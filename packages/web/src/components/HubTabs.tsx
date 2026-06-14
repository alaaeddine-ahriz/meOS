import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The app's underline tab bar — a single in-page tab idiom shared by the
 * Activity hub and the Conflicts sub-tabs so the pattern lives in one place.
 */
export function HubTabs({ children, className }: { children: ReactNode; className?: string }) {
  return <nav className={cn("flex flex-wrap gap-1 border-b border-line", className)}>{children}</nav>;
}

/** One tab: a label, an optional count badge, and an active underline. */
export function HubTab({
  children,
  active,
  count,
  onClick,
}: {
  children: ReactNode;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative -mb-px flex items-center gap-2 px-3 py-2.5 text-sm transition-colors",
        active ? "text-paper" : "text-faded hover:text-paper",
      )}
    >
      {children}
      {count != null && <CountBadge count={count} />}
      {active && <span className="absolute inset-x-0 -bottom-px h-px bg-lamp" />}
    </button>
  );
}

/** A small pill showing a positive count; renders nothing at zero. Shared by the
 * hub tabs and the in-page section headings so the chip can't drift between them. */
export function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="rounded-full bg-line px-1.5 text-[11px] tabular-nums text-faded">{count}</span>
  );
}
