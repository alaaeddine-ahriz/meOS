import { CalendarDays, FileText, Users, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { NoteFrontmatter } from "@/lib/frontmatter";

/** Split a comma/`;`-separated string into clean attendee names. */
function splitNames(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * The Notion-style "properties" panel pinned above a note's body. It edits the
 * note's front matter as structured fields: the note `type`, and — for a meeting
 * — its date, attendees, and any referenced calendar event. Purely controlled;
 * the host view owns persistence (YAML for vault notes, the meetings API for
 * meetings). `lockType` keeps a saved meeting from being turned back into a note.
 */
export function NoteProperties({
  value,
  onChange,
  lockType = false,
}: {
  value: NoteFrontmatter;
  onChange: (next: NoteFrontmatter) => void;
  lockType?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const isMeeting = value.type === "meeting";
  const attendees = value.attendees ?? [];

  const setType = (type: "note" | "meeting") => onChange({ ...value, type });

  const addAttendees = (raw: string) => {
    const names = splitNames(raw).filter((n) => !attendees.includes(n));
    if (names.length === 0) return;
    onChange({ ...value, attendees: [...attendees, ...names] });
  };
  const removeAttendee = (name: string) =>
    onChange({ ...value, attendees: attendees.filter((a) => a !== name) });

  return (
    <div className="space-y-2.5 border-b border-line px-6 py-3">
      {/* type toggle */}
      <Row icon={<FileText className="size-3.5" />} label="Type">
        <div className="flex gap-1">
          {(["note", "meeting"] as const).map((t) => (
            <button
              key={t}
              type="button"
              disabled={lockType && value.type !== t}
              onClick={() => setType(t)}
              className={cn(
                "rounded-md px-2 py-0.5 text-xs capitalize transition-colors",
                value.type === t || (!value.type && t === "note")
                  ? "bg-card text-paper"
                  : "text-faded hover:bg-card/50 hover:text-paper",
                lockType &&
                  value.type !== t &&
                  "cursor-not-allowed opacity-40 hover:bg-transparent",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </Row>

      {isMeeting && (
        <>
          {/* date */}
          <Row icon={<CalendarDays className="size-3.5" />} label="Date">
            <input
              type="date"
              value={value.date ?? ""}
              onChange={(e) => onChange({ ...value, date: e.target.value || undefined })}
              className="rounded-md border border-line bg-card/40 px-2 py-0.5 text-xs text-paper focus:border-lamp-dim focus:outline-none"
            />
          </Row>

          {/* attendees */}
          <Row icon={<Users className="size-3.5" />} label="Attendees">
            <div className="flex flex-1 flex-wrap items-center gap-1">
              {attendees.map((name) => (
                <Chip
                  key={name}
                  label={name}
                  onRemove={() => removeAttendee(name)}
                  title={`Remove ${name}`}
                />
              ))}
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === ",") && draft.trim()) {
                    e.preventDefault();
                    addAttendees(draft);
                    setDraft("");
                  } else if (e.key === "Backspace" && !draft && attendees.length > 0) {
                    removeAttendee(attendees[attendees.length - 1]!);
                  }
                }}
                onBlur={() => {
                  if (draft.trim()) {
                    addAttendees(draft);
                    setDraft("");
                  }
                }}
                placeholder={attendees.length === 0 ? "Add people…" : ""}
                className="min-w-24 flex-1 bg-transparent text-xs text-paper placeholder:text-dim focus:outline-none"
              />
            </div>
          </Row>

          {/* referenced event */}
          {value.event?.title && (
            <Row icon={<CalendarDays className="size-3.5" />} label="Event">
              <Chip
                label={value.event.title}
                onRemove={() => onChange({ ...value, event: undefined })}
                title="Remove event"
              />
            </Row>
          )}
        </>
      )}
    </div>
  );
}

/** A labelled property row: a fixed-width icon + label, then the editor. */
function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex w-24 shrink-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-dim">
        {icon}
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}

/** A removable pill showing a label with an inline ✕ button. */
function Chip({ label, onRemove, title }: { label: string; onRemove: () => void; title: string }) {
  return (
    <span className="flex items-center gap-1 rounded-md bg-card px-1.5 py-0.5 text-xs text-paper">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="text-dim transition-colors hover:text-rust"
        title={title}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
