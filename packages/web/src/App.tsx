import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { Kbd } from "@/components/ui/kbd";
import { api } from "./api.js";
import { CaptureDialog } from "./components/CaptureDialog.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { isTauri } from "./lib/platform.js";
import { cn } from "./lib/utils.js";
import { ChatView } from "./views/ChatView.js";
import { DigestView } from "./views/DigestView.js";
import { InboxView } from "./views/InboxView.js";
import { SettingsView } from "./views/SettingsView.js";
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
  const [captureOpen, setCaptureOpen] = useState(false);
  const [queuePending, setQueuePending] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const nav = NAV.find((n) => n.key === event.key);
      if (nav) {
        event.preventDefault();
        navigate(nav.to);
      } else if (event.key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === "j") {
        event.preventDefault();
        setCaptureOpen((open) => !open);
      } else if (event.key === ",") {
        event.preventDefault();
        navigate("/settings");
      }
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
      {/* under the overlay titlebar the window is dragged from this strip */}
      {isTauri && <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 h-7" />}

      <aside className={cn("flex w-52 shrink-0 flex-col border-r border-line bg-desk/60 px-5 py-6", isTauri && "pt-10")}>
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
                cn(
                  "flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors",
                  isActive ? "bg-card text-paper" : "text-faded hover:bg-card/60 hover:text-paper",
                )
              }
            >
              <span>{item.label}</span>
              <Kbd className="bg-transparent text-[10px] text-dim">⌘{item.key}</Kbd>
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-1">
          {queuePending > 0 && (
            <p className="mb-2 flex items-center gap-2 px-3 font-mono text-[11px] text-faded">
              <span className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-lamp" />
              absorbing {queuePending} item{queuePending > 1 ? "s" : ""}
            </p>
          )}
          <button
            onClick={() => setCaptureOpen(true)}
            className="flex items-center justify-between rounded-md px-3 py-1.5 text-sm text-faded transition-colors hover:bg-card/60 hover:text-paper"
          >
            <span>Capture</span>
            <Kbd className="bg-transparent text-[10px] text-dim">⌘J</Kbd>
          </button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex items-center justify-between rounded-md px-3 py-1.5 text-sm text-faded transition-colors hover:bg-card/60 hover:text-paper"
          >
            <span>Jump to…</span>
            <Kbd className="bg-transparent text-[10px] text-dim">⌘K</Kbd>
          </button>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                "flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors",
                isActive ? "bg-card text-paper" : "text-faded hover:bg-card/60 hover:text-paper",
              )
            }
          >
            <span>Settings</span>
            <Kbd className="bg-transparent text-[10px] text-dim">⌘,</Kbd>
          </NavLink>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <Routes>
          <Route path="/" element={<ChatView />} />
          <Route path="/wiki" element={<WikiView />} />
          <Route path="/wiki/:slug" element={<WikiPageView />} />
          <Route path="/inbox" element={<InboxView />} />
          <Route path="/digest" element={<DigestView />} />
          <Route path="/settings" element={<SettingsView />} />
        </Routes>
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onCapture={() => setCaptureOpen(true)} />
      <CaptureDialog open={captureOpen} onOpenChange={setCaptureOpen} />
    </div>
  );
}
