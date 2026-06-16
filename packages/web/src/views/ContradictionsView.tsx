import { Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CountBadge } from "@/components/HubTabs";
import { Page, PageHeader } from "@/components/Page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, type Contradiction, type DuplicateProposal, type ResolutionAction } from "../api.js";

/** Which "apply all" flow the confirm dialog is for — duplicate merges or conflict resolutions. */
type AutoKind = "linked" | "conflicts";

const ACTION_LABEL: Record<ResolutionAction, string> = {
  supersede_a: "Keep the first",
  supersede_b: "Keep the second",
  keep_both: "Keep both",
  context_specific: "Context-specific",
};

/** Which claim a suggested supersede keeps (the winner), for highlighting. */
function suggestedWinner(action: ResolutionAction | undefined): "a" | "b" | null {
  if (action === "supersede_a") return "b"; // supersede_a retires A → B wins
  if (action === "supersede_b") return "a";
  return null;
}

export function ContradictionsView({ embedded = false }: { embedded?: boolean }) {
  const [items, setItems] = useState<Contradiction[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Which "apply all" the user is being asked to confirm, and whether a confirmed
  // run is in flight. Auto mode never acts without this confirmation.
  const [confirmAuto, setConfirmAuto] = useState<AutoKind | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);

  const load = () =>
    api
      .getContradictions()
      .then((r) => setItems(r.contradictions))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));

  const loadDuplicates = () =>
    api
      .getDuplicates()
      .then((r) => setDuplicates(r.duplicates))
      .catch(() => setDuplicates([]));

  useEffect(() => {
    void load();
    void loadDuplicates();
  }, []);

  const merge = async (d: DuplicateProposal) => {
    const key = `${d.aId}-${d.bId}`;
    setPending(key);
    try {
      const loserId = d.suggestedWinnerId === d.aId ? d.bId : d.aId;
      await api.mergeEntities(loserId, d.suggestedWinnerId);
      // Re-fetch rather than dropping just this pair: a merge deletes an entity,
      // and in a duplicate cluster (A≈B≈C) other proposals still reference the
      // now-gone entity. Merging those would silently 400 ("unknown entity").
      // The server recomputes proposals against the surviving entities.
      await loadDuplicates();
      // a merge can retire a duplicate-driven contradiction; refresh the list
      void load();
    } catch {
      // leave it; the user can retry
    } finally {
      setPending(null);
    }
  };

  const dismiss = async (d: DuplicateProposal) => {
    const key = `${d.aId}-${d.bId}`;
    setPending(key);
    try {
      await api.dismissDuplicate(d.aId, d.bId);
      setDuplicates((cur) => cur.filter((x) => `${x.aId}-${x.bId}` !== key));
    } catch {
      // leave it; the user can retry
    } finally {
      setPending(null);
    }
  };

  const resolve = async (id: number, action: ResolutionAction) => {
    setBusy(id);
    try {
      await api.resolveContradiction(id, action);
      setItems((current) => current.filter((c) => c.id !== id));
    } catch {
      // leave it in place; the user can retry
    } finally {
      setBusy(null);
    }
  };

  // Conflicts whose proposal carries a clear suggestion — the only ones auto
  // mode will touch. Items with no proposal stay for the user to decide.
  const autoResolvable = items.filter((c) => c.proposal);

  // Apply every duplicate's suggested merge in one confirmed pass. Merges are
  // done one at a time, re-fetching between each: in a cluster (A≈B≈C) merging
  // one pair deletes an entity the other proposals still reference, so the
  // server-recomputed list is the only safe source of the next valid merge.
  const runAutoMerge = async () => {
    setAutoRunning(true);
    try {
      let queue = await api
        .getDuplicates()
        .then((r) => r.duplicates)
        .catch(() => []);
      // Each successful merge removes one entity, so the proposal count strictly
      // trends down; this bound just guarantees termination if a pair keeps failing.
      let guard = queue.length * 2 + 5;
      while (guard-- > 0) {
        const d = queue[0];
        if (!d) break;
        const loserId = d.suggestedWinnerId === d.aId ? d.bId : d.aId;
        try {
          await api.mergeEntities(loserId, d.suggestedWinnerId);
          queue = await api
            .getDuplicates()
            .then((r) => r.duplicates)
            .catch(() => []);
        } catch {
          // Drop the offending pair locally so we don't spin on it; keep going.
          queue = queue.slice(1);
        }
      }
    } finally {
      await loadDuplicates();
      void load(); // merges can retire duplicate-driven conflicts
      setAutoRunning(false);
      setConfirmAuto(null);
    }
  };

  // Apply each conflict's suggested resolution in one confirmed pass. Each
  // resolve is keyed by id and independent, so a snapshot loop is enough.
  const runAutoResolve = async () => {
    setAutoRunning(true);
    try {
      for (const c of autoResolvable) {
        try {
          await api.resolveContradiction(c.id, c.proposal!.suggested);
          setItems((cur) => cur.filter((x) => x.id !== c.id));
        } catch {
          // leave it; the user can retry that one manually
        }
      }
    } finally {
      setAutoRunning(false);
      setConfirmAuto(null);
    }
  };

  const body = (
    <>
      <section className="rise mt-8">
        <SectionHeading title="Possible duplicates" count={duplicates.length} />
        <div className="mt-4 flex flex-col gap-2">
          {duplicates.length > 0 && (
            <AutoBar
              label={`Merge all ${duplicates.length} using the suggested winner`}
              disabled={autoRunning}
              onClick={() => setConfirmAuto("linked")}
            />
          )}
          {duplicates.length === 0 ? (
            <p className="text-sm text-faded">No likely duplicates. Every entity looks distinct.</p>
          ) : (
            duplicates.map((d) => {
              const key = `${d.aId}-${d.bId}`;
              const winnerName = d.suggestedWinnerId === d.aId ? d.aName : d.bName;
              const loserName = d.suggestedWinnerId === d.aId ? d.bName : d.aName;
              return (
                <div
                  key={key}
                  className="flex items-center gap-3 rounded-lg border border-line bg-card/40 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-paper">
                      {d.aName} <span className="text-dim">↔</span> {d.bName}{" "}
                      <span className="text-xs text-dim">({d.type})</span>
                      <span className="ml-2 text-xs text-lamp" title="Match confidence">
                        {Math.round(d.score * 100)}% match
                      </span>
                    </p>
                    <p className="text-xs text-faded">
                      {d.reasons.join("; ")} — keep <span className="text-paper">{winnerName}</span>
                      , merge in {loserName}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending === key}
                    onClick={() => void dismiss(d)}
                    className="border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper"
                  >
                    Dismiss
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending === key}
                    onClick={() => void merge(d)}
                    className="border-lamp-dim bg-transparent text-lamp hover:border-lamp hover:bg-lamp/10 hover:text-lamp"
                  >
                    Merge
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className="rise rise-1 mt-10">
        <SectionHeading title="Conflicting claims" count={items.length} />
        <div className="mt-4 flex flex-col gap-4 pb-16">
          {autoResolvable.length > 0 && (
            <AutoBar
              label={`Resolve ${autoResolvable.length} of ${items.length} using the suggestion`}
              disabled={autoRunning}
              onClick={() => setConfirmAuto("conflicts")}
            />
          )}
          {loading ? (
            <p className="text-sm text-faded">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-faded">
              No open contradictions. Your knowledge base is internally consistent.
            </p>
          ) : (
            items.map((c) => {
              const winner = suggestedWinner(c.proposal?.suggested);
              return (
                <div key={c.id} className="rounded-lg border border-line bg-card/40 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-sm font-medium text-paper">{c.entity_name}</span>
                    <span className="text-xs text-dim">{c.created_at.slice(0, 10)}</span>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <Claim text={c.text_a} highlighted={winner === "a"} />
                    <Claim text={c.text_b} highlighted={winner === "b"} />
                  </div>

                  {c.note && <p className="mt-3 text-xs text-faded">Note: {c.note}</p>}

                  {c.proposal && (
                    <p className="mt-3 text-xs text-faded">
                      <span className="text-lamp">
                        Suggested: {ACTION_LABEL[c.proposal.suggested]}
                      </span>{" "}
                      — {c.proposal.rationale}
                    </p>
                  )}

                  <div className="mt-4 flex flex-wrap gap-2">
                    <ResolveButton
                      primary={c.proposal?.suggested === "supersede_a"}
                      disabled={busy === c.id}
                      onClick={() => resolve(c.id, "supersede_a")}
                    >
                      Keep first
                    </ResolveButton>
                    <ResolveButton
                      primary={c.proposal?.suggested === "supersede_b"}
                      disabled={busy === c.id}
                      onClick={() => resolve(c.id, "supersede_b")}
                    >
                      Keep second
                    </ResolveButton>
                    <ResolveButton
                      primary={c.proposal?.suggested === "keep_both"}
                      disabled={busy === c.id}
                      onClick={() => resolve(c.id, "keep_both")}
                    >
                      Keep both
                    </ResolveButton>
                    <ResolveButton
                      primary={false}
                      disabled={busy === c.id}
                      onClick={() => resolve(c.id, "context_specific")}
                    >
                      Context-specific
                    </ResolveButton>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      <Dialog
        open={confirmAuto !== null}
        onOpenChange={(open) => !open && !autoRunning && setConfirmAuto(null)}
      >
        <DialogContent showCloseButton={!autoRunning}>
          {confirmAuto === "linked" ? (
            <>
              <DialogHeader>
                <DialogTitle>Auto-merge duplicates?</DialogTitle>
                <DialogDescription>
                  meOS will merge {duplicates.length} likely-duplicate{" "}
                  {duplicates.length === 1 ? "pair" : "pairs"}, keeping the suggested entity each
                  time.
                </DialogDescription>
              </DialogHeader>
              <ul className="max-h-56 space-y-1 overflow-y-auto text-xs text-faded">
                {duplicates.map((d) => {
                  const winnerName = d.suggestedWinnerId === d.aId ? d.aName : d.bName;
                  const loserName = d.suggestedWinnerId === d.aId ? d.bName : d.aName;
                  return (
                    <li key={`${d.aId}-${d.bId}`}>
                      Keep <span className="text-paper">{winnerName}</span>, merge in {loserName}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Auto-resolve conflicts?</DialogTitle>
                <DialogDescription>
                  meOS will apply the suggested resolution to {autoResolvable.length} of{" "}
                  {items.length} {items.length === 1 ? "conflict" : "conflicts"}. Conflicts with no
                  clear suggestion stay for you to decide.
                </DialogDescription>
              </DialogHeader>
              <ul className="max-h-56 space-y-1 overflow-y-auto text-xs text-faded">
                {autoResolvable.map((c) => (
                  <li key={c.id}>
                    <span className="text-paper">{c.entity_name}</span> —{" "}
                    {ACTION_LABEL[c.proposal!.suggested]}
                  </li>
                ))}
              </ul>
            </>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={autoRunning}
              onClick={() => setConfirmAuto(null)}
              className="border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper"
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={autoRunning}
              onClick={() => void (confirmAuto === "linked" ? runAutoMerge() : runAutoResolve())}
              className="border-lamp-dim bg-transparent text-lamp hover:border-lamp hover:bg-lamp/10 hover:text-lamp"
            >
              {autoRunning ? "Applying…" : confirmAuto === "linked" ? "Merge all" : "Resolve all"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) return body;
  return (
    <Page>
      <PageHeader
        title="Conflicts"
        description="Where your knowledge disagrees with itself — entities that look like the same thing, and claims that can't both be true. You decide each one."
      />
      {body}
    </Page>
  );
}

/** A small section label with a count badge, separating the two kinds of review. */
function SectionHeading({ title, count }: { title: string; count: number }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-medium text-paper">
      {title}
      <CountBadge count={count} />
    </h2>
  );
}

/** A subtle row offering to apply every suggestion in a section at once. */
function AutoBar({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="mb-2 flex items-center justify-between rounded-lg border border-dashed border-line bg-card/20 px-3 py-2">
      <span className="text-xs text-faded">{label}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onClick}
        className="gap-1.5 border-lamp-dim bg-transparent text-lamp hover:border-lamp hover:bg-lamp/10 hover:text-lamp"
      >
        <Wand2 className="size-3.5" />
        Auto
      </Button>
    </div>
  );
}

function Claim({ text, highlighted }: { text: string; highlighted: boolean }) {
  return (
    <div
      className={
        "rounded-md border p-3 text-sm " +
        (highlighted
          ? "border-lamp-dim bg-lamp/5 text-paper"
          : "border-line bg-transparent text-faded")
      }
    >
      {text}
    </div>
  );
}

function ResolveButton({
  children,
  primary,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  primary: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className={
        primary
          ? "border-lamp-dim bg-transparent text-lamp hover:border-lamp hover:bg-lamp/10 hover:text-lamp"
          : "border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper"
      }
    >
      {children}
    </Button>
  );
}
