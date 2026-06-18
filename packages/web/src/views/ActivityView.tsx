import {
  Ban,
  CheckCircle2,
  ChevronRight,
  Clock,
  FilePenLine,
  FileText,
  GitMerge,
  type LucideIcon,
  PencilLine,
  ScanText,
  Search,
  Sparkles,
  Terminal,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ListRow } from "@/components/list";
import { Page, PageBody, PageHeader } from "@/components/Page";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import {
  api,
  streamActivity,
  type ActivityEvent,
  type InboxItem,
  type WikiRun,
  type WikiRunEventKind,
} from "../api.js";
import { epochOf, formatTime } from "../lib/datetime.js";
import { useInbox } from "../lib/inbox-context.js";

/** One rendered step of a transcript. Reasoning/text accrete deltas; tools are discrete. */
type Segment =
  | { kind: "reasoning" | "text"; text: string }
  | { kind: "tool-call" | "tool-result"; toolName: string; payload: string };

/**
 * The feed interleaves two kinds of moment in one timeline: a document landing
 * (a "doc") and the maintainer rewriting a page in response (a "run").
 */
type FeedItem = { kind: "run"; run: WikiRun } | { kind: "doc"; item: InboxItem };

function feedTime(entry: FeedItem): number {
  return epochOf(entry.kind === "run" ? entry.run.created_at : entry.item.updated_at);
}

/** Plain-language word for what happened to a document (used as the row tooltip). */
function docLabel(item: InboxItem): string {
  switch (item.status) {
    case "queued":
      return "queued";
    case "parsing":
      return "reading";
    case "extracting":
      return "extracting";
    case "merging":
      return "merging";
    case "done":
      return item.revision > 1 ? "updated" : "ingested";
    case "failed":
      return "failed";
    case "extract-failed":
      return "searchable · extraction failed";
    case "unsupported":
      return "skipped";
    default:
      return item.status;
  }
}

/**
 * The processing stages a feed element can be in. A document flows queued →
 * reading → extracting → merging → done; a maintainer run is writing → done.
 * The leading icon (and its colour) is the stage, so a glance down the feed
 * reads as a status column. {@link STATUS_META} drives both the icons and the
 * legend so they can never drift apart.
 */
type ProcStatus =
  | "queued"
  | "reading"
  | "extracting"
  | "merging"
  | "writing"
  | "done"
  | "failed"
  | "skipped";

const STATUS_META: Record<ProcStatus, { Icon: LucideIcon; label: string; className: string }> = {
  queued: { Icon: Clock, label: "Queued", className: "text-muted-foreground" },
  reading: { Icon: ScanText, label: "Reading", className: "text-primary" },
  extracting: { Icon: Sparkles, label: "Extracting", className: "text-primary" },
  merging: { Icon: GitMerge, label: "Merging", className: "text-primary" },
  writing: { Icon: PencilLine, label: "Writing", className: "text-primary" },
  done: { Icon: CheckCircle2, label: "Done", className: "text-moss" },
  failed: { Icon: XCircle, label: "Failed", className: "text-destructive" },
  skipped: { Icon: Ban, label: "Skipped", className: "text-muted-foreground" },
};

const LEGEND_ORDER: ProcStatus[] = [
  "queued",
  "reading",
  "extracting",
  "merging",
  "writing",
  "done",
  "failed",
  "skipped",
];

/** Map a document's ingest status onto a processing stage. */
function docStatus(status: InboxItem["status"]): ProcStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "parsing":
      return "reading";
    case "extracting":
      return "extracting";
    case "merging":
      return "merging";
    case "done":
      return "done";
    case "failed":
    case "extract-failed":
      return "failed";
    case "unsupported":
      return "skipped";
    default:
      return "queued";
  }
}

/** Map a maintainer run's status onto a processing stage. */
function runStatus(status: WikiRun["status"]): ProcStatus {
  return status === "running" ? "writing" : status === "done" ? "done" : "failed";
}

/** The processing stage of a feed element, used for the status filter. */
function feedStatus(entry: FeedItem): ProcStatus {
  return entry.kind === "run" ? runStatus(entry.run.status) : docStatus(entry.item.status);
}

/**
 * A key showing what each status icon means, pinned above the feed. Each entry
 * is a toggle: with none selected the whole feed shows; selecting one or more
 * narrows the feed to just those stages.
 */
