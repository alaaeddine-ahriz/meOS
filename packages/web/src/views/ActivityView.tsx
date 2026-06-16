import { FilePenLine, FileText, Search, Sparkles, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ListRow } from "@/components/list";
import { Page, PageBody, PageHeader } from "@/components/Page";
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

// The leading icon's colour conveys status at a glance.
const RUN_COLOR: Record<WikiRun["status"], string> = {
  running: "text-primary",
  done: "text-moss",
  failed: "text-destructive",
};
const DOC_COLOR: Record<string, string> = {
  queued: "text-muted-foreground",
  parsing: "text-primary",
  extracting: "text-primary",
  merging: "text-primary",
  done: "text-moss",
  failed: "text-destructive",
  "extract-failed": "text-destructive",
  unsupported: "text-muted-foreground",
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

  const needsReasoningModel = maintainer !== null && !maintainer.reasoning;

  const content = (
    <>
      {needsReasoningModel && (
        <div className="mb-5 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <p className="flex items-center gap-2 text-foreground">
            <Sparkles className="size-4" />
            {maintainer?.configured
              ? "Your maintainer model can't stream reasoning."
              : "Pick a reasoning-capable model to narrate wiki updates."}
          </p>
          <p className="mt-1">
            Tool calls and edits still stream. To see the agent's thinking too, choose a Claude
            Opus/Sonnet, GPT-5/o-series, or Gemini 2.5/3 model.{" "}
            <Link
              to="/settings"
              className="font-medium text-foreground underline underline-offset-2"
            >
              Open Settings → Model
            </Link>
          </p>
        </div>
      )}

      {feed.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet. Add{" "}
          <Link to="/settings" className="underline underline-offset-2">
            watched folders
          </Link>{" "}
          and MeOS starts reading — each document and the pages it rewrites show up here.
        </p>
      ) : (
        feed.map((entry) =>
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

/** A document in the feed: links to its diff once done. */
function DocRow({ item }: { item: InboxItem }) {
  const linkable = item.status === "done" && item.source_id != null;
  return (
    <ListRow
      to={linkable ? `/changes/${item.source_id}` : undefined}
      title={docLabel(item)}
      icon={
        <FileText className={cn("size-4", DOC_COLOR[item.status] ?? "text-muted-foreground")} />
      }
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
  const Icon = ENTITY_TYPES[run.type]?.icon ?? FileText;
  return (
    <div>
      <ListRow
        active={open}
        onClick={onToggle}
        icon={<Icon className={cn("size-4", RUN_COLOR[run.status])} />}
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
