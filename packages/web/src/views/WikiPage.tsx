import { ChevronRight, Library, Maximize2, Waypoints, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Breadcrumbs, type Crumb, Page } from "@/components/Page";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ENTITY_TYPES } from "@/lib/entity-meta";
import { stripWikiMarkup, wikiSlugFromHref } from "@/lib/wikilinks";
import { pushWikiTrail, readWikiTrail, type TrailEntry } from "@/lib/wiki-trail";
import { api, type EntitySummary, type WikiPage } from "../api.js";
import { utcDate } from "../lib/datetime.js";
import { Markdown } from "../components/Markdown.js";
import { ServiceChips } from "../components/ServiceChips.js";
import { SourceList } from "../components/SourceList.js";
import { GraphView } from "./GraphView.js";

/** Strip the YAML frontmatter and duplicate H1 — the header is rendered natively. */
function pageBody(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^# .*\n/, "")
    .trim();
}

export interface WikiPageViewProps {
  /** Render this slug instead of the route param — for the chat's side panel. */
  slug?: string;
  /** Panel mode: drop the full-page chrome, add a header with close + expand. */
  embedded?: boolean;
  /** In embedded mode, open another wiki slug in the same panel instead of routing. */
  onNavigate?: (slug: string) => void;
  /** In embedded mode, close the panel. */
  onClose?: () => void;
}

