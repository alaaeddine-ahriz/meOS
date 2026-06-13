import { useEffect, useState } from "react";
import { Page, PageHeader } from "@/components/Page";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, type Contradiction, type DuplicateProposal, type ResolutionAction } from "../api.js";

type Tab = "linked" | "conflicts";

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

export function ContradictionsView() {
  const [items, setItems] = useState<Contradiction[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("conflicts");

  const load = () =>
    api
      .getContradictions()
      .then((r) => setItems(r.contradictions))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
    api.getDuplicates().then((r) => setDuplicates(r.duplicates)).catch(() => setDuplicates([]));
  }, []);

  const merge = async (d: DuplicateProposal) => {
    const key = `${d.aId}-${d.bId}`;
    setPending(key);
    try {
      const loserId = d.suggestedWinnerId === d.aId ? d.bId : d.aId;
      await api.mergeEntities(loserId, d.suggestedWinnerId);
      setDuplicates((cur) => cur.filter((x) => `${x.aId}-${x.bId}` !== key));
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

  return (
    <Page>
      <PageHeader
        title="Conflicts"
        description="Where your knowledge disagrees with itself — entities that look like the same thing, and claims that can't both be true. You decide each one."
      />

      <nav className="rise mt-8 flex flex-wrap gap-1 border-b border-line">
        <TabButton active={tab === "linked"} onClick={() => setTab("linked")} count={duplicates.length}>
          Linked
        </TabButton>
        <TabButton active={tab === "conflicts"} onClick={() => setTab("conflicts")} count={items.length}>
          Conflicts
        </TabButton>
      </nav>

      {tab === "linked" && (
        <div className="rise rise-1 mt-8 flex flex-col gap-2 pb-16">
          {duplicates.length === 0 ? (
            <p className="text-sm text-faded">No likely duplicates. Every entity looks distinct.</p>
          ) : (
            duplicates.map((d) => {
              const key = `${d.aId}-${d.bId}`;
              const winnerName = d.suggestedWinnerId === d.aId ? d.aName : d.bName;
              const loserName = d.suggestedWinnerId === d.aId ? d.bName : d.aName;
              return (
                <div key={key} className="flex items-center gap-3 rounded-lg border border-line bg-card/40 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-paper">
                      {d.aName} <span className="text-dim">↔</span> {d.bName}{" "}
                      <span className="text-xs text-dim">({d.type})</span>
                    </p>
                    <p className="text-xs text-faded">
                      {d.reasons.join("; ")} — keep <span className="text-paper">{winnerName}</span>, merge in {loserName}
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
      )}

      {tab === "conflicts" && (
      <div className="rise rise-1 mt-8 flex flex-col gap-4 pb-16">
        {loading ? (
          <p className="text-sm text-faded">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-faded">No open contradictions. Your knowledge base is internally consistent.</p>
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
                    <span className="text-lamp">Suggested: {ACTION_LABEL[c.proposal.suggested]}</span> — {c.proposal.rationale}
                  </p>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <ResolveButton primary={c.proposal?.suggested === "supersede_a"} disabled={busy === c.id} onClick={() => resolve(c.id, "supersede_a")}>
                    Keep first
                  </ResolveButton>
                  <ResolveButton primary={c.proposal?.suggested === "supersede_b"} disabled={busy === c.id} onClick={() => resolve(c.id, "supersede_b")}>
                    Keep second
                  </ResolveButton>
                  <ResolveButton primary={c.proposal?.suggested === "keep_both"} disabled={busy === c.id} onClick={() => resolve(c.id, "keep_both")}>
                    Keep both
                  </ResolveButton>
                  <ResolveButton primary={false} disabled={busy === c.id} onClick={() => resolve(c.id, "context_specific")}>
                    Context-specific
                  </ResolveButton>
                </div>
              </div>
            );
          })
        )}
      </div>
      )}
    </Page>
  );
}

function TabButton({
  children,
  active,
  count,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative -mb-px flex items-center gap-2 px-3 py-2.5 text-sm transition-colors",
        active ? "text-paper" : "text-faded hover:text-paper",
      )}
    >
      {children}
      {count > 0 && (
        <span className="rounded-full bg-line px-1.5 text-[11px] tabular-nums text-faded">{count}</span>
      )}
      {active && <span className="absolute inset-x-0 -bottom-px h-px bg-lamp" />}
    </button>
  );
}

function Claim({ text, highlighted }: { text: string; highlighted: boolean }) {
  return (
    <div
      className={
        "rounded-md border p-3 text-sm " +
        (highlighted ? "border-lamp-dim bg-lamp/5 text-paper" : "border-line bg-transparent text-faded")
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
