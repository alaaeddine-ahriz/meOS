import {
  Activity,
  Database,
  Library,
  type LucideIcon,
  MessageSquare,
  Search,
  Settings,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { Kbd } from "@/components/ui/kbd";
import { CommandPalette } from "./components/CommandPalette.js";
import { useInbox } from "./lib/inbox-context.js";
import { isTauri } from "./lib/platform.js";
import { cn } from "./lib/utils.js";
import { ActivityHub } from "./views/ActivityHub.js";
import { ChangesView } from "./views/ChangesView.js";
import { ChatView } from "./views/ChatView.js";
import { SettingsView } from "./views/SettingsView.js";
import { SourcePageView, SourcesView } from "./views/SourcesView.js";
import { WikiPageView } from "./views/WikiPage.js";
import { WikiView } from "./views/WikiView.js";

// Notes/meeting feature deprecated — its nav entry was removed. Routes below
// redirect to Chat; the implementation is retained in views/VaultView.tsx.
const NAV: Array<{ to: string; label: string; key: string; icon: LucideIcon }> = [
  { to: "/", label: "Chat", key: "1", icon: MessageSquare },
  { to: "/wiki", label: "Wiki", key: "2", icon: Library },
  { to: "/sources", label: "Sources", key: "3", icon: Database },
  { to: "/activity", label: "Activity", key: "4", icon: Activity },
];

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
    isActive ? "bg-card text-paper" : "text-faded hover:bg-card/50 hover:text-paper",
  );

export function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { queuePending } = useInbox();
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

  return (
    <div className="flex h-full">
      {/* under the overlay titlebar the window is dragged from this strip */}
      {isTauri && <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 h-7" />}

      <aside
        className={cn(
          "flex w-52 shrink-0 flex-col border-r border-line bg-desk/60 px-5 py-6",
          isTauri && "pt-10",
        )}
      >
        <nav className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className={navLinkClass}>
              <item.icon className="size-4 shrink-0 opacity-70" />
              <span>{item.label}</span>
              {item.to === "/activity" && queuePending > 0 && (
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
            <Kbd className="ml-auto bg-transparent text-[10px] text-dim opacity-0 transition-opacity group-hover:opacity-100">
              ⌘K
            </Kbd>
          </button>
          <NavLink to="/settings" className={navLinkClass}>
            <Settings className="size-4 shrink-0 opacity-70" />
            <span>Settings</span>
            <Kbd className="ml-auto bg-transparent text-[10px] text-dim opacity-0 transition-opacity group-hover:opacity-100">
              ⌘,
            </Kbd>
          </NavLink>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <Routes>
          <Route path="/" element={<ChatView />} />
          {/* Notes/meeting feature deprecated — redirect to Chat. Code kept in VaultView. */}
          <Route path="/notes" element={<Navigate to="/" replace />} />
          <Route path="/meetings" element={<Navigate to="/" replace />} />
          <Route path="/meetings/:id" element={<Navigate to="/" replace />} />
          <Route path="/wiki" element={<WikiView />} />
          <Route path="/wiki/:slug" element={<WikiPageView />} />
          <Route path="/sources" element={<SourcesView />} />
          <Route path="/sources/:id" element={<SourcePageView />} />
          <Route path="/activity" element={<ActivityHub />} />
          <Route path="/changes/:sourceId" element={<ChangesView />} />
          <Route path="/settings" element={<SettingsView />} />
          {/* Old standalone routes now live inside their consolidated surface. */}
          <Route path="/graph" element={<Navigate to="/wiki?view=graph" replace />} />
          <Route path="/inbox" element={<Navigate to="/activity?tab=feed" replace />} />
          <Route path="/digest" element={<Navigate to="/activity?tab=digest" replace />} />
          <Route path="/contradictions" element={<Navigate to="/activity?tab=review" replace />} />
        </Routes>
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