export function WikiPageView({
  slug: slugProp,
  embedded = false,
  onNavigate,
  onClose,
}: WikiPageViewProps = {}) {
  const params = useParams<{ slug: string }>();
  const slug = slugProp ?? params.slug;
  const [page, setPage] = useState<WikiPage | null>(null);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [trail, setTrail] = useState<TrailEntry[]>(readWikiTrail());
  const [showGraph, setShowGraph] = useState(false);

  useEffect(() => {
    setPage(null);
    setError(null);
    setShowGraph(false);
    if (!slug) return;
    api
      .getWikiPage(slug)
      .then(setPage)
      .catch((e) => setError(String(e)));
    api
      .listEntities()
      .then((r) => setEntities(r.entities))
      .catch(() => {});
  }, [slug]);

  // record the visit once the page name is known, so the breadcrumb reads well
  // (route mode only — the panel keeps its own lightweight header)
  useEffect(() => {
    if (!embedded && slug && page) setTrail(pushWikiTrail(slug, page.entity.name));
  }, [embedded, slug, page]);

  // An entity link that stays in the panel when embedded, else routes normally.
  const EntityRef = ({ slug: s, name }: { slug: string; name: string }) =>
    embedded && onNavigate ? (
      <button type="button" className="text-lamp hover:underline" onClick={() => onNavigate(s)}>
        {name}
      </button>
    ) : (
      <Link className="text-lamp" to={`/wiki/${s}`}>
        {name}
      </Link>
    );

  if (error) {
    const back = embedded ? (
      <button type="button" className="text-lamp hover:underline" onClick={onClose}>
        Close
      </button>
    ) : (
      <Link className="text-lamp" to="/wiki">
        Back to the wiki.
      </Link>
    );
    const message = <p className="text-sm text-faded">That page doesn't exist. {back}</p>;
    return embedded ? <div className="p-4">{message}</div> : <Page>{message}</Page>;
  }
  if (!page) {
    // Keep the panel framed (with its close button) while the page loads.
    if (!embedded) return null;
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-sm text-dim">Loading…</span>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="rounded-md p-1 text-dim transition-colors hover:bg-card hover:text-paper"
          >
            <X className="size-4" />
          </button>
        </header>
      </div>
    );
  }

  const TypeIcon = ENTITY_TYPES[page.entity.type]?.icon;
  const crumbs: Crumb[] = [
    { label: "Wiki", to: "/wiki", icon: Library },
    ...trail.map((entry) => ({
      label: entry.name,
      to: `/wiki/${entry.slug}`,
      ...(entry.slug === slug && TypeIcon ? { icon: TypeIcon } : {}),
    })),
  ];

  // The reading body — shared by the full page and the side panel.
  const body = (
    <>
      {!embedded && <Breadcrumbs items={crumbs} className="rise" />}

      <header className={cn(!embedded && "rise rise-1")}>
        {!embedded && <h2 className="font-serif text-3xl text-paper">{page.entity.name}</h2>}
        {page.entity.summary && (
          <p className={cn("italic text-faded", embedded ? "text-sm" : "mt-2 text-[15px]")}>
            {stripWikiMarkup(page.entity.summary)}
          </p>
        )}
        <p className="mt-2 font-mono text-[11px] text-dim">
          updated {utcDate(page.entity.updatedAt).toLocaleString()}
          {page.entity.stale && " · refresh pending"}
        </p>
        {/* Linked external services (Gmail/Calendar/Contacts) shown as reference chips. */}
        <ServiceChips sources={page.sources} />
      </header>

      <article className={cn(embedded ? "mt-5" : "rise rise-2 mt-8")}>
        {page.markdown ? (
          <Markdown
            text={pageBody(page.markdown)}
            entities={entities}
            onInternalLink={
              embedded && onNavigate ? (href) => onNavigate(wikiSlugFromHref(href)) : undefined
            }
          />
        ) : (
          <p className="text-sm text-dim">
            This page hasn't been written yet — it will be after the next update.
          </p>
        )}
      </article>

      {page.relationships.length > 0 && (
        <section className={cn(embedded ? "mt-8" : "rise rise-3 mt-10")}>
          <Separator className="bg-line" />
          <div className="mt-6 flex items-center justify-between gap-4">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-dim">
              connections
            </h3>
            {/* The graph navigates on node-click, which would leave the panel — route only. */}
            {!embedded && (
              <button
                onClick={() => setShowGraph((open) => !open)}
                className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-dim transition-colors hover:text-paper"
              >
                <Waypoints className="size-3.5" />
                {showGraph ? "Hide graph" : "Show graph"}
              </button>
            )}
          </div>

          {!embedded && showGraph && (
            <div className="mt-4 h-[420px] overflow-hidden rounded-xl border border-line bg-desk">
              <GraphView focusSlug={slug} embedded />
            </div>
          )}

          <ul className="mt-3 space-y-1.5">
            {page.relationships.map((relationship, index) => {
              const other = entities.find((e) => e.name === relationship.other);
              const otherLink = other ? (
                <EntityRef slug={other.slug} name={relationship.other} />
              ) : (
                relationship.other
              );
              return (
                <li key={index} className="text-sm text-faded">
                  {relationship.direction === "out" ? (
                    <>
                      {relationship.label} {otherLink}
                    </>
                  ) : (
                    <>
                      {otherLink} {relationship.label} this
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {page.sources.length > 0 && (
        <section className={cn(embedded ? "mt-8" : "rise rise-3 mt-10")}>
          <Separator className="bg-line" />
          <div className="mt-6">
            <SourceList sources={page.sources} defaultOpen />
          </div>
        </section>
      )}

      <section className={cn("mt-10", !embedded && "pb-16")}>
        <Separator className="bg-line" />
        <Collapsible className="mt-6">
          <CollapsibleTrigger className="group flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.25em] text-dim transition-colors hover:text-faded">
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
            underlying facts · {page.observations.length}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-3 space-y-2">
              {page.observations.map((observation, index) => (
                <li key={index} className="flex items-baseline gap-3 text-sm">
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[11px]",
                      observation.confidence >= 0.7
                        ? "text-moss"
                        : observation.confidence >= 0.4
                          ? "text-lamp"
                          : "text-ember",
                    )}
                  >
                    {observation.confidence.toFixed(2)}
                  </span>
                  <span className="flex-1 text-faded">{observation.text}</span>
                  {observation.sourceStatus ? (
                    <span
                      className="shrink-0 whitespace-nowrap rounded-full border border-ember/40 px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-ember"
                      title={
                        observation.sourceStatus === "superseded"
                          ? "Backed only by a superseded version of its source"
                          : observation.sourceStatus === "deleted"
                            ? "Backed only by a deleted source"
                            : "Backed only by a source whose file is missing"
                      }
                    >
                      {observation.sourceStatus === "superseded"
                        ? "outdated"
                        : observation.sourceStatus}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "shrink-0 whitespace-nowrap font-mono text-[11px]",
                      observation.stale ? "text-ember" : "text-dim",
                    )}
                    title={
                      observation.stale
                        ? "Unconfirmed past this fact's freshness horizon"
                        : `Recorded ${utcDate(observation.recordedAt).toLocaleDateString()}`
                    }
                  >
                    {observation.when}
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </section>
    </>
  );

  if (!embedded) return <Page>{body}</Page>;

  // Side-panel chrome: a sticky header with the entity name, a link out to the
  // full page, and a close button; the reading body scrolls beneath it.
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        {TypeIcon && <TypeIcon className="size-4 shrink-0 text-lamp" />}
        <h2 className="min-w-0 flex-1 truncate font-serif text-lg text-paper">
          {page.entity.name}
        </h2>
        <Link
          to={`/wiki/${slug}`}
          title="Open full page"
          className="rounded-md p-1 text-dim transition-colors hover:bg-card hover:text-paper"
        >
          <Maximize2 className="size-4" />
        </Link>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="rounded-md p-1 text-dim transition-colors hover:bg-card hover:text-paper"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">{body}</div>
    </div>
  );
}
