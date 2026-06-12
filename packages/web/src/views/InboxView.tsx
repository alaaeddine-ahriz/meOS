import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  const [captureText, setCaptureText] = useState("");
  const [captureTitle, setCaptureTitle] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () =>
    api
      .getInbox()
      .then((r) => {
        setItems(r.items);
        setQueuePending(r.queuePending);
      })
      .catch(() => {});

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2500);
    return () => clearInterval(interval);
  }, []);

  const capture = async () => {
    if (!captureText.trim()) return;
    await api.ingestText(captureTitle.trim(), captureText);
    setCaptureText("");
    setCaptureTitle("");
    setNotice("Captured. Processing in the background.");
    setTimeout(() => setNotice(null), 4000);
    refresh();
  };

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

        <section className="rise rise-1 mt-8 rounded-xl border border-line bg-desk p-5">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-dim">quick capture</h3>
          <Input
            value={captureTitle}
            onChange={(event) => setCaptureTitle(event.target.value)}
            placeholder="Title (optional)"
            className="mt-3 border-line bg-transparent text-sm text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0"
          />
          <Textarea
            value={captureText}
            onChange={(event) => setCaptureText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void capture();
            }}
            rows={3}
            placeholder="A thought, meeting note, or draft. ⌘↵ to capture."
            className="mt-2 resize-y border-line bg-transparent text-sm text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0"
          />
          <div className="mt-3 flex items-center gap-3">
            <Button
              onClick={() => void capture()}
              disabled={!captureText.trim()}
              className="bg-lamp text-ink hover:bg-lamp/85"
            >
              Capture
            </Button>
            {notice && <span className="text-sm text-moss">{notice}</span>}
            <span className="ml-auto font-mono text-[11px] text-dim">
              files arrive via <Link to="/settings" className="text-faded hover:text-paper">watched folders</Link>
            </span>
          </div>
        </section>

        <section className="rise rise-2 mt-8">
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
            {items.length === 0 && <li className="py-6 text-sm text-dim">Nothing has come in yet.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
