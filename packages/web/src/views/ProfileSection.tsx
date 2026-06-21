import {
  Check,
  FileUp,
  History,
  Library,
  Lock,
  MessageSquare,
  RotateCcw,
  Sparkles,
  Unlock,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DiffView } from "@/components/DiffView";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  api,
  type AuditEntry,
  type ProfileData,
  type ProfileProposal,
  type ProfileSectionView,
  type ProfileVersion,
} from "../api.js";

const inputClass =
  "border-line bg-transparent font-mono text-[13px] text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0";
const actionButtonClass =
  "shrink-0 border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper";

/**
 * A minimal, readable line diff between two blocks of text. Trims the common
 * prefix/suffix lines and renders the changed middle as removed-then-added,
 * formatted as a unified `git` patch so the shared DiffView can render it.
 */
function buildPatch(label: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const lines: string[] = [`diff --git a/${label} b/${label}`, "@@ @@"];
  for (let i = Math.max(0, start - 1); i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i < endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i < endB; i++) lines.push(`+${b[i]}`);
  return lines.join("\n");
}

export function ProfileSection() {
  const [data, setData] = useState<ProfileData | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI drafting
  const [aiBusy, setAiBusy] = useState<null | "upload" | "wiki">(null);
  const [proposal, setProposal] = useState<ProfileProposal | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // history dialog
  const [historyFor, setHistoryFor] = useState<ProfileSectionView | null>(null);

  const apply = (next: ProfileData) => {
    setData(next);
    setEdited(Object.fromEntries(next.sections.map((s) => [s.id, s.content])));
  };

  useEffect(() => {
    api
      .getProfile()
      .then(apply)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const dirty = data?.sections.some((s) => (edited[s.id] ?? "") !== s.content) ?? false;

  const saveAll = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      apply(await api.applyProfile(edited));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAiBusy("upload");
    setError(null);
    try {
      setProposal((await api.uploadProfileDocs(Array.from(files))).proposal);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const onGenerateFromWiki = async () => {
    setAiBusy("wiki");
    setError(null);
    try {
      setProposal((await api.draftProfileFromWiki()).proposal);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(null);
    }
  };

  const togglePrivacy = async () => {
    if (!data) return;
    const sync = !data.gitSync;
    setData({ ...data, gitSync: sync });
    setError(null);
    try {
      await api.setProfilePrivacy(sync);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData({ ...data, gitSync: !sync });
    }
  };

  if (!data) {
    return (
      <section>
        {error ? (
          <p className="text-sm text-ember">⚠ {error}</p>
        ) : (
          <p className="text-sm text-dim">Loading…</p>
        )}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      {/* Drafting actions */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => void onUpload(e.target.files)}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onGenerateFromWiki()}
          disabled={aiBusy !== null}
          className={actionButtonClass}
        >
          <Library className={cn("size-3.5", aiBusy === "wiki" && "animate-pulse")} />
          {aiBusy === "wiki" ? "Reading your wiki…" : "Generate from wiki"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInput.current?.click()}
          disabled={aiBusy !== null}
          className={actionButtonClass}
        >
          <FileUp className={cn("size-3.5", aiBusy === "upload" && "animate-pulse")} />
          {aiBusy === "upload" ? "Reading…" : "Upload documents"}
        </Button>
        <span className="flex items-center gap-1.5 text-[12px] text-dim">
          <MessageSquare className="size-3.5" />
          or refine in{" "}
          <code className="rounded bg-card px-1 py-0.5 font-mono text-faded">/profile</code> chat
        </span>
      </div>

      {/* One unified editor: section labels over borderless fields, so the whole
          profile reads as a single document rather than a stack of separate inputs. */}
      <div className="flex flex-col gap-5 rounded-xl border border-line bg-card/40 p-4">
        {data.sections.map((section) => (
          <div key={section.id} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium uppercase tracking-wider text-dim">
                {section.title}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setHistoryFor(section)}
                className="shrink-0 text-dim hover:bg-transparent hover:text-paper"
                title="Version history"
              >
                <History className="size-3.5" />
              </Button>
            </div>
            <Textarea
              value={edited[section.id] ?? ""}
              onChange={(e) => setEdited((prev) => ({ ...prev, [section.id]: e.target.value }))}
              placeholder={section.placeholder}
              rows={section.id === "about-me" ? 3 : 5}
              className="resize-none rounded-none border-0 bg-transparent p-0 font-mono text-[13px] leading-relaxed text-paper shadow-none placeholder:text-dim focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
        ))}
      </div>

      {/* Single save bar */}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void saveAll()}
          disabled={!dirty || saving}
          className={actionButtonClass}
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-moss">
            <Check className="size-3.5" /> saved
          </span>
        )}
        {dirty && !saved && <span className="text-[12px] text-dim">unsaved changes</span>}
      </div>

      {/* Privacy + audit, kept low-key */}
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[13px] text-faded">
          {data.gitSync ? (
            <Unlock className="size-3.5 text-lamp" />
          ) : (
            <Lock className="size-3.5 text-moss" />
          )}
          {data.gitSync ? "Exported to Git sync" : "Private to this machine"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void togglePrivacy()}
          className="text-dim hover:bg-transparent hover:text-paper"
        >
          {data.gitSync ? "Make private" : "Allow export"}
        </Button>
      </div>

      <AuditTrail />

      {error && <p className="text-sm text-ember">⚠ {error}</p>}

      <ReviewDialog
        proposal={proposal}
        current={data}
        onClose={() => setProposal(null)}
        onApplied={(next) => {
          setProposal(null);
          apply(next);
        }}
      />

      {historyFor && (
        <HistoryDialog
          section={historyFor}
          onClose={() => setHistoryFor(null)}
          onRestored={(next) => {
            setHistoryFor(null);
            apply(next);
          }}
        />
      )}
    </section>
  );
}

