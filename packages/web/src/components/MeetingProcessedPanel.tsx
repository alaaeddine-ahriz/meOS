import { Check, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { MeetingDetail, MeetingLink, MeetingObservation } from "../api.js";

/**
 * The "processed" half of a meeting note: the auto-suggested entity links (each
 * reviewable) and the structure mined from the body — decisions, action items,
 * risks, and open questions. Lifted out of the old MeetingsView so the unified
 * note editor can show it beneath a meeting's body without duplicating the
 * meeting form (which the editor + properties panel now replace).
 */
export function MeetingProcessedPanel({
  detail,
  busy,
  onReprocess,
  onReviewLink,
}: {
  detail: MeetingDetail;
  busy: boolean;
  onReprocess: () => void;
  onReviewLink: (link: MeetingLink, status: "accepted" | "rejected") => void;
}) {
  return (
    <div className="border-t border-line px-6 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.2em] text-dim">Extracted</h3>
        <button
          onClick={onReprocess}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-faded transition-colors hover:bg-card/50 hover:text-paper disabled:opacity-50"
          title="Re-run extraction over the current note"
        >
          <RefreshCw className={cn("size-3.5", busy && "animate-spin")} /> Reprocess
        </button>
      </div>

      {/* Suggested links */}
      <section className="mb-5">
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">
          Suggested links
        </h4>
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ObservationGroup title="Decisions" items={detail.decisions} />
        <ObservationGroup title="Action items" items={detail.actionItems} />
        <ObservationGroup title="Risks" items={detail.risks} />
        <ObservationGroup title="Open questions" items={detail.openQuestions} />
      </div>
    </div>
  );
}

function ObservationGroup({ title, items }: { title: string; items: MeetingObservation[] }) {
  return (
    <section className="rounded-md border border-line bg-card/30 p-3">
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">
        {title}
        <span className="ml-1.5 text-dim/60">{items.length}</span>
      </h4>
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
