import { CalendarDays, Check, Plus, RefreshCw, Users, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  api,
  type MeetingDetail,
  type MeetingLink,
  type MeetingObservation,
  type MeetingSummary,
} from "../api.js";

/** A blank meeting form. */
const EMPTY = { title: "", date: "", attendees: "", content: "" };

type FormState = typeof EMPTY;

/** Map a MeetingDetail back into the editable form shape. */
function toForm(detail: MeetingDetail): FormState {
  return {
    title: detail.title,
    date: detail.date ?? "",
    attendees: detail.attendees.join(", "),
    content: detail.content,
  };
}

/** Parse the comma-separated attendees field into a clean name list. */
function parseAttendees(raw: string): string[] {
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

export function MeetingsView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const selectedId = id ? Number(id) : null;

  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [mode, setMode] = useState<"view" | "create" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => api.listMeetings().then((r) => setMeetings(r.meetings)), []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Load the selected meeting's detail (or reset to a clean list when none).
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      if (mode === "view") setForm(EMPTY);
      return;
    }
    setMode("view");
    api
      .getMeeting(selectedId)
      .then((d) => {
        setDetail(d);
        setForm(toForm(d));
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const startCreate = () => {
    setForm(EMPTY);
    setDetail(null);
    setMode("create");
    navigate("/meetings");
  };

  const save = async () => {
    if (!form.title.trim()) {
      setError("A meeting needs a title.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        title: form.title.trim(),
        date: form.date.trim() || null,
        attendees: parseAttendees(form.attendees),
        content: form.content,
      };
      const result =
        mode === "edit" && selectedId !== null
          ? await api.updateMeeting(selectedId, body)
          : await api.createMeeting(body);
      await refresh();
      setMode("view");
      setDetail(result);
      setForm(toForm(result));
      navigate(`/meetings/${result.sourceId}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reprocess = async () => {
    if (selectedId === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.reprocessMeeting(selectedId);
      const d = await api.getMeeting(selectedId);
      setDetail(d);
      setForm(toForm(d));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const reviewLink = async (link: MeetingLink, status: "accepted" | "rejected") => {
    if (selectedId === null) return;
    await api.reviewMeetingLink(selectedId, link.id, status);
    setDetail(await api.getMeeting(selectedId));
  };

  return (
    <div className="flex h-full">
      {/* List */}
      <div className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h1 className="text-sm font-medium text-paper">Meetings</h1>
          <button
            onClick={startCreate}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-faded transition-colors hover:bg-card/50 hover:text-paper"
          >
            <Plus className="size-3.5" /> New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {meetings.length === 0 && (
            <p className="px-2 py-4 text-xs text-dim">No meeting notes yet.</p>
          )}
          {meetings.map((m) => (
            <Link
              key={m.sourceId}
              to={`/meetings/${m.sourceId}`}
              className={cn(
                "block rounded-md px-2.5 py-2 text-sm transition-colors",
                m.sourceId === selectedId
                  ? "bg-card text-paper"
                  : "text-faded hover:bg-card/50 hover:text-paper",
              )}
            >
              <span className="block truncate">{m.title}</span>
              <span className="mt-0.5 block text-[11px] text-dim">
                {m.date || "no date"}
                {m.attendees.length > 0 &&
                  ` · ${m.attendees.length} attendee${m.attendees.length > 1 ? "s" : ""}`}
              </span>
            </Link>
          ))}
        </div>
      </div>

      {/* Detail / form */}
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        {error && (
          <div className="mb-4 rounded-md border border-rust/40 bg-rust/10 px-3 py-2 text-xs text-rust">
            {error}
          </div>
        )}

        {mode === "create" || mode === "edit" ? (
          <MeetingForm
            form={form}
            setForm={setForm}
            busy={busy}
            onSave={save}
            onCancel={() => {
              setMode("view");
              if (detail) setForm(toForm(detail));
              else navigate("/meetings");
            }}
            isEdit={mode === "edit"}
          />
        ) : detail ? (
          <MeetingDetailView
            detail={detail}
            busy={busy}
            onEdit={() => setMode("edit")}
            onReprocess={reprocess}
            onReviewLink={reviewLink}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-dim">
            Select a meeting, or create a new one.
          </div>
        )}
      </div>
    </div>
  );
}

function MeetingForm({
  form,
  setForm,
  busy,
  onSave,
  onCancel,
  isEdit,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  isEdit: boolean;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="mb-4 text-lg font-medium text-paper">
        {isEdit ? "Edit meeting note" : "New meeting note"}
      </h2>
      <div className="space-y-3">
        <input
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="Title"
          className="w-full rounded-md border border-line bg-card/50 px-3 py-2 text-sm text-paper placeholder:text-dim focus:outline-none focus:ring-1 focus:ring-lamp"
        />
        <div className="flex gap-3">
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className="rounded-md border border-line bg-card/50 px-3 py-2 text-sm text-paper focus:outline-none focus:ring-1 focus:ring-lamp"
          />
          <input
            value={form.attendees}
            onChange={(e) => setForm({ ...form, attendees: e.target.value })}
            placeholder="Attendees (comma-separated)"
            className="flex-1 rounded-md border border-line bg-card/50 px-3 py-2 text-sm text-paper placeholder:text-dim focus:outline-none focus:ring-1 focus:ring-lamp"
          />
        </div>
        <textarea
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          placeholder="Meeting notes… decisions, action items, risks, open questions"
          rows={14}
          className="w-full resize-y rounded-md border border-line bg-card/50 px-3 py-2 text-sm text-paper placeholder:text-dim focus:outline-none focus:ring-1 focus:ring-lamp"
        />
        <div className="flex gap-2">
          <button
            onClick={onSave}
            disabled={busy}
            className="rounded-md bg-lamp px-3 py-1.5 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : isEdit ? "Save & re-extract" : "Create & extract"}
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-faded transition-colors hover:bg-card/50 hover:text-paper"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function MeetingDetailView({
  detail,
  busy,
  onEdit,
  onReprocess,
  onReviewLink,
}: {
  detail: MeetingDetail;
  busy: boolean;
  onEdit: () => void;
  onReprocess: () => void;
  onReviewLink: (link: MeetingLink, status: "accepted" | "rejected") => void;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-paper">{detail.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-dim">
            {detail.date && (
              <span className="flex items-center gap-1">
                <CalendarDays className="size-3.5" /> {detail.date}
              </span>
            )}
            {detail.attendees.length > 0 && (
              <span className="flex items-center gap-1">
                <Users className="size-3.5" /> {detail.attendees.join(", ")}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={onReprocess}
            disabled={busy}
            className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1.5 text-xs text-faded transition-colors hover:bg-card/50 hover:text-paper disabled:opacity-50"
            title="Re-run extraction over the current note"
          >
            <RefreshCw className={cn("size-3.5", busy && "animate-spin")} /> Reprocess
          </button>
          <button
            onClick={onEdit}
            className="rounded-md border border-line px-2.5 py-1.5 text-xs text-faded transition-colors hover:bg-card/50 hover:text-paper"
          >
            Edit
          </button>
        </div>
      </div>

      {/* Suggested links */}
      <section className="mb-6">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">
          Suggested links
        </h3>
        {detail.links.length === 0 ? (
          <p className="text-xs text-dim">No links suggested yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {detail.links.map((link) => (
              <li
                key={link.id}
                className="flex items-center gap-2 rounded-md border border-line bg-card/30 px-3 py-2"
              >
                <Link
                  to={`/wiki/${link.entitySlug}`}
                  className="text-sm text-paper hover:text-lamp"
                >
                  {link.entityName}
                </Link>
                <span className="rounded bg-card px-1.5 py-0.5 text-[10px] uppercase text-dim">
                  {link.entityType}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-dim" title={link.rationale}>
                  {link.rationale}
                </span>
                {link.status === "suggested" ? (
                  <span className="flex shrink-0 gap-1">
                    <button
                      onClick={() => onReviewLink(link, "accepted")}
                      className="rounded p-1 text-faded transition-colors hover:bg-card hover:text-sage"
                      title="Accept link"
                    >
                      <Check className="size-3.5" />
                    </button>
                    <button
                      onClick={() => onReviewLink(link, "rejected")}
                      className="rounded p-1 text-faded transition-colors hover:bg-card hover:text-rust"
                      title="Reject link"
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                ) : (
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase",
                      link.status === "accepted" ? "text-sage" : "text-rust",
                    )}
                  >
                    {link.status}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Extracted structure */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <ObservationGroup title="Decisions" items={detail.decisions} />
        <ObservationGroup title="Action items" items={detail.actionItems} />
        <ObservationGroup title="Risks" items={detail.risks} />
        <ObservationGroup title="Open questions" items={detail.openQuestions} />
      </div>

      {/* Original note */}
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">Original note</h3>
        <pre className="whitespace-pre-wrap rounded-md border border-line bg-card/30 px-3 py-2 text-sm text-faded">
          {detail.content}
        </pre>
      </section>
    </div>
  );
}

function ObservationGroup({ title, items }: { title: string; items: MeetingObservation[] }) {
  return (
    <section className="rounded-md border border-line bg-card/30 p-3">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">
        {title}
        <span className="ml-1.5 text-dim/60">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-dim">None.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((o) => (
            <li key={o.id} className="text-sm text-paper">
              {o.text}
              <span className="ml-1 text-[11px] text-dim">— {o.entity}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
