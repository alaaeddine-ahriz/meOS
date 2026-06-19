import { Activity, Database, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  type ConnectorCatalogApi,
  type SourceTypeBrand,
  useConnectorCatalog,
} from "@/hooks/use-connector-catalog";
import { ListSection } from "@/components/list";
import { Breadcrumbs, Page, PageBody, PageHeader, type Crumb } from "@/components/Page";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ENTITY_TYPES } from "@/lib/entity-meta";
import { openExternal } from "@/lib/platform";
import { api, type IndexedSource, type SourceDetail } from "../api.js";
import { HealthView } from "./HealthView.js";

/**
 * The Sources tab: every locally-indexed connector item — a contact, calendar
 * event, task, or email — as its own first-class entry, grouped by kind, each
 * with a link to open the original and links to the wiki entities (and sibling
 * items) it connects to. The browse companion to the Wiki tab; where the Wiki
 * shows the synthesised pages, this shows the raw indexed sources behind them.
 */

/** One displayable group of indexed sources, with its catalog-derived display. */
interface SourceGroup {
  kind: string;
  /** Display: title (plural noun), and the brand label/logo for the source type. */
  title: string;
  brand: SourceTypeBrand;
  items: IndexedSource[];
}

/**
 * Group indexed sources by kind, ordered by the kind's global catalog order so
 * the canonical Contacts → Calendar → Gmail → Tasks order holds, with unknown
 * kinds last. Each group's display (plural noun, logo, label) comes from the
 * catalog via the source type of its items.
 */
function groupByKind(items: IndexedSource[], catalog: ConnectorCatalogApi): SourceGroup[] {
  const byKind = new Map<string, IndexedSource[]>();
  for (const item of items) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  return [...byKind.entries()]
    .map(([kind, groupItems]) => {
      const sourceType = groupItems[0]?.type ?? kind;
      const resolved = catalog.kindOf(sourceType);
      const brand = catalog.brandForSourceType(sourceType);
      const title = resolved
        ? resolved.kind.noun.many.charAt(0).toUpperCase() + resolved.kind.noun.many.slice(1)
        : brand.label;
      return { kind, title, brand, items: groupItems, order: brand.order };
    })
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...group }) => group);
}

export function SourcesView() {
  const catalog = useConnectorCatalog();
  const [params, setParams] = useSearchParams();
  const tab: "items" | "health" = params.get("tab") === "health" ? "health" : "items";
  const [sources, setSources] = useState<IndexedSource[]>([]);
  const [loaded, setLoaded] = useState(false);

  const setTab = (next: string) => {
    const params2 = new URLSearchParams(params);
    if (next === "items") params2.delete("tab");
    else params2.set("tab", next);
    setParams(params2, { replace: true });
  };

  useEffect(() => {
    if (tab !== "items") return;
    api
      .listSources()
      .then((r) => setSources(r.sources))
      .finally(() => setLoaded(true));
  }, [tab]);

  const groups = useMemo(() => groupByKind(sources, catalog), [sources, catalog]);

  const tabs = (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="items">
          <Database className="size-3.5" /> Items
        </TabsTrigger>
        <TabsTrigger value="health">
          <Activity className="size-3.5" /> Health
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  return (
    <Page>
      <PageHeader
        title="Sources"
        description={
          tab === "health"
            ? "Where meOS reads from, what it indexed, and anything that needs your attention."
            : `${sources.length} indexed item${sources.length === 1 ? "" : "s"} from your connected services — each usable as a source for the wiki.`
        }
        actions={tabs}
      />
      <PageBody>
        {tab === "health" ? (
          <HealthView />
        ) : loaded && sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing indexed yet. Connect Google in{" "}
            <Link className="text-primary underline underline-offset-2" to="/settings">
              Settings
            </Link>{" "}
            and your contacts, events, tasks and emails will appear here.
          </p>
        ) : (
          groups.map((group) => {
            const Icon = group.brand.Logo;
            return (
              <ListSection key={group.kind} label={group.title} count={group.items.length}>
                {group.items.map((item) => (
                  <SourceRow
                    key={item.id}
                    item={item}
                    brand={catalog.brandForSourceType(item.type)}
                    icon={<Icon className="size-4" />}
                  />
                ))}
              </ListSection>
            );
          })
        )}
      </PageBody>
    </Page>
  );
}

