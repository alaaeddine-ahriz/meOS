/**
 * Temporal policy — the one place "how does time bear on a claim" lives, the
 * recency counterpart to confidence.ts. Two gist ideas converge here:
 *
 *   - rohitg00's kind-aware forgetting curve ("architecture decisions decay
 *     slowly; transient bugs decay fast") — STALE_AFTER_DAYS per kind drives
 *     both confidence decay (retention) and the staleness flag (retrieval/lint).
 *   - the answer-time need to judge whether a fact is still *pertinent*: every
 *     fact carries its date, and one gone unconfirmed past its kind's horizon is
 *     marked stale so the model hedges instead of asserting an old claim.
 *
 * Time is stored everywhere in the schema; this module is where it becomes a
 * signal the rest of the system can act on.
 */

const DAY_MS = 86_400_000;

/** Horizon (days) a claim of each kind stays "fresh" before it wants reconfirming. */
export const STALE_AFTER_DAYS: Record<string, number> = {
  // fast-moving: today's task, this week's event, a live risk or open question
  task: 21,
  event: 30,
  risk: 45,
  open_question: 45,
  // medium: a plain fact about the world
  fact: 120,
  // slow-moving: the things that define a project's shape and rarely flip
  requirement: 180,
  preference: 240,
  procedure: 365,
  decision: 365,
};

/** Fallback horizon for unknown/legacy kinds. */
export const DEFAULT_STALE_AFTER_DAYS = 120;

export function staleAfterDays(kind: string | undefined): number {
  if (!kind) return DEFAULT_STALE_AFTER_DAYS;
  return STALE_AFTER_DAYS[kind] ?? DEFAULT_STALE_AFTER_DAYS;
}

/** The minimal temporal shape a claim exposes — a subset of ObservationRow. */
export interface TemporalClaim {
  kind: string;
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
  last_confirmed_at: string;
}

/** Days between an ISO instant and `asOf` (never negative; 0 for bad dates). */
export function ageInDays(iso: string, asOf: Date = new Date()): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (asOf.getTime() - t) / DAY_MS);
}

/** When the claim became / becomes true: its stated validity, else when we logged it. */
export function effectiveDateOf(o: Pick<TemporalClaim, "valid_from" | "created_at">): string {
  return o.valid_from ?? o.created_at;
}

/** True when valid_from is set and still in the future — the claim isn't in force yet. */
export function isUpcoming(o: Pick<TemporalClaim, "valid_from">, asOf: Date = new Date()): boolean {
  return !!o.valid_from && Date.parse(o.valid_from) > asOf.getTime();
}

/**
 * Has this claim gone unconfirmed past its kind's horizon? Reconfirmation
 * refreshes last_confirmed_at, so a fact that keeps recurring never goes stale.
 * Upcoming claims are never stale — they aren't yet meant to be true.
 */
export function isStale(o: TemporalClaim, asOf: Date = new Date()): boolean {
  if (isUpcoming(o, asOf)) return false;
  return ageInDays(o.last_confirmed_at, asOf) > staleAfterDays(o.kind);
}

/** Compact, human/LLM-readable age: "today", "9d", "6w", "14mo", "2.1y". */
export function formatAge(days: number): string {
  if (days < 1) return "today";
  if (days < 14) return `${Math.round(days)}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  if (days < 730) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/**
 * The temporal segment shown inside a fact's annotation at answer time, so the
 * model can weigh pertinence: the effective date, plus an explicit "stale" or
 * "upcoming" / "until" marker when those apply. Examples:
 *   2024-03-15
 *   2023-01-10 · 17mo stale
 *   from 2026-09-01 · upcoming
 *   2025-01-01 · until 2026-12-31
 */
export function temporalTag(o: TemporalClaim, asOf: Date = new Date()): string {
  if (isUpcoming(o, asOf)) {
    return `from ${o.valid_from!.slice(0, 10)} · upcoming`;
  }
  const parts = [effectiveDateOf(o).slice(0, 10)];
  if (isStale(o, asOf)) {
    parts.push(`${formatAge(ageInDays(o.last_confirmed_at, asOf))} stale`);
  }
  if (o.valid_until && Date.parse(o.valid_until) > asOf.getTime()) {
    parts.push(`until ${o.valid_until.slice(0, 10)}`);
  }
  return parts.join(" · ");
}
