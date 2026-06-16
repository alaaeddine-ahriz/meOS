import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * The shared page chrome. Every full-screen view is composed the same way:
 *
 *   <Page>
 *     <PageHeader title=… description=… actions=… />
 *     <PageBody>…</PageBody>
 *   </Page>
 *
 * so the title always sits at the same top/left inset, headers read identically,
 * and there is no divider between the header and the content. `bleed` opts a body
 * out of the scroll + padding for full-bleed surfaces (e.g. the graph canvas).
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
  if (bleed)
    return <div className={cn("relative h-full overflow-hidden", className)}>{children}</div>;
  return <div className={cn("flex h-full flex-col", className)}>{children}</div>;
}

/** The one header style used across the app: title, optional supporting line and
 * right-aligned actions, at a consistent top/left inset, with no bottom border. */
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
    <header className={cn("shrink-0 px-10 pb-6 pt-10", className)}>
      {breadcrumb}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </header>
  );
}

/** The scrollable body beneath a PageHeader, with the matching left/right inset. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto px-10 pb-10", className)}>{children}</div>
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
    <nav
      className={cn("mb-3 flex items-center gap-1.5 text-[13px] text-muted-foreground", className)}
    >
      {items.map((crumb, index) => {
        const last = index === items.length - 1;
        const Icon = crumb.icon;
        const inner = (
          <span className={cn("flex items-center gap-1.5", last && "text-foreground")}>
            {Icon && <Icon className="size-3.5 shrink-0 opacity-70" />}
            <span className="truncate">{crumb.label}</span>
          </span>
        );
        return (
          <span key={index} className="flex min-w-0 items-center gap-1.5">
            {index > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
            {crumb.to && !last ? (
              <Link to={crumb.to} className="truncate transition-colors hover:text-foreground">
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
