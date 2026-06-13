import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Page, PageHeader } from "@/components/Page";
import { ENTITY_TYPES, ENTITY_TYPE_ORDER } from "@/lib/entity-meta";
import { cn } from "@/lib/utils";
import { clearWikiTrail } from "@/lib/wiki-trail";
import { api, type EntitySummary } from "../api.js";

export function WikiView() {
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);

  useEffect(() => {
    // arriving at the index starts a fresh breadcrumb path
    clearWikiTrail();
    api
      .listEntities()
      .then((r) => setEntities(r.entities))
      .finally(() => setLoaded(true));
  }, []);

  const groups = useMemo(() => {
    const byType = new Map<string, EntitySummary[]>();
    for (const entity of entities) {
      byType.set(entity.type, [...(byType.get(entity.type) ?? []), entity]);
    }
    return ENTITY_TYPE_ORDER.filter((type) => byType.has(type)).map((type) => ({
      type,
      meta: ENTITY_TYPES[type]!,
      entities: byType.get(type)!,
    }));
  }, [entities]);

  const visible = filter ? groups.filter((g) => g.type === filter) : groups;

  return (
    <Page>
      <PageHeader
        title="Wiki"
        description={`${entities.length} pages, written and maintained by the system — never by you.`}
      />

      {groups.length > 1 && (
          <div className="rise rise-1 mt-6 flex flex-wrap gap-1.5">
            <button
              onClick={() => setFilter(null)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                filter === null
                  ? "border-lamp-dim bg-card text-paper"
                  : "border-line text-faded hover:text-paper",
              )}
            >
              All
            </button>
            {groups.map(({ type, meta, entities: group }) => (
              <button
                key={type}
                onClick={() => setFilter(filter === type ? null : type)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                  filter === type
                    ? "border-lamp-dim bg-card text-paper"
                    : "border-line text-faded hover:text-paper",
                )}
              >
                <meta.icon className="size-3.5" />
                {meta.plural}
                <span className="text-dim">{group.length}</span>
              </button>
            ))}
          </div>
        )}

        {loaded && entities.length === 0 && (
          <p className="rise-1 mt-10 text-sm text-faded">
            Nothing here yet. Add watched folders in{" "}
            <Link className="text-lamp" to="/settings">Settings</Link> and pages will appear on their own.
          </p>
        )}

        {visible.map((group, index) => (
          <section key={group.type} className={cn("rise mt-8", `rise-${Math.min(index + 1, 3)}`)}>
            <h3 className="mb-1 flex items-center gap-2 px-2 font-mono text-[11px] uppercase tracking-[0.25em] text-dim">
              {group.meta.plural} · {group.entities.length}
            </h3>
            <ul>
              {group.entities.map((entity) => (
                <li key={entity.id}>
                  <Link
                    to={`/wiki/${entity.slug}`}
                    className="group -mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-desk"
                  >
                    <group.meta.icon className="size-4 shrink-0 text-dim transition-colors group-hover:text-lamp" />
                    <span className="shrink-0 font-serif text-base text-paper">{entity.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </Page>
  );
}
