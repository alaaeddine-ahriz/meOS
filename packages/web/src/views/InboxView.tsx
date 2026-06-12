import { useEffect, useRef, useState } from "react";
import { api, type InboxItem } from "../api.js";

const STATUS_COLORS: Record<string, string> = {
  queued: "text-dim",
  parsing: "text-lamp",
  extracting: "text-lamp",
  merging: "text-lamp",
  done: "text-moss",
  failed: "text-ember",
  unsupported: "text-ember",
};

const ACTIVE_STATUSES = new Set(["queued", "parsing", "extracting", "merging"]);

export function InboxView() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [queuePending, setQueuePending] = useState(0);
  const [captureText, setCaptureText] = useState("");
  const [captureTitle, setCaptureTitle] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const result = await api.uploadFiles(files);
    setNotice(`${result.accepted.length} file(s) accepted.`);
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
          <input
            value={captureTitle}
            onChange={(event) => setCaptureTitle(event.target.value)}
            placeholder="Title (optional)"
            className="mt-3 w-full rounded-md border border-line bg-transparent px-3 py-2 text-sm text-paper outline-none placeholder:text-dim focus:border-lamp-dim"
          />
          <textarea
            value={captureText}
            onChange={(event) => setCaptureText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void capture();
            }}
            rows={3}
            placeholder="A thought, meeting note, or draft. ⌘↵ to capture."
            className="mt-2 w-full resize-y rounded-md border border-line bg-transparent px-3 py-2 text-sm text-paper outline-none placeholder:text-dim focus:border-lamp-dim"
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => void capture()}
              disabled={!captureText.trim()}
              className="rounded-lg bg-lamp px-4 py-1.5 text-sm font-medium text-ink transition-opacity disabled:opacity-30"
            >
              Capture
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg border border-line px-4 py-1.5 text-sm text-faded transition-colors hover:border-lamp-dim hover:text-paper"
            >
              Upload files…
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept=".md,.markdown,.txt,.text,.csv,.json,.org,.pdf,.docx"
              onChange={(event) => void upload(event.target.files)}
            />
            {notice && <span className="text-sm text-moss">{notice}</span>}
          </div>
          <p className="mt-3 font-mono text-[11px] text-dim">
            Files dropped into <span className="text-faded">data/inbox/watch/</span> are ingested automatically.
          </p>
        </section>

        <section className="rise rise-2 mt-8">
          <ul className="divide-y divide-line border-y border-line">
            {items.map((item) => (
              <li key={item.id} className="flex items-baseline gap-4 py-3">
                <span
                  className={`w-24 shrink-0 font-mono text-[11px] uppercase tracking-wide ${STATUS_COLORS[item.status] ?? "text-dim"} ${ACTIVE_STATUSES.has(item.status) ? "working-dot" : ""}`}
                >
                  {item.status}
                </span>
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
