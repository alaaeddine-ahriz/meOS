import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./api.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ChatView } from "./views/ChatView.js";
import { DigestView } from "./views/DigestView.js";
import { InboxView } from "./views/InboxView.js";
import { WikiPageView } from "./views/WikiPage.js";
import { WikiView } from "./views/WikiView.js";

const NAV = [
  { to: "/", label: "Chat", key: "1" },
  { to: "/wiki", label: "Wiki", key: "2" },
  { to: "/inbox", label: "Inbox", key: "3" },
  { to: "/digest", label: "Digest", key: "4" },
];

export function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [queuePending, setQueuePending] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if ((event.metaKey || event.ctrlKey) && NAV.some((n) => n.key === event.key)) {
        event.preventDefault();
        navigate(NAV.find((n) => n.key === event.key)!.to);
      }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  useEffect(() => {
    const poll = () => api.getInbox().then((r) => setQueuePending(r.queuePending)).catch(() => {});
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-desk/60 px-5 py-6">
        <h1 className="font-serif text-2xl italic tracking-tight text-paper">
          Me<span className="text-lamp">OS</span>
        </h1>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">second brain</p>

        <nav className="mt-10 flex flex-col gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex items-baseline justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive ? "bg-card text-paper" : "text-faded hover:bg-card/60 hover:text-paper"
                }`
              }
            >
              <span>{item.label}</span>
              <kbd className="font-mono text-[10px] text-dim">⌘{item.key}</kbd>
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto space-y-3">
          {queuePending > 0 && (
            <p className="flex items-center gap-2 font-mono text-[11px] text-faded">
              <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-lamp" />
              processing {queuePending} item{queuePending > 1 ? "s" : ""}
            </p>
          )}
          <button
            onClick={() => setPaletteOpen(true)}
            className="w-full rounded-md border border-line px-3 py-1.5 text-left font-mono text-[11px] text-dim transition-colors hover:border-lamp-dim hover:text-faded"
          >
            ⌘K — jump anywhere
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <Routes>
          <Route path="/" element={<ChatView />} />
          <Route path="/wiki" element={<WikiView />} />
          <Route path="/wiki/:slug" element={<WikiPageView />} />
          <Route path="/inbox" element={<InboxView />} />
          <Route path="/digest" element={<DigestView />} />
        </Routes>
      </main>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
