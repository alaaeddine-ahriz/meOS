import { FileText, Link2, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { FollowTarget, LinkTarget } from "@/lib/tiptap/mention";
import { SimpleEditor } from "@/components/tiptap-templates/simple/simple-editor";
import { api, type EntitySummary, type NoteContents, type NoteMeta } from "../api.js";

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

export function VaultView() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const activePath = params.get("note");

  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [note, setNote] = useState<NoteContents | null>(null);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");

  // Latest unsaved markdown + a debounce timer, so edits flush on a pause and
  // again when the user navigates to another note.
  const pending = useRef<{ path: string; markdown: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshNotes = useCallback(() => api.listNotes().then((r) => setNotes(r.notes)), []);

  useEffect(() => {
    refreshNotes();
    api.listEntities().then((r) => setEntities(r.entities)).catch(() => {});
  }, [refreshNotes]);

  // Load the selected note's contents whenever the active path changes.
  useEffect(() => {
    if (!activePath) {
      setNote(null);
      return;
    }
    let live = true;
    api
      .getNote(activePath)
      .then((n) => live && setNote(n))
      .catch(() => live && setNote(null));
    return () => {
      live = false;
    };
  }, [activePath]);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setSaved("saving");
    await api.saveNote(p.path, p.markdown).catch(() => {});
    setSaved("saved");
    refreshNotes();
  }, [refreshNotes]);

  const open = useCallback(
    async (path: string) => {
      await flush();
      setParams({ note: path }, { replace: false });
    },
    [flush, setParams],
  );

  const handleChange = useCallback(
    (markdown: string) => {
      if (!activePath) return;
      pending.current = { path: activePath, markdown };
      setSaved("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [activePath, flush],
  );

  const createNote = useCallback(
    async (title: string) => {
      const path = toNotePath(title);
      await api.createNote(path).catch(() => {});
      await refreshNotes();
      setCreating(false);
      setNewTitle("");
      open(path);
    },
    [open, refreshNotes],
  );

  const remove = useCallback(async () => {
    if (!activePath) return;
    if (!confirm(`Delete "${note?.title ?? activePath}"? This cannot be undone.`)) return;
    await flush();
    pending.current = null;
    await api.deleteNote(activePath).catch(() => {});
    setParams({}, { replace: true });
    refreshNotes();
  }, [activePath, note, flush, setParams, refreshNotes]);

  // --- [[wiki-link]] wiring -------------------------------------------------
  const suggest = useCallback(
    (query: string): LinkTarget[] => {
      const q = query.trim().toLowerCase();
      const noteHits: LinkTarget[] = notes
        .filter((n) => !q || n.title.toLowerCase().includes(q))
        .slice(0, 6)
        .map((n) => ({ label: n.title, type: "note", target: n.path }));
      const wikiHits: LinkTarget[] = entities
        .filter((e) => !q || e.name.toLowerCase().includes(q))
        .slice(0, 6)
        .map((e) => ({ label: e.name, type: "wiki", target: e.slug }));
      const hits = [...noteHits, ...wikiHits];
      // Offer to mint a brand-new note when the query matches nothing exactly,
      // so `[[` always lets you link forward to a page that doesn't exist yet.
      const exact = hits.some((h) => h.label.toLowerCase() === q);
      if (query.trim() && !exact) {
        hits.push({ label: query.trim(), type: "note", target: "" });
      }
      return hits;
    },
    [notes, entities],
  );

  const follow = useCallback(
    (t: FollowTarget) => {
      // Prefer the target the chip carries; fall back to resolving by label.
      if (t.kind === "note" && t.target) return void open(t.target);
      if (t.kind === "wiki" && t.target) return navigate(`/wiki/${t.target}`);
      const lower = t.label.trim().toLowerCase();
      const noteHit = notes.find((n) => n.title.toLowerCase() === lower || baseName(n.path).toLowerCase() === lower);
      if (noteHit) return void open(noteHit.path);
      const wikiHit = entities.find((e) => e.name.toLowerCase() === lower);
      if (wikiHit) return navigate(`/wiki/${wikiHit.slug}`);
      // Unresolved mention: create the note on the fly, Obsidian-style.
      void createNote(t.label);
    },
    [notes, entities, open, navigate, createNote],
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? notes.filter((n) => n.title.toLowerCase().includes(q)) : notes;
  }, [notes, filter]);

  return (
    <div className="flex h-full">
      {/* note list */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-desk/40">
        <div className="flex items-center gap-2 px-4 pb-2 pt-6">
          <h2 className="font-serif text-lg text-paper">Notes</h2>
          <span className="text-xs text-dim">{notes.length}</span>
          <button
            onClick={() => setCreating(true)}
            className="ml-auto flex size-7 items-center justify-center rounded-md text-faded transition-colors hover:bg-card hover:text-paper"
            title="New note"
          >
            <Plus className="size-4" />
          </button>
        </div>

        <div className="relative px-4 pb-2">
          <Search className="pointer-events-none absolute left-6 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search notes"
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
          {visible.length === 0 && !creating && (
            <p className="px-2 py-3 text-xs text-dim">
              {notes.length === 0 ? "No notes yet. Create one to begin." : "No matches."}
            </p>
          )}
          {visible.map((n) => (
            <button
              key={n.path}
              onClick={() => open(n.path)}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                n.path === activePath ? "bg-card text-paper" : "text-faded hover:bg-card/50 hover:text-paper",
              )}
            >
              <FileText className="size-4 shrink-0 text-dim transition-colors group-hover:text-lamp" />
              <span className="truncate">{n.title}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* editor */}
      <main className="flex min-w-0 flex-1 flex-col">
        {!activePath || !note ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <FileText className="size-8 text-dim" />
            <p className="text-sm text-faded">
              {notes.length === 0 ? "Your vault is empty." : "Select a note, or create a new one."}
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
            <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-2.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-dim">{note.path}</span>
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-dim">
                  {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved" : ""}
                </span>
                <button
                  onClick={remove}
                  className="flex size-7 items-center justify-center rounded-md text-faded transition-colors hover:bg-card hover:text-red-400"
                  title="Delete note"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1">
              <SimpleEditor key={note.path} markdown={note.markdown} onChange={handleChange} suggest={suggest} onFollow={follow} />
            </div>

            {note.backlinks.length > 0 && (
              <section className="max-h-44 shrink-0 overflow-y-auto border-t border-line px-6 py-3">
                <h3 className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-dim">
                  <Link2 className="size-3.5" /> Linked from
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {note.backlinks.map((b) => (
                    <li key={b.path}>
                      <button
                        onClick={() => open(b.path)}
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
