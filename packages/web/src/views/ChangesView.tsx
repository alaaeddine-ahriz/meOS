import { ChevronRight, Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Breadcrumbs, Page, PageHeader } from "@/components/Page";
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
      <Page>
        <p className="text-sm text-faded">
          Couldn't load this document's changes. <Link className="text-lamp" to="/activity?tab=inbox">Back to the inbox.</Link>
        </p>
      </Page>
    );
  }
  if (!diff) return null;

  const empty = diff.commits.length === 0;

  return (
    <Page>
        <PageHeader
          breadcrumb={
            <Breadcrumbs
              className="rise"
              items={[
                { label: "Inbox", to: "/activity?tab=inbox", icon: Inbox },
                { label: diff.source.title },
              ]}
            />
          }
          className="rise-1"
          title={diff.source.title}
          description={
            empty
              ? "This document didn't change any wiki pages."
              : "What this document created or changed in the wiki."
          }
        />

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
    </Page>
  );
}
