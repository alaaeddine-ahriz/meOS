import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { api, type InboxItem } from "../api.js";

const DOT_COLORS: Record<string, string> = {
  queued: "bg-dim",
  parsing: "bg-lamp",
  extracting: "bg-lamp",
  merging: "bg-lamp",
  done: "bg-moss",
  failed: "bg-ember",
  unsupported: "bg-dim",
};

const ACTIVE_STATUSES = new Set(["queued", "parsing", "extracting", "merging"]);

function timeOf(item: InboxItem): string {
  return new Date(item.created_at + "Z").toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function InboxView() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [queuePending, setQueuePending] = useState(0);

  useEffect(() => {
    const refresh = () =>
      api
        .getInbox()
        .then((r) => {
          setItems(r.items);
          setQueuePending(r.queuePending);
        })
        .catch(() => {});
    refresh();
    const interval = setInterval(refresh, 2500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <header className="rise flex items-baseline justify-between">
          <div>
            <h2 className="font-serif text-3xl text-paper">Inbox</h2>
            <p className="mt-1 text-sm text-dim">What came in, and what the system did with it.</p>
          </div>
          {queuePending > 0 && (
            <span className="flex items-center gap-2 font-mono text-[11px] text-faded">
              <span className="working-dot h-1.5 w-1.5 rounded-full bg-lamp" />
              {queuePending} in queue
            </span>
          )}
        </header>

        <section className="rise rise-1 mt-8">
          <ul className="divide-y divide-line">
            {items.map((item) => {
              const muted = item.status === "unsupported";
              return (
                <li key={item.id} className={cn("flex items-baseline gap-3 py-3", muted && "opacity-50")}>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full",
                      DOT_COLORS[item.status] ?? "bg-dim",
                      ACTIVE_STATUSES.has(item.status) && "working-dot",
                    )}
                    title={item.status}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-paper">{item.title}</p>
                    {item.detail && <p className="mt-0.5 truncate text-[13px] text-dim">{item.detail}</p>}
                  </div>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-dim">{timeOf(item)}</span>
                </li>
              );
            })}
            {items.length === 0 && (
              <li className="py-6 text-sm text-dim">
                Nothing yet. Capture a thought with <Kbd className="text-dim">⌘J</Kbd> or add{" "}
                <Link to="/settings" className="text-faded hover:text-paper">watched folders</Link>.
              </li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
