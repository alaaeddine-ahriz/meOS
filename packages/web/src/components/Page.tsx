import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * The single page shell every view sits in, so width, padding and rhythm stay
 * identical across the app. `bleed` opts out of the centred content column for
 * full-bleed surfaces (e.g. the graph canvas).
 */
export function Page({
  children,
  className,
  bleed = false,
}: {
  children: ReactNode;
  className?: string;
  bleed?: boolean;
}) {
  if (bleed) return <div className={cn("relative h-full overflow-hidden", className)}>{children}</div>;
  return (
    <div className="h-full overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-4xl px-10 py-10", className)}>{children}</div>
    </div>
  );
}

/** A consistent page header: optional breadcrumb, a title, supporting line and actions. */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("rise", className)}>
      {breadcrumb}
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-2xl text-paper">{title}</h1>
          {description && <p className="mt-1 text-sm text-dim">{description}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </header>
  );
}

export interface Crumb {
  label: ReactNode;
  to?: string;
  icon?: LucideIcon;
}

/** A breadcrumb trail. The last crumb reads as the current location. */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav className={cn("mb-3 flex items-center gap-1.5 text-[13px] text-faded", className)}>
      {items.map((crumb, index) => {
        const last = index === items.length - 1;
        const Icon = crumb.icon;
        const inner = (
          <span className={cn("flex items-center gap-1.5", last && "text-paper")}>
            {Icon && <Icon className="size-3.5 shrink-0 opacity-70" />}
            <span className="truncate">{crumb.label}</span>
          </span>
        );
        return (
          <span key={index} className="flex min-w-0 items-center gap-1.5">
            {index > 0 && <ChevronRight className="size-3.5 shrink-0 text-dim" />}
            {crumb.to && !last ? (
              <Link to={crumb.to} className="truncate transition-colors hover:text-paper">
                {inner}
              </Link>
            ) : (
              inner
            )}
          </span>
        );
      })}
    </nav>
  );
}
