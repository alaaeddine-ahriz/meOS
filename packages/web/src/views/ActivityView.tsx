import { ChevronRight, FilePenLine, FileText, Search, Sparkles, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Page, PageHeader } from "@/components/Page";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { MessageResponse } from "@/components/ai-elements/message";
import { ENTITY_TYPES } from "@/lib/entity-meta";
import { cn } from "@/lib/utils";
import {
  api,
  streamActivity,
  type ActivityEvent,
  type InboxItem,
  type LlmSettings,
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
 * (a "doc") and the maintainer rewriting a page in response (a "run"). Both are
 * sorted together by when they happened.
 */
type FeedItem = { kind: "run"; run: WikiRun } | { kind: "doc"; item: InboxItem };

/**
 * When a feed entry last had activity. For a document that's its updated_at, so
 * a file that changed and was re-read rises back to the top of the timeline
 * rather than staying frozen at its first-seen time.
 */
function feedTime(entry: FeedItem): number {
  return epochOf(entry.kind === "run" ? entry.run.created_at : entry.item.updated_at);
}

/** Plain-language word for what happened to a document, shown beside its name. */
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
      // A revision past the first means the file changed and was re-read.
      return item.revision > 1 ? "updated" : "ingested";
    case "failed":
      return "failed";
    case "unsupported":
      return "skipped";
    default:
      return item.status;
  }
}

const RUN_DOTS: Record<WikiRun["status"], string> = {
  running: "bg-lamp working-dot",
  done: "bg-moss",
  failed: "bg-ember",
};

const DOC_DOTS: Record<string, string> = {
  queued: "bg-dim",
  parsing: "bg-lamp working-dot",
  extracting: "bg-lamp working-dot",
  merging: "bg-lamp working-dot",
  done: "bg-moss",
  failed: "bg-ember",
  unsupported: "bg-dim",
};

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
  // Runs whose transcript we've already streamed live or fetched, so expanding
  // a historical run doesn't refetch and a live run isn't clobbered.
  const loaded = useRef<Set<number>>(new Set());
  const [maintainer, setMaintainer] = useState<LlmSettings["maintainer"] | null>(null);

  useEffect(() => {
    api
      .getActivity()
      .then((r) => setRuns(r.runs))
      .catch(() => {});
    api
      .getLlmSettings()
      .then((s) => setMaintainer(s.maintainer))
      .catch(() => {});
  }, []);

  // Subscribe to the live feed: new runs appear in place and animate as the
  // agent reasons, calls tools, and writes pages.
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
    // Lazy-load the transcript of a historical run the first time it's opened.
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

  // One timeline: documents arriving and the pages they prompt, newest first.
  // Memoised so transcript-only re-renders during a live run don't re-sort.
  const feed = useMemo<FeedItem[]>(
    () =>
      [
        ...runs.map<FeedItem>((run) => ({ kind: "run", run })),
        ...docs.map<FeedItem>((item) => ({ kind: "doc", item })),
      ].sort((a, b) => feedTime(b) - feedTime(a)),
    [runs, docs],
  );

  // Prompt for a reasoning model when none is configured — tool calls still
  // stream, but the agent's thinking won't without a reasoning-capable model.
  const needsReasoningModel = maintainer !== null && !maintainer.reasoning;

  const content = (
    <>
      {needsReasoningModel && (
        <div className="rise mt-6 rounded-lg border border-lamp-dim/40 bg-lamp/5 px-4 py-3 text-sm text-faded">
          <p className="flex items-center gap-2 text-paper">
            <Sparkles className="size-4 text-lamp" />
            {maintainer?.configured
              ? "Your maintainer model can't stream reasoning."
              : "Pick a reasoning-capable model to narrate wiki updates."}
          </p>
          <p className="mt-1 text-[13px] text-dim">
            Tool calls and edits still stream. To see the agent's thinking too, choose a Claude
            Opus/Sonnet, GPT-5/o-series, or Gemini 2.5/3 model.{" "}
            <Link
              to="/settings"
              className="font-medium underline underline-offset-2 hover:text-paper"
            >
              Open Settings → Model
            </Link>
          </p>
        </div>
      )}

      <section className="rise rise-1 mt-8">
        <ul className="flex flex-col gap-3">
          {feed.map((entry) =>
            entry.kind === "run" ? (
              <RunCard
                key={`run-${entry.run.id}`}
                run={entry.run}
                open={expanded.has(entry.run.id)}
                segments={transcripts.get(entry.run.id)}
                onToggle={() => void toggle(entry.run)}
              />
            ) : (
              <DocCard key={`doc-${entry.item.id}`} item={entry.item} />
            ),
          )}
          {feed.length === 0 && (
            <li className="py-6 text-sm text-dim">
              Nothing yet. Add{" "}
              <Link to="/settings" className="text-faded hover:text-paper">
                watched folders
              </Link>{" "}
              and MeOS starts reading — each document and the pages it rewrites show up here, live.
            </li>
          )}
        </ul>
      </section>
    </>
  );

  if (embedded) return content;
  return (
    <Page>
      <PageHeader
        title="Activity"
        description="Documents landing and the wiki maintainer rewriting pages in response — one live timeline."
      />
      {content}
    </Page>
  );
}

