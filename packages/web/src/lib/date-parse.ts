/**
 * Natural-language date parsing for the `@`-mention picker and the meeting date
 * field. Recognises `today` / `yesterday` / `tomorrow`, weekday names (with an
 * optional `last` / `next`), and explicit `dd/mm/yyyy`, `dd-mm-yyyy`, `dd.mm.yyyy`
 * or ISO `yyyy-mm-dd`. Day-first (European) ordering, matching how the user
 * writes `10/06/2026`. Returns a normalized ISO date plus a friendly label, or
 * null when the text isn't a date — so the caller can fall back to other hits.
 *
 * Pure and timezone-free (local calendar dates); `now` is injectable for tests.
 */

export interface ParsedDate {
  /** Normalized YYYY-MM-DD. */
  iso: string;
  /** A human label for the menu, e.g. "Today" or "Mon, 10 Jun 2026". */
  label: string;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format a Date as a local YYYY-MM-DD (no UTC shift). */
function toISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A readable label for an explicit date, e.g. "Wed, 10 Jun 2026". */
function isoLabel(date: Date): string {
  return `${WEEKDAYS[date.getDay()]!.slice(0, 3).replace(/^./, (c) => c.toUpperCase())}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function valid(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function parseDateQuery(query: string, now: Date = new Date()): ParsedDate | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (q === "today") return { iso: toISO(today), label: "Today" };
  if (q === "yesterday") return { iso: toISO(addDays(today, -1)), label: "Yesterday" };
  if (q === "tomorrow") return { iso: toISO(addDays(today, 1)), label: "Tomorrow" };

  // [last|next] <weekday>, or a bare weekday (= the upcoming one).
  const weekday = /^(?:(last|next)\s+)?(\w+)$/.exec(q);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[2] as (typeof WEEKDAYS)[number]);
    if (target >= 0) {
      const direction = weekday[1] ?? "next";
      const diff = (target - today.getDay() + 7) % 7 || 7; // strictly forward
      const date = direction === "last" ? addDays(today, diff - 7) : addDays(today, diff);
      return { iso: toISO(date), label: isoLabel(date) };
    }
  }

  // ISO yyyy-mm-dd (year first).
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q);
  if (iso) {
    const date = valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return date ? { iso: toISO(date), label: isoLabel(date) } : null;
  }

  // dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy (day first; 2-digit year → 2000s).
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(q);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    const date = valid(year, Number(dmy[2]), Number(dmy[1]));
    return date ? { iso: toISO(date), label: isoLabel(date) } : null;
  }

  return null;
}
