import { ChevronDown, FileText } from "lucide-react";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { isTauri, revealInFinder } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { SourceRef } from "../api.js";

/**
 * Collapsible list of the documents an answer or wiki page draws on. In the
 * desktop app, clicking a source reveals the original file in Finder; sources
 * without a file on disk (quick captures) are inert.
 */
export function SourceList({ sources, defaultOpen = false }: { sources: SourceRef[]; defaultOpen?: boolean }) {
  if (sources.length === 0) return null;

  return (
    <Sources defaultOpen={defaultOpen}>
      <SourcesTrigger
        count={sources.length}
        className="group font-mono text-[11px] uppercase tracking-[0.2em] text-dim transition-colors hover:text-faded"
      >
        <span>
          {sources.length} source{sources.length > 1 ? "s" : ""}
        </span>
        <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
      </SourcesTrigger>
      <SourcesContent>
        {sources.map((source) => {
          const revealable = isTauri && !!source.path;
          return (
            <Source
              key={source.id}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                if (source.path) void revealInFinder(source.path);
              }}
              title={source.path ?? undefined}
              className={cn(
                "text-[13px] text-faded transition-colors",
                revealable ? "cursor-pointer hover:text-paper" : "cursor-default",
              )}
            >
              <FileText className="size-3.5 shrink-0 text-dim" />
              <span className="truncate">{source.title}</span>
            </Source>
          );
        })}
      </SourcesContent>
    </Sources>
  );
}
