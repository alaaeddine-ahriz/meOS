import { GitCompareArrows, Inbox, Library, type LucideIcon, MessageSquare, Newspaper, Search, Settings, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { Kbd } from "@/components/ui/kbd";
import { api } from "./api.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { isTauri } from "./lib/platform.js";
import { cn } from "./lib/utils.js";
import { ChangesView } from "./views/ChangesView.js";
import { ChatView } from "./views/ChatView.js";
import { ContradictionsView } from "./views/ContradictionsView.js";
import { DigestView } from "./views/DigestView.js";
import { GraphView } from "./views/GraphView.js";
import { InboxView } from "./views/InboxView.js";
import { SettingsView } from "./views/SettingsView.js";
import { WikiPageView } from "./views/WikiPage.js";
import { WikiView } from "./views/WikiView.js";

const NAV: Array<{ to: string; label: string; key: string; icon: LucideIcon }> = [
  { to: "/", label: "Chat", key: "1", icon: MessageSquare },
  { to: "/wiki", label: "Wiki", key: "2", icon: Library },
  { to: "/graph", label: "Graph", key: "3", icon: Waypoints },
  { to: "/inbox", label: "Inbox", key: "4", icon: Inbox },
  { to: "/digest", label: "Digest", key: "5", icon: Newspaper },
  { to: "/contradictions", label: "Conflicts", key: "6", icon: GitCompareArrows },
];

export function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
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

        <nav className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                  isActive ? "bg-card text-paper" : "text-faded hover:bg-card/50 hover:text-paper",
                )
              }
            >
              <item.icon className="size-4 shrink-0 opacity-70" />
              <span>{item.label}</span>
              {item.to === "/inbox" && queuePending > 0 && (
                <span
                  className="working-dot inline-block h-1.5 w-1.5 rounded-full bg-lamp"
                  title={`absorbing ${queuePending} item${queuePending > 1 ? "s" : ""}`}
                />
              )}
              <Kbd className="ml-auto bg-transparent text-[10px] text-dim opacity-0 transition-opacity group-hover:opacity-100">
                ⌘{item.key}
              </Kbd>
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-0.5">
          <button
            onClick={() => setPaletteOpen(true)}
            className="group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-faded transition-colors hover:bg-card/50 hover:text-paper"
          >
            <Search className="size-4 shrink-0 opacity-70" />
            <span>Jump to…</span>
            <Kbd className="ml-auto bg-transparent text-[10px] text-dim opacity-0 transition-opacity group-hover:opacity-100">⌘K</Kbd>
          </button>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                isActive ? "bg-card text-paper" : "text-faded hover:bg-card/50 hover:text-paper",
              )
            }
          >
            <Settings className="size-4 shrink-0 opacity-70" />
            <span>Settings</span>
            <Kbd className="ml-auto bg-transparent text-[10px] text-dim opacity-0 transition-opacity group-hover:opacity-100">⌘,</Kbd>
          </NavLink>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <Routes>
          <Route path="/" element={<ChatView />} />
          <Route path="/wiki" element={<WikiView />} />
          <Route path="/wiki/:slug" element={<WikiPageView />} />
          <Route path="/graph" element={<GraphView />} />
          <Route path="/inbox" element={<InboxView />} />
          <Route path="/changes/:sourceId" element={<ChangesView />} />
          <Route path="/digest" element={<DigestView />} />
          <Route path="/contradictions" element={<ContradictionsView />} />
          <Route path="/settings" element={<SettingsView />} />
        </Routes>
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