function StatusLegend({
  selected,
  onToggle,
}: {
  selected: ReadonlySet<ProcStatus>;
  onToggle: (status: ProcStatus) => void;
}) {
  const filtering = selected.size > 0;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-border pb-3 text-xs">
      {LEGEND_ORDER.map((key) => {
        const { Icon, label, className } = STATUS_META[key];
        const on = selected.has(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => onToggle(key)}
            aria-pressed={on}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent",
              filtering && !on && "opacity-50",
            )}
          >
            <Icon className={cn("size-3.5", className)} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Append a streamed chunk to a transcript: merge consecutive reasoning/text, push tools. */
function appendChunk(
  segments: Segment[],
  kind: WikiRunEventKind,
  payload: string,
  toolName?: string,
): Segment[] {
  if (kind === "reasoning" || kind === "text") {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) {
      return [...segments.slice(0, -1), { kind, text: last.text + payload }];
    }
    return [...segments, { kind, text: payload }];
  }
  return [...segments, { kind, toolName: toolName ?? "tool", payload }];
}

export function ActivityView({ embedded = false }: { embedded?: boolean }) {
  const [runs, setRuns] = useState<WikiRun[]>([]);
  const { items: docs } = useInbox();
  const [transcripts, setTranscripts] = useState<ReadonlyMap<number, Segment[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const loaded = useRef<Set<number>>(new Set());
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<ProcStatus>>(new Set());

  const toggleStatus = (status: ProcStatus) =>
    setStatusFilter((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });

  useEffect(() => {
    api
      .getActivity()
      .then((r) => setRuns(r.runs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        for await (const event of streamActivity(controller.signal)) {
          applyEvent(event);
        }
      } catch {
        /* aborted on unmount, or the stream dropped — feed still shows persisted runs */
      }
    })();
    return () => controller.abort();
  }, []);

  const applyEvent = (event: ActivityEvent) => {
    if (event.type === "run-start") {
      loaded.current.add(event.runId);
      setTranscripts((current) => new Map(current).set(event.runId, []));
      setExpanded((current) => new Set(current).add(event.runId));
      setRuns((current) => {
        if (current.some((r) => r.id === event.runId)) return current;
        const run: WikiRun = {
          id: event.runId,
          entity_id: null,
          source_id: null,
          name: event.name,
          type: event.entityType,
          slug: event.slug,
          status: "running",
          created_at: new Date().toISOString(),
          finished_at: null,
        };
        return [run, ...current];
      });
    } else if (event.type === "event") {
      setTranscripts((current) => {
        const segments = current.get(event.runId) ?? [];
        return new Map(current).set(
          event.runId,
          appendChunk(segments, event.kind, event.payload, event.toolName),
        );
      });
    } else if (event.type === "run-finish") {
      setRuns((current) =>
        current.map((r) =>
          r.id === event.runId
            ? { ...r, status: event.status, finished_at: new Date().toISOString() }
            : r,
        ),
      );
    }
  };

  const toggle = async (run: WikiRun) => {
    const isOpen = expanded.has(run.id);
    setExpanded((current) => {
      const next = new Set(current);
      if (isOpen) next.delete(run.id);
      else next.add(run.id);
      return next;
    });
    if (!isOpen && !loaded.current.has(run.id)) {
      loaded.current.add(run.id);
      try {
        const { events } = await api.getRunEvents(run.id);
        const segments = events.map<Segment>((e) =>
          e.kind === "reasoning" || e.kind === "text"
            ? { kind: e.kind, text: e.payload }
            : { kind: e.kind, toolName: e.tool_name ?? "tool", payload: e.payload },
        );
        setTranscripts((current) => new Map(current).set(run.id, segments));
      } catch {
        loaded.current.delete(run.id);
      }
    }
  };

  // One timeline, newest first: documents arriving and the pages they prompt.
  const feed = useMemo<FeedItem[]>(
    () =>
      [
        ...runs.map<FeedItem>((run) => ({ kind: "run", run })),
        ...docs.map<FeedItem>((item) => ({ kind: "doc", item })),
      ].sort((a, b) => feedTime(b) - feedTime(a)),
    [runs, docs],
  );

  const visibleFeed =
    statusFilter.size === 0 ? feed : feed.filter((entry) => statusFilter.has(feedStatus(entry)));

  const content = (
    <>
      {feed.length > 0 && <StatusLegend selected={statusFilter} onToggle={toggleStatus} />}

      {feed.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet. Add{" "}
          <Link to="/settings" className="underline underline-offset-2">
            watched folders
          </Link>{" "}
          and MeOS starts reading — each document and the pages it rewrites show up here.
        </p>
      ) : visibleFeed.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity matches the selected status.</p>
      ) : (
        visibleFeed.map((entry) =>
          entry.kind === "run" ? (
            <RunRow
              key={`run-${entry.run.id}`}
              run={entry.run}
              open={expanded.has(entry.run.id)}
              segments={transcripts.get(entry.run.id)}
              onToggle={() => void toggle(entry.run)}
            />
          ) : (
            <DocRow key={`doc-${entry.item.id}`} item={entry.item} />
          ),
        )
      )}
    </>
  );

  if (embedded) return content;
  return (
    <Page>
      <PageHeader
        title="Activity"
        description="Documents landing and the wiki maintainer rewriting pages in response — one live timeline."
      />
      <PageBody>{content}</PageBody>
    </Page>
  );
}

