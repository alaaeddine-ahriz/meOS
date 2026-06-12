import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { api, type EntitySummary, type WikiPage } from "../api.js";
import { Markdown } from "../components/Markdown.js";
import { SourceList } from "../components/SourceList.js";

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

  useEffect(() => {
    setPage(null);
    setError(null);
    if (!slug) return;
    api.getWikiPage(slug).then(setPage).catch((e) => setError(String(e)));
    api.listEntities().then((r) => setEntities(r.entities)).catch(() => {});
  }, [slug]);

  if (error) {
    return (
      <div className="p-10 text-sm text-faded">
        That page doesn't exist. <Link className="text-lamp" to="/wiki">Back to the wiki.</Link>
      </div>
    );
  }
  if (!page) return null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <nav className="rise font-mono text-[11px] uppercase tracking-[0.25em] text-dim">
          <Link to="/wiki" className="hover:text-faded">wiki</Link> / {page.entity.type}
        </nav>

        <header className="rise rise-1 mt-4">
          <h2 className="font-serif text-4xl text-paper">{page.entity.name}</h2>
          {page.entity.summary && <p className="mt-2 text-[15px] italic text-faded">{page.entity.summary}</p>}
          <p className="mt-2 font-mono text-[11px] text-dim">
            updated {new Date(page.entity.updatedAt + "Z").toLocaleString()}
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
            <h3 className="mt-6 font-mono text-[11px] uppercase tracking-[0.25em] text-dim">connections</h3>
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
                    <span className="text-faded">{observation.text}</span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </section>
      </div>
    </div>
  );
}
