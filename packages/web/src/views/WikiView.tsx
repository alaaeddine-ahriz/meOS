import { Link2, List, type LucideIcon, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SERVICE_BRANDS, SERVICE_ORDER } from "@/components/brand-logos";
import { Page, PageHeader } from "@/components/Page";
import { ENTITY_TYPES, ENTITY_TYPE_ORDER } from "@/lib/entity-meta";
import { openExternal } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { clearWikiTrail } from "@/lib/wiki-trail";
import { api, type EntitySummary, type LinkedEntity } from "../api.js";
import { GraphView } from "./GraphView.js";

type WikiMode = "list" | "graph" | "linked";

export function WikiView() {
  const [params, setParams] = useSearchParams();
  const mode: WikiMode =
    params.get("view") === "graph" ? "graph" : params.get("view") === "linked" ? "linked" : "list";
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [linked, setLinked] = useState<LinkedEntity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);

  const setMode = (next: WikiMode) => {
    const params2 = new URLSearchParams(params);
    if (next === "list") params2.delete("view");
    else params2.set("view", next);
    setParams(params2, { replace: true });
  };

  useEffect(() => {
    // arriving at the index starts a fresh breadcrumb path
    clearWikiTrail();
    api
      .listEntities()
      .then((r) => setEntities(r.entities))
      .finally(() => setLoaded(true));
    // The linked-entity count powers the toggle badge, so fetch it up front too.
    api
      .listLinkedEntities()
      .then((r) => setLinked(r.entities))
      .catch(() => {});
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

  // Graph is the same knowledge, drawn as a force-directed map. It needs the
  // full-bleed canvas, so swap the whole surface and float the toggle over it.
  if (mode === "graph") {
    return (
      <div className="relative h-full">
        <div className="absolute right-10 top-10 z-10">
          <ViewToggle mode={mode} linkedCount={linked.length} onChange={setMode} />
        </div>
        <GraphView />
      </div>
    );
  }

  if (mode === "linked") {
    return (
      <Page>
        <PageHeader
          title="Linked"
          description="People and organisations from your connected accounts — searchable, but kept out of the wiki until a note or document mentions them."
          actions={<ViewToggle mode={mode} linkedCount={linked.length} onChange={setMode} />}
        />
        <LinkedList entities={linked} loaded={loaded} />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Wiki"
        description={`${entities.length} pages, written and maintained by the system — never by you.`}
        actions={<ViewToggle mode={mode} linkedCount={linked.length} onChange={setMode} />}
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
          <Link className="text-lamp" to="/settings">
            Settings
          </Link>{" "}
          and pages will appear on their own.
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

/** The browse list for connector-linked entities, grouped by type. */
function LinkedList({ entities, loaded }: { entities: LinkedEntity[]; loaded: boolean }) {
  const groups = useMemo(() => {
    const byType = new Map<string, LinkedEntity[]>();
    for (const entity of entities) {
      byType.set(entity.type, [...(byType.get(entity.type) ?? []), entity]);
    }
    return ENTITY_TYPE_ORDER.filter((type) => byType.has(type)).map((type) => ({
      type,
      meta: ENTITY_TYPES[type],
      entities: byType.get(type)!,
    }));
  }, [entities]);

  if (loaded && entities.length === 0) {
    return (
      <p className="rise-1 mt-10 text-sm text-faded">
        Nothing linked yet. Connect Google in{" "}
        <Link className="text-lamp" to="/settings">
          Settings
        </Link>{" "}
        and your contacts and calendar people will appear here.
      </p>
    );
  }

  return (
    <>
      {groups.map((group, index) => (
        <section key={group.type} className={cn("rise mt-8", `rise-${Math.min(index + 1, 3)}`)}>
          <h3 className="mb-1 flex items-center gap-2 px-2 font-mono text-[11px] uppercase tracking-[0.25em] text-dim">
            {group.meta ? group.meta.plural : group.type} · {group.entities.length}
          </h3>
          <ul>
            {group.entities.map((entity) => (
              <li key={entity.id}>
                <LinkedRow entity={entity} Icon={group.meta?.icon} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function LinkedRow({ entity, Icon }: { entity: LinkedEntity; Icon?: LucideIcon }) {
  const services = SERVICE_ORDER.filter((type) => entity.services.includes(type));
  const open = entity.link ? () => void openExternal(entity.link!) : undefined;
  const className =
    "group -mx-2 flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-desk";
  const inner = (
    <>
      {Icon && (
        <Icon className="size-4 shrink-0 text-dim transition-colors group-hover:text-lamp" />
      )}
      <span className="min-w-0 flex-1 truncate font-serif text-base text-paper">{entity.name}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {services.map((type) => {
          const { label, Logo } = SERVICE_BRANDS[type]!;
          return (
            <span key={type} title={label} className="inline-flex">
              <Logo className="size-3.5" />
            </span>
          );
        })}
      </span>
    </>
  );
  // A row with a deep link opens the underlying item; otherwise it's a plain entry.
  return open ? (
    <button type="button" onClick={open} title={`Open ${entity.name}`} className={className}>
      {inner}
    </button>
  ) : (
    <div className={cn(className, "cursor-default")}>{inner}</div>
  );
}

/** A List ⇄ Graph ⇄ Linked switch across the wiki's surfaces. */
function ViewToggle({
  mode,
  linkedCount,
  onChange,
}: {
  mode: WikiMode;
  linkedCount: number;
  onChange: (mode: WikiMode) => void;
}) {
  const pill = (active: boolean) =>
    cn(
      "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors",
      active ? "bg-card text-paper" : "text-faded hover:text-paper",
    );
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-line p-0.5">
      <button onClick={() => onChange("list")} className={pill(mode === "list")}>
        <List className="size-3.5" />
        List
      </button>
      <button onClick={() => onChange("graph")} className={pill(mode === "graph")}>
        <Waypoints className="size-3.5" />
        Graph
      </button>
      <button onClick={() => onChange("linked")} className={pill(mode === "linked")}>
        <Link2 className="size-3.5" />
        Linked
        {linkedCount > 0 && <span className="text-dim">{linkedCount}</span>}
      </button>
    </div>
  );
}
