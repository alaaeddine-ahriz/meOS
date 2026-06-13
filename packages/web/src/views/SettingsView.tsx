import { Check, Cloud, FolderPlus, GitBranch, Laptop, Moon, RefreshCw, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isTauri } from "@/lib/platform";
import { setTheme, storedTheme, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { api, type GitStatus, type LlmProvider, type LlmSettings, type WatchedFolder } from "../api.js";

const THEMES: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
];

const PROVIDERS: Array<{ value: LlmProvider; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google" },
  { value: "ollama", label: "Ollama (local)" },
];

const KEY_PLACEHOLDERS: Record<string, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
  google: "AIza…",
};

export function SettingsView() {
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [theme, setThemeState] = useState<ThemePreference>(storedTheme());

  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [provider, setProvider] = useState<LlmProvider>("anthropic");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmSaved, setLlmSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const chooseTheme = (preference: ThemePreference) => {
    setTheme(preference);
    setThemeState(preference);
  };

  const refresh = () => api.listFolders().then((r) => setFolders(r.folders)).catch(() => {});

  const applyLlm = (settings: LlmSettings, nextProvider?: LlmProvider) => {
    const active = nextProvider ?? settings.provider;
    setLlm(settings);
    setProvider(active);
    setModel(settings.providers[active].model);
    setBaseUrl(settings.providers.ollama.baseUrl);
  };

  useEffect(() => {
    refresh();
    api
      .getLlmSettings()
      .then((s) => applyLlm(s))
      .catch((e) => setLlmError(e instanceof Error ? e.message : String(e)));
  }, []);

  const chooseProvider = (next: LlmProvider) => {
    setLlmError(null);
    setLlmSaved(false);
    setApiKey("");
    if (llm) applyLlm(llm, next);
    else setProvider(next);
  };

  const saveLlm = async () => {
    setSaving(true);
    setLlmError(null);
    setLlmSaved(false);
    try {
      const updated = await api.updateLlmSettings({
        provider,
        model: model || undefined,
        apiKey: apiKey.trim() || undefined,
        baseUrl: provider === "ollama" ? baseUrl.trim() || undefined : undefined,
      });
      applyLlm(updated, provider);
      setApiKey("");
      setLlmSaved(true);
    } catch (e) {
      setLlmError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

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

  const cloudProvider = provider !== "ollama";
  const keySaved = cloudProvider && llm ? llm.providers[provider as "anthropic" | "openai" | "google"].hasKey : false;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <header className="rise">
          <h2 className="font-serif text-3xl text-paper">Settings</h2>
          <p className="mt-1 text-sm text-dim">How MeOS sees your world.</p>
        </header>

        <section className="rise rise-1 mt-10">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-dim">appearance</h3>
          <div className="mt-4 flex gap-2">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <Button
                key={value}
                variant="outline"
                size="sm"
                onClick={() => chooseTheme(value)}
                className={cn(
                  "border-line bg-transparent text-faded hover:bg-transparent hover:text-paper",
                  theme === value && "border-lamp-dim text-paper",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </Button>
            ))}
          </div>
        </section>

        <section className="rise rise-2 mt-10">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-dim">intelligence</h3>
          <p className="mt-2 text-sm text-faded">
            The model that reads your documents, maintains the wiki, and answers your questions.
            API keys stay on this machine.
          </p>

          {!llm && !llmError && <p className="mt-4 text-sm text-dim">Loading…</p>}

          {llm && (
            <>
          <div className="mt-4 flex gap-2">
            {PROVIDERS.map(({ value, label }) => (
              <Button
                key={value}
                variant="outline"
                size="sm"
                onClick={() => chooseProvider(value)}
                className={cn(
                  "border-line bg-transparent text-faded hover:bg-transparent hover:text-paper",
                  provider === value && "border-lamp-dim text-paper",
                )}
              >
                {label}
              </Button>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-3">
            {cloudProvider && llm ? (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-full border-line bg-transparent font-mono text-[13px] text-paper focus-visible:border-lamp-dim focus-visible:ring-0">
                  <SelectValue placeholder="Choose a model" />
                </SelectTrigger>
                <SelectContent>
                  {llm.models[provider as "anthropic" | "openai" | "google"].map((m) => (
                    <SelectItem key={m} value={m} className="font-mono text-[13px]">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <>
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="llama3.1"
                  className="border-line bg-transparent font-mono text-[13px] text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0"
                />
                <Input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://localhost:11434"
                  className="border-line bg-transparent font-mono text-[13px] text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0"
                />
              </>
            )}

            {cloudProvider && (
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={keySaved ? "API key saved — paste to replace" : KEY_PLACEHOLDERS[provider]}
                autoComplete="off"
                className="border-line bg-transparent font-mono text-[13px] text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0"
              />
            )}

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => void saveLlm()}
                disabled={saving || (cloudProvider && !keySaved && !apiKey.trim())}
                className="shrink-0 border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper"
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              {llmSaved && (
                <span className="flex items-center gap-1.5 text-sm text-moss">
                  <Check className="size-3.5" /> using {provider === "ollama" ? model || "ollama" : model}
                </span>
              )}
            </div>
          </div>
            </>
          )}
          {llmError && <p className="mt-3 text-sm text-ember">⚠ {llmError}</p>}
        </section>

        <section className="rise rise-3 mt-10">
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
            reads .md .txt .csv .json .org .pdf .docx .png .jpg .gif .webp — everything else is left alone
          </p>
        </section>

        <GitSyncSection />
      </div>
    </div>
  );
}

function GitSyncSection() {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [remote, setRemote] = useState("");
  const [busy, setBusy] = useState<null | "init" | "remote" | "sync">(null);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);

  const apply = (next: GitStatus) => {
    setStatus(next);
    setRemote(next.remote ?? "");
  };

  useEffect(() => {
    api.getGitStatus().then(apply).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const wrap = (key: "init" | "remote" | "sync", run: () => Promise<GitStatus>) => async () => {
    setBusy(key);
    setError(null);
    setSynced(false);
    try {
      apply(await run());
      if (key === "sync") setSynced(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleAuto = async () => {
    if (!status) return;
    const next = !status.autoSync;
    setStatus({ ...status, autoSync: next });
    await api.setGitAutoSync(next).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <section className="rise rise-3 mt-10">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-dim">sync</h3>
      <p className="mt-2 text-sm text-faded">
        Version your wiki and digests as a Git repository — a portable, human-readable backup you can
        push to GitHub. The database itself stays local; only the markdown is synced.
      </p>

      {!status && !error && <p className="mt-4 text-sm text-dim">Loading…</p>}

      {status && !status.initialized && (
        <Button
          variant="outline"
          onClick={wrap("init", api.initGit)}
          disabled={busy === "init"}
          className="mt-4 border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper"
        >
          <GitBranch className="size-4" />
          {busy === "init" ? "Setting up…" : "Enable Git sync"}
        </Button>
      )}

      {status?.initialized && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12px] text-faded">
            <span className="flex items-center gap-1.5 text-paper">
              <GitBranch className="size-3.5 text-dim" />
              {status.branch ?? "main"}
            </span>
            {status.dirty > 0 && <span className="text-lamp">{status.dirty} uncommitted</span>}
            {status.ahead ? <span>↑{status.ahead}</span> : null}
            {status.behind ? <span>↓{status.behind}</span> : null}
            {status.dirty === 0 && !status.ahead && !status.behind && (
              <span className="text-moss">up to date</span>
            )}
          </div>
          {status.lastCommit && <p className="font-mono text-[11px] text-dim">{status.lastCommit}</p>}

          <div className="flex items-center gap-3">
            <Input
              value={remote}
              onChange={(event) => setRemote(event.target.value)}
              placeholder="git@github.com:you/second-brain.git"
              className="border-line bg-transparent font-mono text-[13px] text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0"
            />
            <Button
              variant="outline"
              onClick={wrap("remote", () => api.setGitRemote(remote.trim()))}
              disabled={busy === "remote" || !remote.trim() || remote.trim() === (status.remote ?? "")}
              className="shrink-0 border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper"
            >
              {busy === "remote" ? "Saving…" : "Save remote"}
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={wrap("sync", () => api.gitSync())}
              disabled={busy === "sync"}
              className="shrink-0 border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper"
            >
              <RefreshCw className={cn("size-4", busy === "sync" && "animate-spin")} />
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </Button>
            <button
              onClick={() => void toggleAuto()}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                status.autoSync ? "text-paper" : "text-dim hover:text-faded",
              )}
            >
              <Cloud className={cn("size-4", status.autoSync ? "text-lamp" : "text-dim")} />
              Auto-sync nightly
              {status.autoSync && <Check className="size-3.5 text-moss" />}
            </button>
            {synced && (
              <span className="flex items-center gap-1.5 text-sm text-moss">
                <Check className="size-3.5" /> synced
              </span>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-ember">⚠ {error}</p>}
    </section>
  );
}