/** A document moving through the pipeline: a static row, linking to its diff once done. */
function DocCard({ item }: { item: InboxItem }) {
  const linkable = item.status === "done" && item.source_id != null;
  const inner = (
    <>
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOC_DOTS[item.status] ?? "bg-dim")}
        title={item.status}
      />
      <FileText className="size-4 shrink-0 text-dim" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-paper">{item.title}</span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-dim">
          {docLabel(item)}
          {item.detail ? ` · ${item.detail}` : ""}
        </span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-dim">{formatTime(item.updated_at)}</span>
    </>
  );
  return (
    <li
      className={cn(
        "overflow-hidden rounded-xl border border-line bg-desk",
        item.status === "unsupported" && "opacity-50",
      )}
    >
      {linkable ? (
        <Link
          to={`/changes/${item.source_id}`}
          className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-card/40"
        >
          {inner}
          <ChevronRight className="size-4 shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100" />
        </Link>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3">{inner}</div>
      )}
    </li>
  );
}

function RunCard({
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
  const Icon = ENTITY_TYPES[run.type]?.icon ?? FileText;
  return (
    <li className="overflow-hidden rounded-xl border border-line bg-desk">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-card/40"
      >
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", RUN_DOTS[run.status])}
          title={run.status}
        />
        <Icon className="size-4 shrink-0 text-lamp" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-paper">{run.name}</span>
          <span className="font-mono text-[11px] uppercase tracking-wider text-dim">
            {run.type}
            {run.status === "running" && " · working…"}
            {run.status === "failed" && " · failed"}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-dim">
          {formatTime(run.created_at)}
        </span>
        <ChevronRight
          className={cn("size-4 shrink-0 text-dim transition-transform", open && "rotate-90")}
        />
      </button>

      {open && (
        <div className="border-t border-line px-4 py-3">
          <Transcript run={run} segments={segments} />
        </div>
      )}
    </li>
  );
}

function Transcript({ run, segments }: { run: WikiRun; segments: Segment[] | undefined }) {
  if (segments === undefined) {
    return <p className="text-sm text-dim">Loading transcript…</p>;
  }
  if (segments.length === 0) {
    return (
      <p className="text-sm text-dim">
        {run.status === "running" ? "Starting up…" : "No transcript was recorded for this run."}
      </p>
    );
  }
  const streaming = run.status === "running";
  return (
    <div className="flex flex-col gap-2.5">
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
  let icon = <Terminal className="size-3.5 text-dim" />;
  let verb = toolName;
  let detail: React.ReactNode = null;

  if (toolName === "writeFile") {
    icon = <FilePenLine className="size-3.5 text-moss" />;
    verb = "Wrote";
    const path = String(input.path ?? "");
    const slug = wikiSlugOf(path);
    detail = slug ? (
      <Link
        to={`/wiki/${slug}`}
        className="font-mono text-paper underline-offset-2 hover:underline"
      >
        {path}
      </Link>
    ) : (
      <span className="font-mono text-faded">{path}</span>
    );
  } else if (toolName === "readFile") {
    icon = <FileText className="size-3.5 text-dim" />;
    verb = "Read";
    detail = <span className="font-mono text-faded">{String(input.path ?? "")}</span>;
  } else if (toolName === "bash") {
    const command = String(input.command ?? "");
    const isSearch = /^\s*(grep|rg|find|ls)\b/.test(command);
    icon = isSearch ? (
      <Search className="size-3.5 text-dim" />
    ) : (
      <Terminal className="size-3.5 text-dim" />
    );
    verb = isSearch ? "Searched" : "Ran";
    detail = <span className="font-mono text-faded">{command}</span>;
  } else {
    detail = <span className="font-mono text-faded">{payload}</span>;
  }

  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="translate-y-[2px]">{icon}</span>
      <span className="text-dim">{verb}</span>
      <span className="min-w-0 flex-1 truncate">{detail}</span>
    </div>
  );
}

/** The (truncated) result of a tool call, kept muted so it doesn't dominate. */
function ToolResult({ payload }: { payload: string }) {
  const text = payload.trim();
  if (!text) return null;
  return (
    <pre className="ml-5 max-h-24 overflow-hidden whitespace-pre-wrap rounded-md border border-line bg-card/40 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-dim">
      {text}
    </pre>
  );
}
