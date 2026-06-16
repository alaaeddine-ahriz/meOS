import { CalendarDays, FileText, Link2, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { FollowTarget, LinkTarget } from "@/lib/tiptap/mention";
import {
  hasProperties,
  parseFrontmatter,
  serializeFrontmatter,
  type NoteFrontmatter,
} from "@/lib/frontmatter";
import { parseDateQuery } from "@/lib/date-parse";
import { SimpleEditor } from "@/components/tiptap-templates/simple/simple-editor";
import { NoteProperties } from "@/components/NoteProperties";
import { MeetingProcessedPanel } from "@/components/MeetingProcessedPanel";
import {
  api,
  type CalendarEvent,
  type EntitySummary,
  type MeetingDetail,
  type MeetingLink,
  type MeetingSummary,
  type NoteMeta,
} from "../api.js";

type ItemKind = "note" | "meeting";
interface Selected {
  kind: ItemKind;
  /** Note path, or the meeting's source id (as a string). */
  id: string;
}

/** One row in the unified list (a vault note or a meeting). */
interface ListRow {
  kind: ItemKind;
  id: string;
  title: string;
  subtitle?: string;
}

type KindFilter = "all" | "note" | "meeting";

/** Turn a free-typed title into a safe `<name>.md` vault path. */
function toNotePath(title: string): string {
  const safe = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${safe || "Untitled"}.md`;
}

/** Filename (no extension) of a vault path, used to match `[[links]]`. */
function baseName(path: string): string {
  return path.replace(/\.md$/i, "").split("/").pop() ?? path;
}

/** Today as a local YYYY-MM-DD. */
function todayISO(): string {
  return parseDateQuery("today")!.iso;
}

/**
 * Strip the composed meeting header ("# Title", "**Date:**", "**Attendees:**")
 * the server prepends, leaving the user's body for the editor. Mirrors the
 * server's `bodyWithoutHeader`, so editing round-trips without stacking headers.
 */
function stripMeetingHeader(content: string): string {
  const lines = content.split("\n");
  let i = 0;
  if (lines[i]?.startsWith("# ")) i++;
  while (
    i < lines.length &&
    (lines[i]?.trim() === "" ||
      lines[i]?.startsWith("**Date:**") ||
      lines[i]?.startsWith("**Attendees:**"))
  ) {
    i++;
  }
  return lines.slice(i).join("\n").trim();
}

/** Serialize a vault note for disk, omitting a redundant `type: note` block. */
function serializeForDisk(fm: NoteFrontmatter, body: string): string {
  return serializeFrontmatter(hasProperties(fm) ? fm : {}, body);
}

/** The list subtitle for a meeting: its date and attendee count. */
function meetingSubtitle(m: MeetingSummary): string {
  const count = m.attendees.length;
  return `${m.date || "no date"}${count > 0 ? ` · ${count} attendee${count > 1 ? "s" : ""}` : ""}`;
}

function itemParam(sel: Selected): string {
  return `${sel.kind}:${sel.id}`;
}

function parseItemParam(params: URLSearchParams): Selected | null {
  const item = params.get("item");
  if (item) {
    const idx = item.indexOf(":");
    if (idx > 0) {
      const kind = item.slice(0, idx);
      const id = item.slice(idx + 1);
      if (kind === "note" || kind === "meeting") return { kind, id };
    }
  }
  // Legacy `?note=<path>` links still resolve.
  const legacy = params.get("note");
  if (legacy) return { kind: "note", id: legacy };
  return null;
}

export function VaultView() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const sel = useMemo(() => parseItemParam(params), [params]);

  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);

  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>(() => {
    const f = params.get("filter");
    return f === "note" || f === "meeting" ? f : "all";
  });
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  // The currently open item's editable state. Refs mirror state so the debounced
  // flush and the editor callbacks read the latest without re-creating closures.
  const [frontmatter, setFrontmatter] = useState<NoteFrontmatter>({});
  const [body, setBody] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [backlinks, setBacklinks] = useState<NoteMeta[]>([]);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const frontmatterRef = useRef<NoteFrontmatter>({});
  const bodyRef = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshNotes = useCallback(() => api.listNotes().then((r) => setNotes(r.notes)), []);
  const refreshMeetings = useCallback(
    () => api.listMeetings().then((r) => setMeetings(r.meetings)),
    [],
  );

  useEffect(() => {
    refreshNotes();
    refreshMeetings();
    api
      .listEntities()
      .then((r) => setEntities(r.entities))
      .catch(() => {});
    api
      .listCalendarEvents()
      .then((r) => setEvents(r.events))
      .catch(() => {});
  }, [refreshNotes, refreshMeetings]);

  const resetEditor = useCallback(() => {
    frontmatterRef.current = {};
    bodyRef.current = "";
    setFrontmatter({});
    setBody("");
    setNoteTitle("");
    setMeetingTitle("");
    setBacklinks([]);
    setDetail(null);
    setLoadedKey(null);
    setSaved("idle");
    setDirty(false);
  }, []);

  // Load the selected item — a vault note (markdown + front matter) or a meeting
  // (structured fields + body), keyed so the editor remounts on every switch.
  useEffect(() => {
    if (!sel) {
      resetEditor();
      return;
    }
    let live = true;
    setError(null);
    const key = itemParam(sel);
    if (sel.kind === "note") {
      api
        .getNote(sel.id)
        .then((n) => {
          if (!live) return;
          const { data, body: noteBody } = parseFrontmatter(n.markdown);
          frontmatterRef.current = data;
          bodyRef.current = noteBody;
          setFrontmatter(data);
          setBody(noteBody);
          setNoteTitle(n.title);
          setBacklinks(n.backlinks);
          setDetail(null);
          setSaved("idle");
          setDirty(false);
          setLoadedKey(key);
        })
        .catch(() => live && resetEditor());
    } else {
      api
        .getMeeting(Number(sel.id))
        .then((d) => {
          if (!live) return;
          const fm: NoteFrontmatter = {
            type: "meeting",
            date: d.date ?? undefined,
            attendees: d.attendees,
          };
          const meetingBody = stripMeetingHeader(d.content);
          frontmatterRef.current = fm;
          bodyRef.current = meetingBody;
          setFrontmatter(fm);
          setBody(meetingBody);
          setMeetingTitle(d.title);
          setDetail(d);
          setBacklinks([]);
          setDirty(false);
          setLoadedKey(key);
        })
        .catch((e) => live && setError(String(e)));
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.kind, sel?.id]);

  // --- vault autosave (notes only; meetings save explicitly) ----------------
  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!sel || sel.kind !== "note") return;
    const markdown = serializeForDisk(frontmatterRef.current, bodyRef.current);
    setSaved("saving");
    await api.saveNote(sel.id, markdown).catch(() => {});
    setSaved("saved");
    refreshNotes();
  }, [sel, refreshNotes]);

  const scheduleSave = useCallback(() => {
    if (!sel || sel.kind !== "note") return;
    setSaved("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 700);
  }, [sel, flush]);

  const open = useCallback(
    async (next: Selected) => {
      await flush();
      setParams({ item: itemParam(next) });
    },
    [flush, setParams],
  );

  const onBodyChange = useCallback(
    (markdown: string) => {
      bodyRef.current = markdown;
      if (sel?.kind === "meeting") setDirty(true);
      else scheduleSave();
    },
    [sel, scheduleSave],
  );

  const onPropsChange = useCallback(
    (next: NoteFrontmatter) => {
      frontmatterRef.current = next;
      setFrontmatter(next);
      if (sel?.kind === "meeting") setDirty(true);
      else scheduleSave();
    },
    [sel, scheduleSave],
  );

  // `/meeting` drops the meeting template: flip the note to a meeting with today's
  // date, then persist the draft (it stays a vault note until "Save & extract").
  // (SimpleEditor holds these callbacks in refs, so their changing identity here
  // never forces the editor to recreate.)
  const applyMeetingTemplate = useCallback(() => {
    const fm = frontmatterRef.current;
    onPropsChange({
      ...fm,
      type: "meeting",
      date: fm.date ?? todayISO(),
      attendees: fm.attendees ?? [],
    });
  }, [onPropsChange]);

  // An `@`-mentioned date or event populates the open meeting's front matter.
  const onMentionInsert = useCallback(
    (item: LinkTarget) => {
      const fm = frontmatterRef.current;
      if (fm.type !== "meeting") return;
      if (item.type === "date") {
        if (!fm.date) onPropsChange({ ...fm, date: item.target });
      } else if (item.type === "event") {
        const next: NoteFrontmatter = { ...fm, event: { id: item.target, title: item.label } };
        if (item.meta?.date && !fm.date) next.date = item.meta.date;
        if (item.meta?.attendees?.length) {
          next.attendees = [...new Set([...(fm.attendees ?? []), ...item.meta.attendees])];
        }
        onPropsChange(next);
      }
    },
    [onPropsChange],
  );

  // --- meeting save / extract ----------------------------------------------
  const saveExtract = useCallback(async () => {
    if (!sel) return;
    setBusy(true);
    setError(null);
    try {
      const fm = frontmatterRef.current;
      const payload = {
        date: fm.date ?? null,
        attendees: fm.attendees ?? [],
        content: bodyRef.current,
      };
      if (sel.kind === "meeting") {
        const d = await api.updateMeeting(Number(sel.id), {
          title: meetingTitle.trim() || "Untitled meeting",
          ...payload,
        });
        setDetail(d);
        setDirty(false);
        await refreshMeetings();
      } else {
        // Converting a vault note → a meeting: create it, drop the placeholder note.
        const d = await api.createMeeting({
          title: noteTitle.trim() || "Untitled meeting",
          ...payload,
        });
        await api.deleteNote(sel.id).catch(() => {});
        await Promise.all([refreshNotes(), refreshMeetings()]);
        setParams({ item: itemParam({ kind: "meeting", id: String(d.sourceId) }) });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [sel, meetingTitle, noteTitle, refreshMeetings, refreshNotes, setParams]);

  const reprocess = useCallback(async () => {
    if (sel?.kind !== "meeting") return;
    setBusy(true);
    setError(null);
    try {
      await api.reprocessMeeting(Number(sel.id));
      setDetail(await api.getMeeting(Number(sel.id)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [sel]);

  const reviewLink = useCallback(
    async (link: MeetingLink, status: "accepted" | "rejected") => {
      if (sel?.kind !== "meeting") return;
      await api.reviewMeetingLink(Number(sel.id), link.id, status);
      setDetail(await api.getMeeting(Number(sel.id)));
    },
    [sel],
  );

  const createNote = useCallback(
    async (title: string) => {
      const path = toNotePath(title);
      await api.createNote(path).catch(() => {});
      await refreshNotes();
      setCreating(false);
      setNewTitle("");
      open({ kind: "note", id: path });
    },
    [open, refreshNotes],
  );

  const remove = useCallback(async () => {
    if (sel?.kind !== "note") return;
    if (!confirm(`Delete "${noteTitle || sel.id}"? This cannot be undone.`)) return;
    await flush();
    await api.deleteNote(sel.id).catch(() => {});
    setParams({});
    refreshNotes();
  }, [sel, noteTitle, flush, setParams, refreshNotes]);

  // --- `@` autocomplete -----------------------------------------------------
  const suggest = useCallback(
    (query: string): LinkTarget[] => {
      const q = query.trim().toLowerCase();
      const hits: LinkTarget[] = [];
      // A date the query parses to (today / yesterday / 10/06/2026 / …).
      const date = parseDateQuery(query);
      if (date)
        hits.push({ label: date.iso, type: "date", target: date.iso, meta: { date: date.iso } });
      // Notes + wiki entities.
      notes
        .filter((n) => !q || n.title.toLowerCase().includes(q))
        .slice(0, 5)
        .forEach((n) => hits.push({ label: n.title, type: "note", target: n.path }));
      entities
        .filter((e) => !q || e.name.toLowerCase().includes(q))
        .slice(0, 5)
        .forEach((e) => hits.push({ label: e.name, type: "wiki", target: e.slug }));
      // Synced calendar events.
      events
        .filter((e) => !q || e.title.toLowerCase().includes(q))
        .slice(0, 5)
        .forEach((e) =>
          hits.push({
            label: e.title,
            type: "event",
            target: e.htmlLink,
            meta: { date: e.start ? e.start.slice(0, 10) : undefined, attendees: e.attendees },
          }),
        );
      // Offer to mint a new note when nothing matches exactly (and it isn't a date).
      const exact = hits.some((h) => h.label.toLowerCase() === q);
      if (query.trim() && !exact && !date) {
        hits.push({ label: query.trim(), type: "note", target: "" });
      }
      return hits;
    },
    [notes, entities, events],
  );

  const follow = useCallback(
    (t: FollowTarget) => {
      if (t.kind === "date") return; // dates don't navigate
      if (t.kind === "event") {
        if (t.target) window.open(t.target, "_blank", "noopener,noreferrer");
        return;
      }
      if (t.kind === "note" && t.target) return void open({ kind: "note", id: t.target });
      if (t.kind === "wiki" && t.target) return navigate(`/wiki/${t.target}`);
      const lower = t.label.trim().toLowerCase();
      const noteHit = notes.find(
        (n) => n.title.toLowerCase() === lower || baseName(n.path).toLowerCase() === lower,
      );
      if (noteHit) return void open({ kind: "note", id: noteHit.path });
      const wikiHit = entities.find((e) => e.name.toLowerCase() === lower);
      if (wikiHit) return navigate(`/wiki/${wikiHit.slug}`);
      void createNote(t.label);
    },
    [notes, entities, open, navigate, createNote],
  );

  // --- list -----------------------------------------------------------------
  const rows = useMemo<ListRow[]>(() => {
    const noteRows: ListRow[] = notes.map((n) => ({ kind: "note", id: n.path, title: n.title }));
    const meetingRows: ListRow[] = meetings.map((m) => ({
      kind: "meeting",
      id: String(m.sourceId),
      title: m.title,
      subtitle: meetingSubtitle(m),
    }));
    const all = [...meetingRows, ...noteRows];
    const q = filter.trim().toLowerCase();
    return all
      .filter((r) => kindFilter === "all" || r.kind === kindFilter)
      .filter((r) => !q || r.title.toLowerCase().includes(q));
  }, [notes, meetings, filter, kindFilter]);

  const isMeeting = sel?.kind === "meeting";
  const isMeetingDraft = frontmatter.type === "meeting";
  const ready = sel && loadedKey === itemParam(sel);
  const showProperties = isMeeting || hasProperties(frontmatter);
  const total = notes.length + meetings.length;

  return (
    <div className="flex h-full">
      {/* list */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-desk/40">
        <div className="flex items-center gap-2 px-4 pb-2 pt-6">
          <h2 className="font-serif text-lg text-paper">Notes</h2>
          <span className="text-xs text-dim">{rows.length}</span>
          <button
            onClick={() => setCreating(true)}
            className="ml-auto flex size-7 items-center justify-center rounded-md text-faded transition-colors hover:bg-card hover:text-paper"
            title="New note"
          >
            <Plus className="size-4" />
          </button>
        </div>

        {/* kind filter */}
        <div className="flex gap-1 px-4 pb-2">
          {(["all", "note", "meeting"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={cn(
                "rounded-md px-2 py-0.5 text-xs transition-colors",
                kindFilter === k
                  ? "bg-card text-paper"
                  : "text-faded hover:bg-card/50 hover:text-paper",
              )}
            >
              {k === "all" ? "All" : k === "note" ? "Notes" : "Meetings"}
            </button>
          ))}
        </div>

        <div className="relative px-4 pb-2">
          <Search className="pointer-events-none absolute left-6 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search"
            className="w-full rounded-md border border-line bg-card/40 py-1.5 pl-7 pr-2 text-sm text-paper placeholder:text-dim focus:border-lamp-dim focus:outline-none"
          />
        </div>

        {creating && (
          <div className="px-4 pb-2">
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTitle.trim()) void createNote(newTitle);
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewTitle("");
                }
              }}
              onBlur={() => {
                if (newTitle.trim()) void createNote(newTitle);
                else setCreating(false);
              }}
              placeholder="Note title…"
              className="w-full rounded-md border border-lamp-dim bg-card py-1.5 px-2 text-sm text-paper placeholder:text-dim focus:outline-none"
            />
          </div>
        )}

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {rows.length === 0 && !creating && (
            <p className="px-2 py-3 text-xs text-dim">
              {total === 0 ? "Nothing yet. Create a note." : "No matches."}
            </p>
          )}
          {rows.map((r) => {
            const active = sel?.kind === r.kind && sel.id === r.id;
            const Icon = r.kind === "meeting" ? CalendarDays : FileText;
            return (
              <button
                key={`${r.kind}:${r.id}`}
                onClick={() => open({ kind: r.kind, id: r.id })}
                className={cn(
                  "group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  active ? "bg-card text-paper" : "text-faded hover:bg-card/50 hover:text-paper",
                )}
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-dim transition-colors group-hover:text-lamp" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.title}</span>
                  {r.subtitle && (
                    <span className="block truncate text-[11px] text-dim">{r.subtitle}</span>
                  )}
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* editor */}
      <main className="flex min-w-0 flex-1 flex-col">
        {!sel || !ready ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <FileText className="size-8 text-dim" />
            <p className="text-sm text-faded">
              {total === 0 ? "Your vault is empty." : "Select a note, or create a new one."}
            </p>
            <button
              onClick={() => setCreating(true)}
              className="mt-1 rounded-md border border-line px-3 py-1.5 text-xs text-faded transition-colors hover:border-lamp-dim hover:text-paper"
            >
              New note
            </button>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {/* header */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-6 py-2.5">
              {isMeeting ? (
                <input
                  value={meetingTitle}
                  onChange={(e) => {
                    setMeetingTitle(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="Meeting title"
                  className="min-w-0 flex-1 bg-transparent font-serif text-lg text-paper placeholder:text-dim focus:outline-none"
                />
              ) : (
                <span className="truncate font-mono text-[11px] uppercase tracking-[0.2em] text-dim">
                  {sel.id}
                </span>
              )}
              <div className="flex shrink-0 items-center gap-3">
                {isMeetingDraft ? (
                  <>
                    <span className="text-[11px] text-dim">{dirty ? "Unsaved" : ""}</span>
                    <button
                      onClick={saveExtract}
                      disabled={busy}
                      className="rounded-md bg-lamp px-3 py-1.5 text-xs font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? "Saving…" : isMeeting ? "Save & re-extract" : "Save & extract"}
                    </button>
                  </>
                ) : (
                  <span className="text-[11px] text-dim">
                    {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved" : ""}
                  </span>
                )}
                {!isMeeting && (
                  <button
                    onClick={remove}
                    className="flex size-7 items-center justify-center rounded-md text-faded transition-colors hover:bg-card hover:text-red-400"
                    title="Delete note"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            </div>

            {error && (
              <div className="shrink-0 border-b border-rust/40 bg-rust/10 px-6 py-2 text-xs text-rust">
                {error}
              </div>
            )}

            {showProperties && (
              <NoteProperties value={frontmatter} onChange={onPropsChange} lockType={isMeeting} />
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
              <SimpleEditor
                key={itemParam(sel)}
                markdown={body}
                onChange={onBodyChange}
                suggest={suggest}
                onFollow={follow}
                onInsert={onMentionInsert}
                onApplyTemplate={applyMeetingTemplate}
              />

              {isMeeting && detail && (
                <MeetingProcessedPanel
                  detail={detail}
                  busy={busy}
                  onReprocess={reprocess}
                  onReviewLink={reviewLink}
                />
              )}
            </div>

            {backlinks.length > 0 && (
              <section className="max-h-44 shrink-0 overflow-y-auto border-t border-line px-6 py-3">
                <h3 className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-dim">
                  <Link2 className="size-3.5" /> Linked from
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {backlinks.map((b) => (
                    <li key={b.path}>
                      <button
                        onClick={() => open({ kind: "note", id: b.path })}
                        className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-faded transition-colors hover:bg-card/50 hover:text-paper"
                      >
                        <FileText className="size-3.5 text-dim" />
                        {b.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
