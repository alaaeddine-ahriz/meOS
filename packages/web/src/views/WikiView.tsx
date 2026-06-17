import { List, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ListRow, ListSection } from "@/components/list";
import { Page, PageBody, PageHeader } from "@/components/Page";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ENTITY_TYPES, ENTITY_TYPE_ORDER } from "@/lib/entity-meta";
import { clearWikiTrail } from "@/lib/wiki-trail";
import { api, type EntitySummary } from "../api.js";
import { GraphView } from "./GraphView.js";

type WikiMode = "list" | "graph";

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
  const mode: WikiMode = params.get("view") === "graph" ? "graph" : "list";
  const [entities, setEntities] = useState<EntitySummary[]>([]);
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
