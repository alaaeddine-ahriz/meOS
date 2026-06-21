/**
 * Persisted SQLite timestamps are UTC without a zone ("2026-06-14 11:45:01");
 * live values are already full ISO ("…T…Z"). Normalise both to a Date — the
 * single place that knows how the backend serialises time.
 */
export function utcDate(iso: string): Date {
  const normalized = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  return new Date(normalized);
}

/** Epoch milliseconds for a backend timestamp, for sorting. */
export function epochOf(iso: string): number {
  return utcDate(iso).getTime();
}

/** Short clock time, e.g. "2:14 PM". */
export function formatTime(iso: string): string {
  return utcDate(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * A compact "time ago" — "just now", "5 min ago", "3 hr ago", "2 days ago" — so
 * a failure from minutes ago and one from days ago don't look identical (which
 * plain clock time can't convey). Falls back to an absolute date past a week.
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const date = utcDate(iso);
  const then = date.getTime();
  if (!Number.isFinite(then)) return "";
  const sec = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Clock time, plus the date when it isn't today, e.g. "Jun 14, 2:14 PM". */
export function formatDateTime(iso: string, now: Date = new Date()): string {
  const d = utcDate(iso);
  const time = formatTime(iso);
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
