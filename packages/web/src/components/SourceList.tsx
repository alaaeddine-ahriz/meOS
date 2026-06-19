import { ChevronDown, FileText } from "lucide-react";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { useConnectorCatalog } from "@/hooks/use-connector-catalog";
import { isRevealablePath, isTauri, openExternal, revealInFinder } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { SourceRef } from "../api.js";

/**
 * Collapsible list of the documents an answer or wiki page draws on. File
 * sources reveal the original in Finder (desktop only); connector sources are
 * clickable chips (with the service's brand logo from the catalog) that open the
 * underlying item in the system browser.
 */
export function SourceList({
  sources,
  defaultOpen = false,
}: {
  sources: SourceRef[];
  defaultOpen?: boolean;
}) {
  const catalog = useConnectorCatalog();
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
          // A connector source is one the catalog recognises by its source type;
          // it gets the service's brand logo and links out when its path is a URL.
          const isConnector = source.type ? Boolean(catalog.kindOf(source.type)) : false;
          const linkUrl =
            isConnector && source.path && /^https?:\/\//.test(source.path) ? source.path : null;
          const revealable = !isConnector && isTauri && isRevealablePath(source.path);
          const clickable = Boolean(linkUrl) || revealable;
          const Icon = isConnector ? catalog.brandForSourceType(source.type!).Logo : FileText;
          // Structure-aware locator (#14): show the section/page the citation
          // points at, when retrieval surfaced it. Backward-compatible: a source
          // without metadata renders exactly as before.
          const locatorParts: string[] = [];
          if (source.section) locatorParts.push(source.section);
          if (source.pageStart != null) {
            locatorParts.push(
              source.pageEnd != null && source.pageEnd !== source.pageStart
                ? `p.${source.pageStart}–${source.pageEnd}`
                : `p.${source.pageStart}`,
            );
          }
          const locator = locatorParts.join(" · ");
          return (
            <Source
              key={source.id}
              href={linkUrl ?? "#"}
              onClick={(event) => {
                event.preventDefault();
                if (linkUrl) void openExternal(linkUrl);
                else if (revealable) void revealInFinder(source.path!);
              }}
              title={source.path ?? undefined}
              className={cn(
                "text-[13px] text-faded transition-colors",
                clickable ? "cursor-pointer hover:text-paper" : "cursor-default",
              )}
            >
              <Icon className="size-3.5 shrink-0 text-dim" />
              <span className="truncate">{source.title}</span>
              {locator ? <span className="shrink-0 text-dim">· {locator}</span> : null}
            </Source>
          );
        })}
      </SourcesContent>
    </Sources>
  );
}
