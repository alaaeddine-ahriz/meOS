/**
 * One shared vocabulary for the ingest pipeline, so every surface that talks
 * about "what's happening" and "where it broke" — the Activity feed and the
 * Health view — uses the same plain-language labels and never drifts.
 *
 * The backend describes the world with three small enums: the pipeline step a
 * job is on (reading | indexing | extracting | merging), the durable job state
 * (pending | processing | completed | failed | dead-letter), and a worker's
 * status (idle | running | stopped | error). Everything below maps those raw
 * tokens to words a person can read, plus a one-line tooltip blurb.
 */

/** Plain-language name + tooltip for a pipeline step / durable-job stage. */
export const STEP_LABELS: Record<string, { label: string; blurb: string }> = {
  queued: { label: "Queued", blurb: "Waiting in line to be processed." },
  reading: { label: "Reading the file", blurb: "Opening the file and pulling out its text." },
  parsing: { label: "Reading the file", blurb: "Opening the file and pulling out its text." },
  indexing: {
    label: "Indexing for search",
    blurb: "Splitting the text into chunks and embedding them so it's searchable.",
  },
  embedding: {
    label: "Building the search index",
    blurb: "Turning text into vectors so search can find it.",
  },
  extracting: {
    label: "Extracting facts",
    blurb: "Reading the content with the LLM to pull out people, facts and claims.",
  },
  extraction: {
    label: "Extracting facts",
    blurb: "Reading the content with the LLM to pull out people, facts and claims.",
  },
  merging: {
    label: "Merging into memory",
    blurb: "Reconciling the new facts against what meOS already knows.",
  },
  merge: {
    label: "Merging into memory",
    blurb: "Reconciling the new facts against what meOS already knows.",
  },
};

/** Friendly label + tooltip for a pipeline stage, falling back to the raw token. */
export function stepLabel(stage: string): { label: string; blurb: string } {
  return STEP_LABELS[stage?.toLowerCase()] ?? { label: stage || "Processing", blurb: "" };
}

// The pipeline tags an error with the step it broke at, formatted as
// "while <step>: <message>" (see stepDetail in core/ingest/pipeline.ts).
const STEP_PATTERN = /while\s+(reading|indexing|extracting|merging)\s*:\s*/i;

/**
 * Recover the failing step and a clean message from an ingest error/detail
 * string. When the pipeline didn't tag a step, `step` is null and the whole
 * string is returned as the message.
 */
export function parseFailure(raw: string | null | undefined): {
  step: string | null;
  message: string;
} {
  const text = (raw ?? "").trim();
  const match = text.match(STEP_PATTERN);
  if (match && match[1] && match.index !== undefined) {
    const message = text.slice(match.index + match[0].length).trim();
    return { step: match[1].toLowerCase(), message: message || text };
  }
  return { step: null, message: text };
}

/** Plain-language name + tooltip for each background worker. */
export const WORKER_LABELS: Record<string, { label: string; blurb: string }> = {
  watcher: {
    label: "Watching your folders",
    blurb: "Notices when files in your watched folders change and queues them to read.",
  },
  connectors: {
    label: "Syncing connected services",
    blurb: "Pulls in contacts, calendar, email and tasks from your connected accounts.",
  },
  scheduler: {
    label: "Scheduled upkeep",
    blurb: "Runs periodic maintenance like consolidation and cleanup.",
  },
  ingest: {
    label: "Reading & understanding files",
    blurb: "Extracts facts from queued documents and merges them into memory.",
  },
  embedding: {
    label: "Building the search index",
    blurb: "Turns text into vectors so search can find it.",
  },
  wiki: {
    label: "Writing wiki pages",
    blurb: "Rewrites wiki pages as new facts arrive.",
  },
};

/** Friendly label + tooltip for a worker, falling back to its raw name. */
export function workerLabel(name: string): { label: string; blurb: string } {
  return WORKER_LABELS[name] ?? { label: name, blurb: "" };
}

/** Status dot colour per worker status. */
export const WORKER_DOTS: Record<string, string> = {
  idle: "bg-dim",
  running: "bg-lamp working-dot",
  stopped: "bg-dim",
  error: "bg-ember",
};

/** Status dot colour per durable-job state. */
export const JOB_DOTS: Record<string, string> = {
  pending: "bg-dim",
  processing: "bg-lamp working-dot",
  completed: "bg-lamp",
  failed: "bg-ember",
  "dead-letter": "bg-ember",
};

export type EngineStatus = "healthy" | "working" | "paused" | "problem";

/** The visual + wording for the single "Background engine" verdict. */
export const ENGINE_META: Record<
  EngineStatus,
  { label: string; blurb: string; dot: string; tone: string }
> = {
  healthy: {
    label: "Healthy",
    blurb: "All background work is up to date.",
    dot: "bg-emerald-500",
    tone: "text-emerald-500",
  },
  working: {
    label: "Working",
    blurb: "meOS is processing items in the background.",
    dot: "bg-lamp working-dot",
    tone: "text-lamp",
  },
  paused: {
    label: "Paused",
    blurb: "Background processing is paused — nothing new will be read until you resume.",
    dot: "bg-amber-500",
    tone: "text-amber-500",
  },
  problem: {
    label: "Problem",
    blurb: "A background worker reported an error.",
    dot: "bg-ember",
    tone: "text-ember",
  },
};

/**
 * Collapse the raw worker list + paused flag into one plain-language verdict.
 * A worker reporting `error` (including the forked worker process going silent,
 * which the runtime route pre-maps to `error`) wins; then paused; then any work
 * in flight; otherwise healthy.
 */
export function engineStatus(
  workers: ReadonlyArray<{ status: string; lastError: string | null }>,
  paused: boolean,
  running: number,
): { status: EngineStatus; detail: string | null } {
  const errored = workers.find((w) => w.status === "error");
  if (errored) return { status: "problem", detail: errored.lastError };
  if (paused) return { status: "paused", detail: null };
  if (running > 0 || workers.some((w) => w.status === "running"))
    return { status: "working", detail: null };
  return { status: "healthy", detail: null };
}