/** A failed document carries a plain-language reason and a raw error for debugging. */
function failureSummary(item: InboxItem): string {
  switch (item.status) {
    case "extract-failed":
      return "The document was saved and is searchable, but MeOS couldn’t extract structured knowledge from it. It will retry automatically.";
    case "failed":
      return "MeOS couldn’t read this document, so nothing from it was saved.";
    default:
      return "Something went wrong while processing this document.";
  }
}

/** Plain-language name for each pipeline step the ingest can fail in. */
const STEP_LABEL = {
  reading: "Reading the document",
  indexing: "Indexing for search",
  extracting: "Extracting knowledge",
  merging: "Merging into the wiki",
};

/**
 * The pipeline records failures as "while <step>: <message>". Pull the step and
 * the clean message apart; fall back to deriving the step from the status for
 * details written before steps were recorded.
 */
function parseFailure(item: InboxItem): { stepLabel: string | null; message: string } {
  const detail = item.detail ?? "";
  const tagged = /^while (reading|indexing|extracting|merging):\s*([\s\S]*)$/i.exec(detail);
  if (tagged) {
    // The regex group is one of the four known steps, so the lookup always hits.
    const step = tagged[1]!.toLowerCase() as keyof typeof STEP_LABEL;
    return { stepLabel: STEP_LABEL[step], message: tagged[2]!.trim() };
  }
  // Legacy details: strip the old prefix and guess the step from the status.
  const message = detail.replace(/^searchable — extraction failed:\s*/i, "").trim();
  const fallback = item.status === "extract-failed" ? STEP_LABEL.extracting : STEP_LABEL.reading;
  return { stepLabel: message ? fallback : null, message };
}

/** The reason a document failed, revealed when its row is expanded. User-friendly
 * summary up top, the failing step and raw error underneath for debugging. */
function DocFailureDetail({ item }: { item: InboxItem }) {
  const { stepLabel, message } = parseFailure(item);
  return (
    <div className="mb-2 ml-6 space-y-2 border-l border-border pl-4 py-2">
      <p className="text-[13px] text-muted-foreground">{failureSummary(item)}</p>
      {stepLabel && (
        <p className="text-[12px] text-muted-foreground">
          <span className="text-foreground/70">Failed at:</span>{" "}
          <span className="font-medium text-foreground">{stepLabel}</span>
        </p>
      )}
      {item.path && (
        <p className="text-[12px] text-muted-foreground">
          <span className="text-foreground/70">File:</span>{" "}
          <span className="font-mono break-all">{item.path}</span>
        </p>
      )}
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Error detail
        </p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {message || "No error detail was recorded."}
        </pre>
      </div>
    </div>
  );
}

/** A document in the feed: links to its diff once done, or expands to show why it failed. */
function DocRow({ item }: { item: InboxItem }) {
  const stage = docStatus(item.status);
  const failed = stage === "failed";
  const linkable = item.status === "done" && item.source_id != null;
  const { Icon, className } = STATUS_META[stage];
  const [open, setOpen] = useState(false);

  if (failed) {
    return (
      <div>
        <ListRow
          active={open}
          onClick={() => setOpen((o) => !o)}
          title="Show why this document failed"
          icon={<Icon className={cn("size-4", className)} />}
          label={item.title}
          meta={
            <span className="flex items-center gap-1">
              {formatTime(item.updated_at)}
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            </span>
          }
        />
        {open && <DocFailureDetail item={item} />}
      </div>
    );
  }

  return (
    <ListRow
      to={linkable ? `/changes/${item.source_id}` : undefined}
      title={docLabel(item)}
      icon={<Icon className={cn("size-4", className)} />}
      label={item.title}
      meta={formatTime(item.updated_at)}
    />
  );
}

