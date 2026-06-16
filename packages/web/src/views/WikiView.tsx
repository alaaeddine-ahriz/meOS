import { Link2, List, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SERVICE_BRANDS, SERVICE_ORDER } from "@/components/brand-logos";
import { ListRow, ListSection } from "@/components/list";
import { Page, PageBody, PageHeader } from "@/components/Page";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ENTITY_TYPES, ENTITY_TYPE_ORDER, type EntityTypeMeta } from "@/lib/entity-meta";
import { openExternal } from "@/lib/platform";
import { clearWikiTrail } from "@/lib/wiki-trail";
import { api, type EntitySummary, type LinkedEntity } from "../api.js";
import { GraphView } from "./GraphView.js";

type WikiMode = "list" | "graph" | "linked";

/** Group entities by type, in the canonical type order. */
function groupByType<T extends { type: string }>(entities: T[]) {
  const byType = new Map<string, T[]>();
  for (const entity of entities) {
    byType.set(entity.type, [...(byType.get(entity.type) ?? []), entity]);
  }
  return ENTITY_TYPE_ORDER.filter((type) => byType.has(type)).map((type) => ({
    type,
    meta: ENTITY_TYPES[type],
    entities: byType.get(type)!,
  }));
}

export function WikiView() {
  const [params, setParams] = useSearchParams();
  const mode: WikiMode =
    params.get("view") === "graph" ? "graph" : params.get("view") === "linked" ? "linked" : "list";
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [linked, setLinked] = useState<LinkedEntity[]>([]);
  const [loaded, setLoaded] = useState(false);

  const setMode = (next: string) => {
    const params2 = new URLSearchParams(params);
    if (next === "list") params2.delete("view");
    else params2.set("view", next);
    setParams(params2, { replace: true });
  };

  useEffect(() => {
    clearWikiTrail();
    api
      .listEntities()
      .then((r) => setEntities(r.entities))
      .finally(() => setLoaded(true));
    api
      .listLinkedEntities()
      .then((r) => setLinked(r.entities))
      .catch(() => {});
  }, []);

  const groups = useMemo(() => groupByType(entities), [entities]);

  const tabs = (
    <Tabs value={mode} onValueChange={setMode}>
      <TabsList>
        <TabsTrigger value="list">
          <List className="size-3.5" /> List
        </TabsTrigger>
        <TabsTrigger value="graph">
          <Waypoints className="size-3.5" /> Graph
        </TabsTrigger>
        <TabsTrigger value="linked">
          <Link2 className="size-3.5" /> Linked
          {linked.length > 0 && (
            <span className="tabular-nums text-muted-foreground">{linked.length}</span>
          )}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  return (
    <Page>
      <PageHeader
        title="Wiki"
        description={`${entities.length} pages, written and maintained by the system — never by you.`}
        actions={tabs}
      />
      {mode === "graph" ? (
        <div className="relative min-h-0 flex-1">
          <GraphView embedded />
        </div>
      ) : mode === "linked" ? (
        <LinkedPane entities={linked} loaded={loaded} />
      ) : (
        <PageBody>
          {loaded && entities.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing here yet. Add watched folders in{" "}
              <Link className="text-primary underline underline-offset-2" to="/settings">
                Settings
              </Link>{" "}
              and pages will appear on their own.
            </p>
          ) : (
            groups.map((group) => (
              <ListSection
                key={group.type}
                label={group.meta?.plural ?? group.type}
                count={group.entities.length}
              >
                {group.entities.map((entity) => (
                  <ListRow
                    key={entity.id}
                    to={`/wiki/${entity.slug}`}
                    icon={group.meta && <group.meta.icon className="size-4" />}
                    label={entity.name}
                  />
                ))}
              </ListSection>
            ))
          )}
        </PageBody>
      )}
    </Page>
  );
}

/** Linked browser: the same flat list as the List tab, with each connector the
 * entity is linked from shown as a clickable brand logo that opens the link. */
function LinkedPane({ entities, loaded }: { entities: LinkedEntity[]; loaded: boolean }) {
  const groups = useMemo(() => groupByType(entities), [entities]);

  return (
    <PageBody>
      {loaded && entities.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing linked yet. Connect Google in{" "}
          <Link className="text-primary underline underline-offset-2" to="/settings">
            Settings
          </Link>
          .
        </p>
      ) : (
        groups.map((group) => (
          <ListSection
            key={group.type}
            label={group.meta?.plural ?? group.type}
            count={group.entities.length}
          >
            {group.entities.map((entity) => (
              <LinkedRow key={entity.id} entity={entity} meta={group.meta} />
            ))}
          </ListSection>
        ))
      )}
    </PageBody>
  );
}

/** A list row matching {@link ListRow}, trailed by the brand logos of the
 * connectors this entity is linked from. Clicking a logo opens the link. */
function LinkedRow({ entity, meta }: { entity: LinkedEntity; meta?: EntityTypeMeta }) {
  const Icon = meta?.icon;
  const services = SERVICE_ORDER.filter((type) => entity.services.includes(type));
  return (
    <div className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {Icon && <Icon className="size-4" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{entity.name}</span>
      <span className="flex shrink-0 items-center gap-1">
        {services.map((type) => {
          const { label, Logo } = SERVICE_BRANDS[type]!;
          return entity.link ? (
            <button
              key={type}
              type="button"
              title={`Open in ${label}`}
              onClick={() => void openExternal(entity.link!)}
              className="rounded p-0.5 transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Logo className="size-4" />
            </button>
          ) : (
            <span key={type} title={label} className="p-0.5">
              <Logo className="size-4" />
            </span>
          );
        })}
      </span>
    </div>
  );
}
