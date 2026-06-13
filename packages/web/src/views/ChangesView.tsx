import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { api, type SourceDiff } from "../api.js";
import { DiffView } from "../components/DiffView.js";

export function ChangesView() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const [diff, setDiff] = useState<SourceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDiff(null);
    setError(null);
    if (!sourceId) return;
    api.getSourceDiff(Number(sourceId)).then(setDiff).catch((e) => setError(String(e)));
  }, [sourceId]);

  if (error) {
    return (
      <div className="p-10 text-sm text-faded">
        Couldn't load this document's changes. <Link className="text-lamp" to="/inbox">Back to the inbox.</Link>
      </div>
    );
  }
  if (!diff) return null;

  const empty = diff.commits.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <nav className="rise flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-dim">
          <Link to="/inbox" className="hover:text-faded">inbox</Link>
          <span>/</span>
          <span>changes</span>
        </nav>

        <header className="rise rise-1 mt-4">
          <h2 className="font-serif text-3xl text-paper">{diff.source.title}</h2>
          <p className="mt-2 text-sm text-dim">
            {empty
              ? "This document didn't change any wiki pages."
              : "What this document created or changed in the wiki."}
          </p>
        </header>

        {diff.commits.map((commit) => (
          <section key={commit.hash} className="rise rise-2 mt-8">
            <div className="flex items-baseline justify-between font-mono text-[11px] text-dim">
              <span>{commit.hash}</span>
              <span>{new Date(commit.committedAt + "Z").toLocaleString()}</span>
            </div>

            <ul className="mt-3 flex flex-wrap gap-2">
              {commit.files.map((file) => {
                const label = (
                  <>
                    <span
                      className={cn(
                        "font-mono text-[10px] uppercase tracking-wider",
                        file.kind === "created" ? "text-moss" : "text-lamp",
                      )}
                    >
                      {file.kind}
                    </span>
                    <span className="text-paper">{file.entityName ?? file.path}</span>
                    {file.entitySlug && <ChevronRight className="size-3 text-dim" />}
                  </>
                );
                return (
                  <li key={file.path}>
                    {file.entitySlug ? (
                      <Link
                        to={`/wiki/${file.entitySlug}`}
                        className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-sm transition-colors hover:border-lamp-dim"
                      >
                        {label}
                      </Link>
                    ) : (
                      <span className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-sm">
                        {label}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="mt-4">
              <DiffView patch={commit.patch} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