/** One indexed-item row: kind icon, title, a chip of linked entities, and a
 * button to open the original in its provider. The row links to the detail page. */
function SourceRow({
  item,
  brand,
  icon,
}: {
  item: IndexedSource;
  brand: SourceTypeBrand;
  icon?: React.ReactNode;
}) {
  const gone = item.status === "deleted" || item.status === "missing";
  // A source is "referenced" only by entities that actually have a wiki page — raw
  // extraction of page-less entities is not a wiki reference.
  const refCount = item.linkedEntities.filter((e) => e.hasPage).length;
  return (
    <div className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <Link to={`/sources/${item.id}`} className="min-w-0 flex-1 truncate hover:underline">
        <span className={gone ? "text-muted-foreground line-through" : undefined}>
          {item.title || "(untitled)"}
        </span>
      </Link>
      {refCount > 0 && (
        <span
          className="shrink-0 text-xs tabular-nums text-muted-foreground"
          title={`Referenced by ${refCount} wiki page${refCount === 1 ? "" : "s"}`}
        >
          {refCount} referenced
        </span>
      )}
      {item.link && (
        <button
          type="button"
          title={`Open in ${brand.label}`}
          onClick={() => void openExternal(item.link!)}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ExternalLink className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** The detail page for one indexed item: its content, the entities it links to,
 * and the sibling items it connects to through a shared entity. */
export function SourcePageView() {
  const catalog = useConnectorCatalog();
  const { id } = useParams();
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setDetail(null);
    setError(null);
    api
      .getSource(Number(id))
      .then(setDetail)
      .catch((e) => setError(String(e)));
  }, [id]);

  // Resolve display from the catalog: the kind (for its singular noun, and to
  // know whether the type is a recognised connector source) and the brand.
  const resolvedKind = detail ? catalog.kindOf(detail.type) : undefined;
  const brand = detail ? catalog.brandForSourceType(detail.type) : undefined;
  const crumbs: Crumb[] = [{ label: "Sources", to: "/sources" }, { label: detail?.title ?? "…" }];

  return (
    <Page>
      <PageHeader
        title={detail?.title ?? "Source"}
        breadcrumb={<Breadcrumbs items={crumbs} />}
        description={resolvedKind ? resolvedKind.kind.noun.one : undefined}
        actions={
          detail?.link && resolvedKind && brand ? (
            <button
              type="button"
              onClick={() => void openExternal(detail.link!)}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-sm text-faded transition-colors hover:text-paper"
            >
              <brand.Logo className="size-4" /> Open in {brand.label}
            </button>
          ) : undefined
        }
      />
      <PageBody>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !detail ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex max-w-2xl flex-col gap-6">
            {detail.content && (
              <pre className="whitespace-pre-wrap rounded-md border border-line bg-card/40 p-3 text-sm text-foreground">
                {detail.content}
              </pre>
            )}

            {/* "Referenced by": a source is a raw indexed item — it has no wiki page of
                its own. It surfaces here only once a wiki entry actually references it,
                i.e. an entity it mentions has a synthesised page built (in part) from it.
                Page-less extracted entities are not wiki references and aren't shown. */}
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Referenced by
              </h2>
              {(() => {
                const referencedBy = detail.linkedEntities.filter((e) => e.hasPage);
                if (referencedBy.length === 0) {
                  return (
                    <p className="text-sm text-muted-foreground">
                      Not yet referenced by any wiki page.
                    </p>
                  );
                }
                return (
                  <ul className="flex flex-col gap-1">
                    {referencedBy.map((e) => {
                      const EntityIcon = ENTITY_TYPES[e.type]?.icon;
                      return (
                        <li key={e.id} className="text-sm">
                          <Link
                            to={`/wiki/${e.slug}`}
                            className="flex items-center gap-2 text-primary hover:underline underline-offset-2"
                          >
                            {EntityIcon && (
                              <EntityIcon className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            {e.name}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
            </section>

            {detail.relatedSources.length > 0 && (
              <section>
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Related items
                </h2>
                <ul className="flex flex-col gap-1">
                  {detail.relatedSources.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 text-sm">
                      <Link to={`/sources/${r.id}`} className="truncate hover:underline">
                        {r.title || "(untitled)"}
                      </Link>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        via {r.via.join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </PageBody>
    </Page>
  );
}
