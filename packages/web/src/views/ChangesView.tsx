import { ChevronRight, Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Breadcrumbs, Page, PageBody, PageHeader } from "@/components/Page";
import { cn } from "@/lib/utils";
import { api, type SourceDiff } from "../api.js";
import { utcDate } from "../lib/datetime.js";
import { DiffView } from "../components/DiffView.js";

export function ChangesView() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const [diff, setDiff] = useState<SourceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDiff(null);
    setError(null);
    if (!sourceId) return;
    api
      .getSourceDiff(Number(sourceId))
      .then(setDiff)
      .catch((e) => setError(String(e)));
  }, [sourceId]);

  if (error) {
    return (
      <Page>
        <PageBody>
          <p className="text-sm text-muted-foreground">
            Couldn't load this document's changes.{" "}
            <Link className="text-primary underline underline-offset-2" to="/activity?tab=feed">
              Back to the feed.
            </Link>
          </p>
        </PageBody>
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
            items={[
              { label: "Activity", to: "/activity?tab=feed", icon: Inbox },
              { label: diff.source.title },
            ]}
          />
        }
        title={diff.source.title}
        description={
          empty
            ? "This document didn't change any wiki pages."
            : "What this document created or changed in the wiki."
        }
      />

      <PageBody>
        {diff.commits.map((commit) => (
          <section key={commit.hash} className="mt-8 first:mt-0">
            <div className="flex items-baseline justify-between font-mono text-[11px] text-dim">
              <span>{commit.hash}</span>
              <span>{utcDate(commit.committedAt).toLocaleString()}</span>
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
                const chipClass =
                  "flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-sm";
                return (
                  <li key={file.path}>
                    {file.entitySlug ? (
                      <Link
                        to={`/wiki/${file.entitySlug}`}
                        className={cn(chipClass, "transition-colors hover:border-lamp-dim")}
                      >
                        {label}
                      </Link>
                    ) : (
                      <span className={chipClass}>{label}</span>
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
      </PageBody>
    </Page>
  );
}
