import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { api, type InboxItem } from "../api.js";

const STATUS_COLORS: Record<string, string> = {
  queued: "text-dim border-line",
  parsing: "text-lamp border-lamp-dim",
  extracting: "text-lamp border-lamp-dim",
  merging: "text-lamp border-lamp-dim",
  done: "text-moss border-moss/40",
  failed: "text-ember border-ember/40",
  unsupported: "text-ember border-ember/40",
};

const ACTIVE_STATUSES = new Set(["queued", "parsing", "extracting", "merging"]);

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
          <ul className="divide-y divide-line border-y border-line">
            {items.map((item) => (
              <li key={item.id} className="flex items-baseline gap-4 py-3">
                <Badge
                  variant="outline"
                  className={cn(
                    "w-24 shrink-0 justify-center rounded font-mono text-[10px] uppercase tracking-wide",
                    STATUS_COLORS[item.status] ?? "text-dim border-line",
                    ACTIVE_STATUSES.has(item.status) && "working-dot",
                  )}
                >
                  {item.status}
                </Badge>
                <div className="min-w-0">
                  <p className="truncate text-sm text-paper">{item.title}</p>
                  {item.detail && <p className="mt-0.5 truncate text-[13px] text-dim">{item.detail}</p>}
                </div>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-dim">
                  {new Date(item.created_at + "Z").toLocaleTimeString()}
                </span>
              </li>
            ))}
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
