import { FileText, Plug } from "lucide-react";
import type { ComponentType } from "react";
import { type ConnectorCatalogApi, useConnectorCatalog } from "@/hooks/use-connector-catalog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { isRevealablePath, isTauri, openExternal, revealInFinder } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { SourceRef } from "../api.js";

/** Up to this many chips render inline; the rest collapse into "and N others". */
const MAX_VISIBLE = 6;

type LogoComponent = ComponentType<{ className?: string }>;

/** Connector kinds carry a namespaced type (e.g. "google:gmail"); files don't. */
function isConnectorSource(source: SourceRef): boolean {
  return Boolean(source.type?.includes(":"));
}

function sourceUrl(source: SourceRef): string | null {
  return source.path && /^https?:\/\//.test(source.path) ? source.path : null;
}

function isClickable(source: SourceRef): boolean {
  return Boolean(sourceUrl(source) || (isTauri && isRevealablePath(source.path)));
}

/** Open a connector item in the browser, or reveal a file in Finder (desktop). */
function openSource(source: SourceRef) {
  const url = sourceUrl(source);
  if (url) void openExternal(url);
  else if (isTauri && isRevealablePath(source.path)) void revealInFinder(source.path!);
}

type Chip =
  | { kind: "connector"; key: string; label: string; Logo: LogoComponent | null; refs: SourceRef[] }
  | { kind: "file"; key: string; source: SourceRef };

/**
 * Collapse a flat source list into display chips: one chip per connector service
 * (carrying all its references), and one chip per file. Connectors lead, in the
 * catalog's global kind order, then files in their given order. Service labels +
 * logos come from the connector catalog (so e.g. `google:tasks` resolves).
 */
function buildChips(sources: SourceRef[], catalog: ConnectorCatalogApi): Chip[] {
  const byService = new Map<string, SourceRef[]>();
  const files: SourceRef[] = [];
  for (const source of sources) {
    if (isConnectorSource(source)) {
      byService.set(source.type!, [...(byService.get(source.type!) ?? []), source]);
    } else {
      files.push(source);
    }
  }

  const chips: Chip[] = [...byService.entries()]
    .map(([type, refs]) => ({ type, refs, brand: catalog.brandForSourceType(type) }))
    .sort((a, b) => a.brand.order - b.brand.order)
    .map(({ type, refs, brand }) => ({
      kind: "connector" as const,
      key: type,
      label: brand.label,
      Logo: brand.Logo,
      refs,
    }));
  for (const source of files) {
    chips.push({ kind: "file", key: `file-${source.id}`, source });
  }
  return chips;
}

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[12px] text-faded transition-colors";

function ConnectorIcon({ Logo, className }: { Logo: LogoComponent | null; className?: string }) {
  return Logo ? <Logo className={className} /> : <Plug className={cn(className, "text-dim")} />;
}

/** A connector chip: service logo + count, with a hover card listing each item. */
function ConnectorChip({ chip }: { chip: Extract<Chip, { kind: "connector" }> }) {
  const { label, Logo, refs } = chip;
  return (
    <HoverCard openDelay={80} closeDelay={120}>
      <HoverCardTrigger asChild>
        <span className={cn(CHIP_CLASS, "cursor-default")}>
          <ConnectorIcon Logo={Logo} className="size-3.5 shrink-0" />
          <span>{label}</span>
          {refs.length > 1 ? <span className="text-dim">· {refs.length}</span> : null}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 border-line bg-card p-2">
        <p className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-wider text-dim">
          {label} · {refs.length}
        </p>
        <ul className="max-h-72 space-y-0.5 overflow-y-auto">
          {refs.map((ref) => (
            <li key={ref.id}>
              <SourceRow source={ref} Icon={Logo} />
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}

/** A file chip: file icon + name, clickable when it can be revealed/opened. */
function FileChip({ source }: { source: SourceRef }) {
  const clickable = isClickable(source);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => openSource(source)}
      title={source.path ?? source.title}
      className={cn(
        CHIP_CLASS,
        clickable ? "cursor-pointer hover:border-dim hover:text-paper" : "cursor-default",
      )}
    >
      <FileText className="size-3.5 shrink-0 text-dim" />
      <span className="max-w-[180px] truncate">{source.title}</span>
    </button>
  );
}

/** A single source row used inside the hover card and the full-list dialog. */
function SourceRow({ source, Icon }: { source: SourceRef; Icon: LogoComponent | null }) {
  const clickable = isClickable(source);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => openSource(source)}
      title={source.path ?? source.title}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-faded transition-colors",
        clickable ? "cursor-pointer hover:bg-desk hover:text-paper" : "cursor-default",
      )}
    >
      <ConnectorIcon Logo={Icon} className="size-3.5 shrink-0" />
      <span className="truncate">{source.title}</span>
    </button>
  );
}

/** "and N others" → a dialog listing every source, grouped the same way. */
function AllSourcesDialog({ chips, hiddenCount }: { chips: Chip[]; hiddenCount: number }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-[12px] text-dim underline-offset-2 transition-colors hover:text-faded hover:underline"
        >
          and {hiddenCount} other{hiddenCount > 1 ? "s" : ""}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sources</DialogTitle>
        </DialogHeader>
        <div className="-mx-2 max-h-[60vh] space-y-3 overflow-y-auto px-2">
          {chips.map((chip) =>
            chip.kind === "connector" ? (
              <div key={chip.key}>
                <div className="mb-1 flex items-center gap-1.5 px-1.5 font-mono text-[10px] uppercase tracking-wider text-dim">
                  <ConnectorIcon Logo={chip.Logo} className="size-3.5" />
                  {chip.label} · {chip.refs.length}
                </div>
                <ul className="space-y-0.5">
                  {chip.refs.map((ref) => (
                    <li key={ref.id}>
                      <SourceRow source={ref} Icon={chip.Logo} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <SourceRow key={chip.key} source={chip.source} Icon={null} />
            ),
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Unified source strip for a wiki page: connectors and files on one line.
 * Same connector → one chip with a reference count (hover for the list); each
 * file → its own chip. Beyond {@link MAX_VISIBLE} chips, the rest collapse into
 * an "and N others" link that opens the full list in a dialog.
 */
export function WikiSources({ sources }: { sources: SourceRef[] }) {
  const catalog = useConnectorCatalog();
  if (sources.length === 0) return null;
  const chips = buildChips(sources, catalog);
  const visible = chips.slice(0, MAX_VISIBLE);
  const hiddenCount = chips.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {visible.map((chip) =>
        chip.kind === "connector" ? (
          <ConnectorChip key={chip.key} chip={chip} />
        ) : (
          <FileChip key={chip.key} source={chip.source} />
        ),
      )}
      {hiddenCount > 0 && <AllSourcesDialog chips={chips} hiddenCount={hiddenCount} />}
    </div>
  );
}
