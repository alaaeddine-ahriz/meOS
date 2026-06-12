import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { stripWikiMarkup } from "@/lib/wikilinks";
import { api, type EntitySummary } from "../api.js";

const TYPE_ORDER = ["person", "project", "organisation", "concept", "place", "decision"];

const TYPE_LABELS: Record<string, string> = {
  person: "people",
  project: "projects",
  organisation: "organisations",
  concept: "concepts",
  place: "places",
  decision: "decisions",
};

export function WikiView() {
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
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
    return TYPE_ORDER.filter((type) => byType.has(type)).map((type) => ({
      type,
      entities: byType.get(type)!,
    }));
  }, [entities]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <header className="rise">
          <h2 className="font-serif text-3xl text-paper">Wiki</h2>
          <p className="mt-1 text-sm text-dim">
            {entities.length} pages, written and maintained by the system — never by you.
          </p>
        </header>

        {loaded && entities.length === 0 && (
          <p className="rise-1 mt-10 text-sm text-faded">
            Nothing here yet. Ingest a few documents from the <Link className="text-lamp" to="/inbox">Inbox</Link> and
            pages will appear on their own.
          </p>
        )}

        {groups.map((group, index) => (
          <section key={group.type} className={`rise-${Math.min(index + 1, 3)} rise mt-10`}>
            <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-dim">
              {TYPE_LABELS[group.type] ?? `${group.type}s`} · {group.entities.length}
            </h3>
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {group.entities.map((entity) => (
                <li key={entity.id}>
                  <Link
                    to={`/wiki/${entity.slug}`}
                    className="group flex items-baseline gap-4 py-3 transition-colors hover:bg-desk/50"
                  >
                    <span className="shrink-0 font-serif text-lg text-paper group-hover:text-lamp">
                      {entity.name}
                    </span>
                    <span className="truncate text-sm text-faded">
                      {entity.summary ? stripWikiMarkup(entity.summary) : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