/** Review an AI proposal as a per-section diff; the proposed text stays editable before applying. */
function ReviewDialog({
  proposal,
  current,
  onClose,
  onApplied,
}: {
  proposal: ProfileProposal | null;
  current: ProfileData;
  onClose: () => void;
  onApplied: (next: ProfileData) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (proposal) setDraft({ ...proposal.profile });
  }, [proposal]);

  if (!proposal) return null;

  const changed = current.sections.filter(
    (s) => (proposal.profile[s.id] ?? "").trim() !== s.content.trim(),
  );

  const applyProposal = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.applyProfile(draft);
      onApplied(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-line sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif text-xl font-medium text-paper">
            <Sparkles className="size-5 text-lamp" /> Review proposed profile
          </DialogTitle>
          <DialogDescription className="text-sm text-dim">{proposal.summary}</DialogDescription>
        </DialogHeader>

        {changed.length === 0 ? (
          <p className="text-sm text-dim">
            No changes proposed — your profile already reflects this.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {changed.map((s) => (
              <div key={s.id} className="flex flex-col gap-2">
                <span className="text-sm text-paper">{s.title}</span>
                <DiffView
                  patch={buildPatch(s.title, s.content, proposal.profile[s.id] ?? "")}
                  showPaths={false}
                />
                <Textarea
                  value={draft[s.id] ?? ""}
                  onChange={(e) => setDraft((prev) => ({ ...prev, [s.id]: e.target.value }))}
                  rows={5}
                  className={cn(inputClass, "resize-y leading-relaxed")}
                />
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-ember">⚠ {error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy} className={actionButtonClass}>
            Reject
          </Button>
          <Button
            variant="outline"
            onClick={() => void applyProposal()}
            disabled={busy || changed.length === 0}
            className={cn(actionButtonClass, "border-lamp-dim text-paper")}
          >
            {busy ? "Applying…" : "Accept & apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({
  section,
  onClose,
  onRestored,
}: {
  section: ProfileSectionView;
  onClose: () => void;
  onRestored: (next: ProfileData) => void;
}) {
  const [versions, setVersions] = useState<ProfileVersion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getProfileHistory(section.id)
      .then((r) => setVersions(r.versions))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [section.id]);

  const restore = async (version: string) => {
    setBusy(version);
    setError(null);
    try {
      onRestored(await api.restoreProfileVersion(section.id, version));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="border-line">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif text-xl font-medium text-paper">
            <History className="size-5 text-dim" /> {section.title} — history
          </DialogTitle>
          <DialogDescription className="text-sm text-dim">
            Earlier versions, saved automatically before each change. Restoring snapshots the
            current version first.
          </DialogDescription>
        </DialogHeader>

        {versions === null ? (
          <p className="text-sm text-dim">Loading…</p>
        ) : versions.length === 0 ? (
          <p className="text-sm text-dim">No earlier versions yet.</p>
        ) : (
          <ul className="flex flex-col">
            {versions.map((v) => (
              <li key={v.version} className="flex items-center justify-between gap-3 py-2">
                <span className="font-mono text-[12px] text-faded">
                  {new Date(v.savedAt).toLocaleString()}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void restore(v.version)}
                  disabled={busy !== null}
                  className="text-dim hover:bg-transparent hover:text-paper"
                >
                  <RotateCcw className="size-3.5" />
                  {busy === v.version ? "Restoring…" : "Restore"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-ember">⚠ {error}</p>}
      </DialogContent>
    </Dialog>
  );
}

/** The profile-edit audit trail (governance): every change, with a justification. */
function AuditTrail() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open && entries === null) {
      api
        .getProfileAudit()
        .then((r) => setEntries(r.entries))
        .catch(() => setEntries([]));
    }
  }, [open, entries]);

  const describe = (entry: AuditEntry): string => {
    try {
      const detail = entry.detail
        ? (JSON.parse(entry.detail) as { action?: string; [k: string]: unknown })
        : {};
      const { action, ...rest } = detail;
      const extra = Object.entries(rest)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
        .join(" · ");
      return [action ?? entry.op, extra].filter(Boolean).join(" — ");
    } catch {
      return entry.detail ?? entry.op;
    }
  };

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-dim hover:text-faded"
      >
        <History className="size-3.5" /> edit history {open ? "▾" : "▸"}
      </button>
      {open &&
        (entries === null ? (
          <p className="mt-3 text-sm text-dim">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="mt-3 text-sm text-dim">No profile edits recorded yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {entries.map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-faded">{describe(e)}</span>
                <span className="shrink-0 font-mono text-[11px] text-dim">{e.created_at}</span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
