import { SERVICE_BRANDS, SERVICE_ORDER } from "@/components/brand-logos";
import { openExternal } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { SourceRef } from "../api.js";

/**
 * Chips showing which external services reference this entity — a colored service
 * logo per connector (Gmail / Google Calendar / Google Contacts). These are
 * *references*: connector data complements an existing wiki page without feeding
 * its prose, so the chips are how the link surfaces. A chip opens the underlying
 * item externally when exactly one source of that service carries a URL; with
 * several it stays a non-interactive indicator (the Sources list below the page
 * lists each one). Renders nothing when no connector source backs the entity.
 */
export function ServiceChips({ sources }: { sources: SourceRef[] }) {
  // Group connector sources by service type, in stable display order.
  const byService = new Map<string, SourceRef[]>();
  for (const type of SERVICE_ORDER) {
    const matches = sources.filter((s) => s.type === type);
    if (matches.length > 0) byService.set(type, matches);
  }
  if (byService.size === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {[...byService].map(([type, items]) => {
        const brand = SERVICE_BRANDS[type]!;
        const { label, Logo } = brand;
        // Open the item directly only when a single source unambiguously links out.
        const url =
          items.length === 1 && items[0]!.path && /^https?:\/\//.test(items[0]!.path)
            ? items[0]!.path
            : null;
        const count = items.length;
        const title = url
          ? `Open in ${label}`
          : count > 1
            ? `${count} ${label} references`
            : `Linked to ${label}`;
        const className = cn(
          "inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[12px] text-faded transition-colors",
          url ? "cursor-pointer hover:text-paper hover:border-dim" : "cursor-default",
        );
        const inner = (
          <>
            <Logo className="size-3.5 shrink-0" />
            <span>{label}</span>
            {count > 1 ? <span className="text-dim">· {count}</span> : null}
          </>
        );
        return url ? (
          <button
            key={type}
            type="button"
            title={title}
            className={className}
            onClick={() => void openExternal(url)}
          >
            {inner}
          </button>
        ) : (
          <span key={type} title={title} className={className}>
            {inner}
          </span>
        );
      })}
    </div>
  );
}
