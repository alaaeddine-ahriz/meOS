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
