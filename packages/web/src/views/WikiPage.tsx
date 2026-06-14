import { ChevronRight, Library, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Breadcrumbs, type Crumb, Page } from "@/components/Page";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ENTITY_TYPES } from "@/lib/entity-meta";
import { stripWikiMarkup } from "@/lib/wikilinks";
import { pushWikiTrail, readWikiTrail, type TrailEntry } from "@/lib/wiki-trail";
import { api, type EntitySummary, type WikiPage } from "../api.js";
import { utcDate } from "../lib/datetime.js";
import { Markdown } from "../components/Markdown.js";
import { SourceList } from "../components/SourceList.js";
import { GraphView } from "./GraphView.js";

/** Strip the YAML frontmatter and duplicate H1 — the header is rendered natively. */
function pageBody(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^# .*\n/, "")
    .trim();
}

export function WikiPageView() {
  const { slug } = useParams<{ slug: string }>();
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
    api.getWikiPage(slug).then(setPage).catch((e) => setError(String(e)));
    api.listEntities().then((r) => setEntities(r.entities)).catch(() => {});
  }, [slug]);

  // record the visit once the page name is known, so the breadcrumb reads well
  useEffect(() => {
    if (slug && page) setTrail(pushWikiTrail(slug, page.entity.name));
  }, [slug, page]);

  if (error) {
    return (
      <Page>
        <p className="text-sm text-faded">
          That page doesn't exist. <Link className="text-lamp" to="/wiki">Back to the wiki.</Link>
        </p>
      </Page>
    );
  }
  if (!page) return null;

  const TypeIcon = ENTITY_TYPES[page.entity.type]?.icon;
  const crumbs: Crumb[] = [
    { label: "Wiki", to: "/wiki", icon: Library },
    ...trail.map((entry) => ({
      label: entry.name,
      to: `/wiki/${entry.slug}`,
      ...(entry.slug === slug && TypeIcon ? { icon: TypeIcon } : {}),
    })),
  ];

  return (
    <Page>
        <Breadcrumbs items={crumbs} className="rise" />

        <header className="rise rise-1">
          <h2 className="font-serif text-3xl text-paper">{page.entity.name}</h2>
          {page.entity.summary && (
            <p className="mt-2 text-[15px] italic text-faded">{stripWikiMarkup(page.entity.summary)}</p>
          )}
          <p className="mt-2 font-mono text-[11px] text-dim">
            updated {utcDate(page.entity.updatedAt).toLocaleString()}
            {page.entity.stale && " · refresh pending"}
          </p>
        </header>

        <article className="rise rise-2 mt-8">
          {page.markdown ? (
            <Markdown text={pageBody(page.markdown)} entities={entities} />
          ) : (
            <p className="text-sm text-dim">This page hasn't been written yet — it will be after the next update.</p>
          )}
        </article>

        {page.relationships.length > 0 && (
          <section className="rise rise-3 mt-10">
            <Separator className="bg-line" />
            <div className="mt-6 flex items-center justify-between gap-4">
              <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-dim">connections</h3>
              <button
                onClick={() => setShowGraph((open) => !open)}
                className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-dim transition-colors hover:text-paper"
              >
                <Waypoints className="size-3.5" />
                {showGraph ? "Hide graph" : "Show graph"}
              </button>
            </div>

            {showGraph && (
              <div className="mt-4 h-[420px] overflow-hidden rounded-xl border border-line bg-desk">
                <GraphView focusSlug={slug} embedded />
              </div>
            )}

            <ul className="mt-3 space-y-1.5">
              {page.relationships.map((relationship, index) => {
                const other = entities.find((e) => e.name === relationship.other);
                const otherLink = other ? (
                  <Link className="text-lamp" to={`/wiki/${other.slug}`}>{relationship.other}</Link>
                ) : (
                  relationship.other
                );
                return (
                  <li key={index} className="text-sm text-faded">
                    {relationship.direction === "out" ? (
                      <>{relationship.label} {otherLink}</>
                    ) : (
                      <>{otherLink} {relationship.label} this</>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {page.sources.length > 0 && (
          <section className="rise rise-3 mt-10">
            <Separator className="bg-line" />
            <div className="mt-6">
              <SourceList sources={page.sources} defaultOpen />
            </div>
          </section>
        )}

        <section className="mt-10 pb-16">
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
                        observation.confidence >= 0.7 ? "text-moss" : observation.confidence >= 0.4 ? "text-lamp" : "text-ember",
                      )}
                    >
                      {observation.confidence.toFixed(2)}
                    </span>
                    <span className="flex-1 text-faded">{observation.text}</span>
                    <span
                      className={cn(
                        "shrink-0 whitespace-nowrap font-mono text-[11px]",
                        observation.stale ? "text-ember" : "text-dim",
                      )}
                      title={observation.stale ? "Unconfirmed past this fact's freshness horizon" : `Recorded ${utcDate(observation.recordedAt).toLocaleDateString()}`}
                    >
                      {observation.when}
                    </span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </section>
    </Page>
  );
}