/** A maintainer run: clicking the row expands its transcript inline beneath it. */
function RunRow({
  run,
  open,
  segments,
  onToggle,
}: {
  run: WikiRun;
  open: boolean;
  segments: Segment[] | undefined;
  onToggle: () => void;
}) {
  const { Icon, className } = STATUS_META[runStatus(run.status)];
  return (
    <div>
      <ListRow
        active={open}
        onClick={onToggle}
        icon={<Icon className={cn("size-4", className)} />}
        label={run.name}
        meta={formatTime(run.created_at)}
      />
      {open && (
        <div className="mb-2 ml-6 border-l border-border pl-4">
          <Transcript run={run} segments={segments} />
        </div>
      )}
    </div>
  );
}

function Transcript({ run, segments }: { run: WikiRun; segments: Segment[] | undefined }) {
  if (segments === undefined) {
    return <p className="text-sm text-muted-foreground">Loading transcript…</p>;
  }
  if (segments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {run.status === "running" ? "Starting up…" : "No transcript was recorded for this run."}
      </p>
    );
  }
  const streaming = run.status === "running";
  return (
    <div className="flex flex-col gap-2.5 py-2">
      {segments.map((segment, index) => {
        if (segment.kind === "reasoning") {
          return (
            <Reasoning key={index} isStreaming={streaming && index === segments.length - 1}>
              <ReasoningTrigger />
              <ReasoningContent>{segment.text}</ReasoningContent>
            </Reasoning>
          );
        }
        if (segment.kind === "text") {
          return (
            <MessageResponse key={index} className="prose-meos text-[14px]">
              {segment.text}
            </MessageResponse>
          );
        }
        if (segment.kind === "tool-call") {
          return <ToolCall key={index} toolName={segment.toolName} payload={segment.payload} />;
        }
        if (segment.kind === "tool-result") {
          return <ToolResult key={index} payload={segment.payload} />;
        }
        return null;
      })}
    </div>
  );
}

/** Parse a wiki sandbox path ("person/ada.md") into a label + linkable wiki slug. */
function wikiSlugOf(path: string): string | null {
  const file = path.split("/").pop() ?? path;
  const slug = file.replace(/\.md$/i, "").trim();
  return slug || null;
}

function safeParse(payload: string): Record<string, unknown> {
  try {
    const value = JSON.parse(payload);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One IDE-style tool step: an icon, a verb, and the file/command it acted on. */
function ToolCall({ toolName, payload }: { toolName: string; payload: string }) {
  const input = safeParse(payload);
  let icon = <Terminal className="size-3.5 text-muted-foreground" />;
  let verb = toolName;
  let detail: React.ReactNode = null;

  if (toolName === "writeFile") {
    icon = <FilePenLine className="size-3.5 text-moss" />;
    verb = "Wrote";
    const path = String(input.path ?? "");
    const slug = wikiSlugOf(path);
    detail = slug ? (
      <Link to={`/wiki/${slug}`} className="font-mono underline-offset-2 hover:underline">
        {path}
      </Link>
    ) : (
      <span className="font-mono text-muted-foreground">{path}</span>
    );
  } else if (toolName === "readFile") {
    icon = <FileText className="size-3.5 text-muted-foreground" />;
    verb = "Read";
    detail = <span className="font-mono text-muted-foreground">{String(input.path ?? "")}</span>;
  } else if (toolName === "bash") {
    const command = String(input.command ?? "");
    const isSearch = /^\s*(grep|rg|find|ls)\b/.test(command);
    icon = isSearch ? (
      <Search className="size-3.5 text-muted-foreground" />
    ) : (
      <Terminal className="size-3.5 text-muted-foreground" />
    );
    verb = isSearch ? "Searched" : "Ran";
    detail = <span className="font-mono text-muted-foreground">{command}</span>;
  } else {
    detail = <span className="font-mono text-muted-foreground">{payload}</span>;
  }

  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="translate-y-[2px]">{icon}</span>
      <span className="text-muted-foreground">{verb}</span>
      <span className="min-w-0 flex-1 truncate">{detail}</span>
    </div>
  );
}

/** The (truncated) result of a tool call, kept muted so it doesn't dominate. */
function ToolResult({ payload }: { payload: string }) {
  const text = payload.trim();
  if (!text) return null;
  return (
    <pre className="max-h-24 overflow-hidden whitespace-pre-wrap rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
      {text}
    </pre>
  );
}
