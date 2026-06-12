import { FolderPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isTauri } from "@/lib/platform";
import { api, type WatchedFolder } from "../api.js";

export function SettingsView() {
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.listFolders().then((r) => setFolders(r.folders)).catch(() => {});

  useEffect(() => {
    refresh();
  }, []);

  const add = async (path: string) => {
    if (!path.trim()) return;
    setError(null);
    try {
      await api.addFolder(path.trim());
      setManualPath("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Native folder picker in the desktop app; in a browser the user types a path.
  const pickFolder = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selection = await open({ directory: true, multiple: false, title: "Watch a folder" });
    if (typeof selection === "string") await add(selection);
  };

  const remove = async (id: number) => {
    await api.removeFolder(id).catch(() => {});
    refresh();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <header className="rise">
          <h2 className="font-serif text-3xl text-paper">Settings</h2>
          <p className="mt-1 text-sm text-dim">How MeOS sees your world.</p>
        </header>

        <section className="rise rise-1 mt-10">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-dim">watched folders</h3>
          <p className="mt-2 text-sm text-faded">
            Everything readable in these folders is absorbed automatically — new files and edits alike.
            Your files are never moved or modified.
          </p>

          <ul className="mt-5 divide-y divide-line border-y border-line">
            {folders.map((folder) => (
              <li key={folder.id} className="group flex items-center gap-3 py-2.5">
                <span className="truncate font-mono text-[13px] text-paper">{folder.path}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void remove(folder.id)}
                  className="ml-auto text-dim opacity-0 transition-opacity hover:bg-transparent hover:text-ember group-hover:opacity-100"
                  aria-label={`Stop watching ${folder.path}`}
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
            {folders.length === 0 && (
              <li className="py-5 text-sm text-dim">No folders yet — add one and MeOS starts reading.</li>
            )}
          </ul>

          <div className="mt-5 flex items-center gap-3">
            {isTauri ? (
              <Button
                variant="outline"
                onClick={() => void pickFolder()}
                className="border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper"
              >
                <FolderPlus className="size-4" />
                Add folder…
              </Button>
            ) : (
              <>
                <Input
                  value={manualPath}
                  onChange={(event) => setManualPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void add(manualPath);
                  }}
                  placeholder="/Users/you/Documents/notes"
                  className="border-line bg-transparent font-mono text-[13px] text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0"
                />
                <Button
                  variant="outline"
                  onClick={() => void add(manualPath)}
                  disabled={!manualPath.trim()}
                  className="shrink-0 border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper"
                >
                  Add
                </Button>
              </>
            )}
          </div>
          {error && <p className="mt-3 text-sm text-ember">⚠ {error}</p>}
          <p className="mt-4 font-mono text-[11px] text-dim">
            reads .md .txt .csv .json .org .pdf .docx — everything else is left alone
          </p>
        </section>
      </div>
    </div>
  );
}
