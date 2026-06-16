/**
 * A tiny, dependency-free YAML front-matter reader/writer for vault notes. We
 * only ever store a fixed, flat shape (scalars + a string list), so a full YAML
 * parser would be overkill — this mirrors the hand-rolled `stripFrontmatter` in
 * core's wiki writer. Anything it can't parse degrades to "no front matter", so
 * a hand-edited note never throws.
 *
 * A meeting authored in the editor maps these fields to the meetings API instead
 * of writing YAML; this module is the on-disk format for plain vault notes.
 */

/** A referenced calendar event, kept flat on disk as `event_id` / `event_title`. */
export interface EventRef {
  id: string;
  title: string;
}

/** The structured properties a note can carry above its body. */
export interface NoteFrontmatter {
  /** A plain note, or a meeting (which rides the extraction pipeline). */
  type?: "note" | "meeting";
  /** ISO date (YYYY-MM-DD) — the meeting date, or a note's own date. */
  date?: string;
  /** Attendee names (meetings). */
  attendees?: string[];
  /** A referenced calendar event. */
  event?: EventRef;
}

/**
 * True when the note carries meaningful properties — drives whether the panel
 * shows and whether a YAML block is written. A bare `type: note` is the default
 * and doesn't count, so plain notes stay free of front matter on disk.
 */
export function hasProperties(data: NoteFrontmatter): boolean {
  return Boolean(
    data.type === "meeting" ||
    data.date ||
    (data.attendees && data.attendees.length > 0) ||
    data.event?.id,
  );
}

const BLOCK_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a note's leading `--- … ---` block from its body, tolerant of garbage. */
export function parseFrontmatter(markdown: string): { data: NoteFrontmatter; body: string } {
  const match = BLOCK_RE.exec(markdown);
  if (!match) return { data: {}, body: markdown };
  const raw = parseFlatYaml(match[1] ?? "");
  const body = markdown.slice(match[0].length);
  const data: NoteFrontmatter = {};
  if (raw.type === "meeting" || raw.type === "note") data.type = raw.type;
  if (typeof raw.date === "string" && raw.date) data.date = raw.date;
  if (Array.isArray(raw.attendees)) data.attendees = raw.attendees;
  const eventId = typeof raw.event_id === "string" ? raw.event_id : "";
  const eventTitle = typeof raw.event_title === "string" ? raw.event_title : "";
  if (eventId || eventTitle) data.event = { id: eventId, title: eventTitle };
  return { data, body };
}

/** Re-emit `data` as a YAML block prepended to `body`; omits the block if empty. */
export function serializeFrontmatter(data: NoteFrontmatter, body: string): string {
  const lines: string[] = [];
  if (data.type) lines.push(`type: ${data.type}`);
  if (data.date) lines.push(`date: ${data.date}`);
  if (data.event?.id) lines.push(`event_id: ${quote(data.event.id)}`);
  if (data.event?.title) lines.push(`event_title: ${quote(data.event.title)}`);
  if (data.attendees && data.attendees.length > 0) {
    lines.push("attendees:");
    for (const name of data.attendees) lines.push(`  - ${quote(name)}`);
  }
  if (lines.length === 0) return body;
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\s*\n/, "")}`;
}

/** Parse a flat YAML block: `key: scalar` plus `key:` followed by `- item` lists. */
function parseFlatYaml(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i++;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, valuePart] = m;
    if (valuePart === "") {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i] ?? "")) {
        items.push(unquote((lines[i] ?? "").replace(/^\s*-\s+/, "").trim()));
        i++;
      }
      out[key!] = items;
    } else {
      out[key!] = unquote(valuePart!.trim());
    }
  }
  return out;
}

/** Strip a single layer of matching single/double quotes, if present. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}

/** Double-quote a value when it could confuse the line parser; escape inner quotes. */
function quote(value: string): string {
  if (value === "" || /[:#"']/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}
