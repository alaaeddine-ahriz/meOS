import {
  AlertTriangle,
  Check,
  ChevronRight,
  Cloud,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  Laptop,
  type LucideIcon,
  Moon,
  Palette as PaletteIcon,
  RefreshCw,
  Sparkles,
  Sun,
  Trash2,
  UserCircle,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Page, PageHeader } from "@/components/Page";
import { Button } from "@/components/ui/button";
import { DiffView } from "@/components/DiffView";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isTauri } from "@/lib/platform";
import { ProfileSection } from "./ProfileSection";
import {
  type Density,
  type FontPreset,
  type Palette,
  setDensity,
  setFont,
  setPalette,
  setTheme,
  storedDensity,
  storedFont,
  storedPalette,
  storedTheme,
  type ThemePreference,
} from "@/lib/theme";
import { cn } from "@/lib/utils";
import { api, type GitCommit, type GitStatus, type LlmProvider, type LlmSettings, type WatchedFolder } from "../api.js";

const THEMES: Array<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
];

const PALETTES: Array<{ value: Palette; label: string }> = [
  { value: "warm", label: "Warm" },
  { value: "neutral", label: "Neutral" },
  { value: "cool", label: "Cool" },
];

const FONTS: Array<{ value: FontPreset; label: string }> = [
  { value: "editorial", label: "Editorial" },
  { value: "clean", label: "Clean" },
  { value: "literary", label: "Literary" },
  { value: "mono", label: "Mono" },
];

const DENSITIES: Array<{ value: Density; label: string }> = [
  { value: "spaced", label: "Spaced" },
  { value: "compact", label: "Compact" },
];

/** The sections of Settings, surfaced as in-page tabs so each panel stays focused. */
const TABS = [
  { id: "profile", label: "Profile", icon: UserCircle },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "intelligence", label: "Intelligence", icon: Sparkles },
  { id: "folders", label: "Folders", icon: FolderOpen },
  { id: "sync", label: "Sync", icon: GitBranch },
  { id: "reset", label: "Reset", icon: Trash2 },
] as const;

type TabId = (typeof TABS)[number]["id"];

const inputClass =
  "border-line bg-transparent font-mono text-[13px] text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0";

const actionButtonClass =
  "shrink-0 border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper";

/** A labelled row of mutually-exclusive choices, styled like the rest of Settings. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; icon?: LucideIcon }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-faded">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map(({ value: option, label: optionLabel, icon: Icon }) => (
          <Button
            key={option}
            variant="outline"
            size="sm"
            onClick={() => onChange(option)}
            className={cn(
              "border-line bg-transparent text-faded hover:bg-transparent hover:text-paper",
              value === option && "border-lamp-dim text-paper",
            )}
          >
            {Icon && <Icon className="size-3.5" />}
            {optionLabel}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** A panel heading: a short lead-in line above each section's controls. */
function PanelIntro({ children }: { children: ReactNode }) {
  return <p className="text-sm text-faded">{children}</p>;
}

export function SettingsView() {
  const [tab, setTab] = useState<TabId>("profile");

  return (
    <Page>
      <PageHeader title="Settings" description="How MeOS sees your world." />

      <nav className="rise mt-8 flex flex-wrap gap-1 border-b border-line">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "relative -mb-px flex items-center gap-2 px-3 py-2.5 text-sm transition-colors",
                active ? "text-paper" : "text-faded hover:text-paper",
              )}
            >
              <Icon className="size-3.5 opacity-70" />
              {label}
              {active && <span className="absolute inset-x-0 -bottom-px h-px bg-lamp" />}
            </button>
          );
        })}
      </nav>

      <div className="mt-8">
        {tab === "profile" && <ProfileSection />}
        {tab === "appearance" && <AppearanceSection />}
        {tab === "intelligence" && <IntelligenceSection />}
        {tab === "folders" && <FoldersSection />}
        {tab === "sync" && <GitSyncSection />}
        {tab === "reset" && <ResetSection />}
      </div>
    </Page>
  );
}

function AppearanceSection() {
  const [theme, setThemeState] = useState<ThemePreference>(storedTheme());
  const [palette, setPaletteState] = useState<Palette>(storedPalette());
  const [font, setFontState] = useState<FontPreset>(storedFont());
  const [density, setDensityState] = useState<Density>(storedDensity());

  const chooseTheme = (preference: ThemePreference) => {
    setTheme(preference);
    setThemeState(preference);
  };
  const choosePalette = (next: Palette) => {
    setPalette(next);
    setPaletteState(next);
  };
  const chooseFont = (next: FontPreset) => {
    setFont(next);
    setFontState(next);
  };
  const chooseDensity = (next: Density) => {
    setDensity(next);
    setDensityState(next);
  };

  return (
    <section className="rise flex flex-col gap-4">
      <Segmented label="Mode" value={theme} options={THEMES} onChange={chooseTheme} />
      <Segmented label="Palette" value={palette} options={PALETTES} onChange={choosePalette} />
      <Segmented label="Typeface" value={font} options={FONTS} onChange={chooseFont} />
      <Segmented label="Density" value={density} options={DENSITIES} onChange={chooseDensity} />
    </section>
  );
}

const PROVIDERS: Array<{ value: LlmProvider; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google" },
  { value: "local", label: "Local (LM Studio)" },
];

const KEY_PLACEHOLDERS: Record<string, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
  google: "AIza…",
};

function IntelligenceSection() {
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [provider, setProvider] = useState<LlmProvider>("anthropic");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmSaved, setLlmSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // Models discovered on a local OpenAI-compatible server, for the picker.
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [localModelsError, setLocalModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const applyLlm = (settings: LlmSettings, nextProvider?: LlmProvider) => {
    const active = nextProvider ?? settings.provider;
    setLlm(settings);
    setProvider(active);
    setModel(settings.providers[active].model);
    setBaseUrl(settings.providers.local.baseUrl);
  };

  useEffect(() => {
    api
      .getLlmSettings()
      .then((s) => applyLlm(s))
      .catch((e) => setLlmError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Ask the local server what it has loaded so the user picks from a list.
  const refreshLocalModels = async (url: string) => {
    if (!url.trim()) return;
    setLoadingModels(true);
    setLocalModelsError(null);
    try {
      const { models } = await api.listLocalModels(url.trim());
      setLocalModels(models);
      // Default to the first available model when the saved one isn't present.
      if (models.length > 0 && !models.includes(model)) setModel(models[0]!);
    } catch (e) {
      setLocalModels([]);
      setLocalModelsError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingModels(false);
    }
  };

  // Auto-detect models whenever the local provider becomes active.
  useEffect(() => {
    if (provider === "local" && baseUrl) void refreshLocalModels(baseUrl);
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseProvider = (next: LlmProvider) => {
    setLlmError(null);
    setLlmSaved(false);
    setApiKey("");
    setLocalModelsError(null);
    if (next !== "local") setLocalModels([]);
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
        baseUrl: provider === "local" ? baseUrl.trim() || undefined : undefined,
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

  const cloudProvider = provider !== "local";
  const keySaved = cloudProvider && llm ? llm.providers[provider as "anthropic" | "openai" | "google"].hasKey : false;

  return (
    <section className="rise flex flex-col gap-4">
      <PanelIntro>
        The model that reads your documents, maintains the wiki, and answers your questions. API keys
        stay on this machine.
      </PanelIntro>

      {!llm && !llmError && <p className="text-sm text-dim">Loading…</p>}

      {llm && (
        <>
          <div className="flex flex-wrap gap-2">
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

          <div className="flex flex-col gap-3">
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
                <div className="flex items-center gap-2">
                  <Input
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="http://localhost:1234/v1"
                    className={inputClass}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void refreshLocalModels(baseUrl)}
                    disabled={loadingModels || !baseUrl.trim()}
                    className={actionButtonClass}
                  >
                    <RefreshCw className={cn("size-3.5", loadingModels && "animate-spin")} />
                    {loadingModels ? "Detecting…" : "Detect models"}
                  </Button>
                </div>

                {localModels.length > 0 ? (
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="w-full border-line bg-transparent font-mono text-[13px] text-paper focus-visible:border-lamp-dim focus-visible:ring-0">
                      <SelectValue placeholder="Choose a loaded model" />
                    </SelectTrigger>
                    <SelectContent>
                      {localModels.map((m) => (
                        <SelectItem key={m} value={m} className="font-mono text-[13px]">
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="model identifier (e.g. qwen2.5-7b-instruct)"
                    className={inputClass}
                  />
                )}

                <p className="font-mono text-[11px] text-dim">
                  {localModelsError
                    ? `⚠ ${localModelsError}`
                    : localModels.length > 0
                      ? `${localModels.length} model${localModels.length === 1 ? "" : "s"} loaded on the server`
                      : "Any OpenAI-compatible server — LM Studio, llama.cpp, Ollama. Point at its base URL (usually ending in /v1), then Detect models."}
                </p>
              </>
            )}

            {cloudProvider && (
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={keySaved ? "API key saved — paste to replace" : KEY_PLACEHOLDERS[provider]}
                autoComplete="off"
                className={inputClass}
              />
            )}

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => void saveLlm()}
                disabled={saving || (cloudProvider ? !keySaved && !apiKey.trim() : !baseUrl.trim())}
                className={actionButtonClass}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              {llmSaved && (
                <span className="flex items-center gap-1.5 text-sm text-moss">
                  <Check className="size-3.5" /> using {provider === "local" ? model || "local model" : model}
                </span>
              )}
            </div>
          </div>
        </>
      )}
      {llmError && <p className="text-sm text-ember">⚠ {llmError}</p>}
    </section>
  );
}

function FoldersSection() {
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
    setError(null);
    try {
      await api.removeFolder(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };

  return (
    <section className="rise flex flex-col gap-5">
      <PanelIntro>
        Everything readable in these folders is absorbed automatically — new files and edits alike. Your
        files are never moved or modified.
      </PanelIntro>

      <ul className="divide-y divide-line border-y border-line">
        {folders.map((folder) => (
          <li key={folder.id} className="group flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-paper" title={folder.path}>
              {folder.path}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void remove(folder.id)}
              className="shrink-0 text-dim transition-colors hover:bg-transparent hover:text-ember"
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

      <div className="flex items-center gap-3">
        {isTauri ? (
          <Button variant="outline" onClick={() => void pickFolder()} className={actionButtonClass}>
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
              className={inputClass}
            />
            <Button
              variant="outline"
              onClick={() => void add(manualPath)}
              disabled={!manualPath.trim()}
              className={actionButtonClass}
            >
              Add
            </Button>
          </>
        )}
      </div>
      {error && <p className="text-sm text-ember">⚠ {error}</p>}
      <p className="font-mono text-[11px] text-dim">
        reads .md .txt .csv .json .org .pdf .docx .png .jpg .gif .webp — everything else is left alone
      </p>
    </section>
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
    <section className="rise flex flex-col gap-4">
      <PanelIntro>
        Version your wiki and digests as a Git repository — a portable, human-readable backup you can push
        to GitHub. The database itself stays local; only the markdown is synced.
      </PanelIntro>

      {!status && !error && <p className="text-sm text-dim">Loading…</p>}

      {status && !status.initialized && (
        <Button
          variant="outline"
          onClick={wrap("init", api.initGit)}
          disabled={busy === "init"}
          className={cn(actionButtonClass, "self-start")}
        >
          <GitBranch className="size-4" />
          {busy === "init" ? "Setting up…" : "Enable Git sync"}
        </Button>
      )}

      {status?.initialized && (
        <div className="flex flex-col gap-4">
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
              className={inputClass}
            />
            <Button
              variant="outline"
              onClick={wrap("remote", () => api.setGitRemote(remote.trim()))}
              disabled={busy === "remote" || !remote.trim() || remote.trim() === (status.remote ?? "")}
              className={actionButtonClass}
            >
              {busy === "remote" ? "Saving…" : "Save remote"}
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={wrap("sync", () => api.gitSync())}
              disabled={busy === "sync"}
              className={actionButtonClass}
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

          <GitHistory refreshKey={status.lastCommit ?? ""} />
        </div>
      )}

      {error && <p className="text-sm text-ember">⚠ {error}</p>}
    </section>
  );
}

/** The commit "tree": recent commits, each expandable to its diff. */
function GitHistory({ refreshKey }: { refreshKey: string }) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [patch, setPatch] = useState<Record<string, string>>({});

  useEffect(() => {
    api.getGitLog(30).then((r) => setCommits(r.commits)).catch(() => setCommits([]));
  }, [refreshKey]);

  const toggle = async (hash: string) => {
    if (open === hash) {
      setOpen(null);
      return;
    }
    setOpen(hash);
    if (!patch[hash]) {
      const detail = await api.getGitCommit(hash).catch(() => null);
      if (detail) setPatch((prev) => ({ ...prev, [hash]: detail.patch }));
    }
  };

  if (!commits || commits.length === 0) return null;

  return (
    <div className="mt-2 border-t border-line pt-4">
      <h4 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-dim">
        <History className="size-3.5" /> history
      </h4>
      <ul className="mt-3 divide-y divide-line">
        {commits.map((commit) => (
          <li key={commit.hash}>
            <button
              onClick={() => void toggle(commit.hash)}
              className="group flex w-full items-baseline gap-3 py-2 text-left"
            >
              <ChevronRight
                className={cn(
                  "size-3 shrink-0 translate-y-0.5 text-dim transition-transform",
                  open === commit.hash && "rotate-90",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-paper">{commit.subject}</span>
                <span className="font-mono text-[11px] text-dim">
                  {commit.hash} · {commit.relativeDate} · {commit.files} file{commit.files === 1 ? "" : "s"}
                </span>
              </span>
            </button>
            {open === commit.hash && (
              <div className="pb-3 pl-6">
                {patch[commit.hash] ? (
                  <DiffView patch={patch[commit.hash]!} />
                ) : (
                  <p className="text-sm text-dim">Loading diff…</p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Start over: a guarded, irreversible wipe of everything MeOS has learned. */
function ResetSection() {
  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    setConfirming(false);
    setPhrase("");
    setError(null);
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.resetEverything();
      // The wipe touches every view's data; the cleanest way to reflect a blank
      // slate everywhere is a full reload.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <section className="rise flex flex-col gap-4">
      <PanelIntro>
        Start over. This erases everything MeOS has learned — entities, observations, conversations,
        digests, the generated wiki, and its entire Git history — and re-initializes the repository.
        Your watched folders and model settings are kept, so MeOS re-reads them from scratch.
      </PanelIntro>

      <div className="flex flex-col gap-3 rounded-md border border-ember/40 bg-ember/[0.04] p-4">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ember" />
          <div className="flex flex-col gap-1">
            <span className="text-sm text-paper">This cannot be undone</span>
            <span className="text-sm text-dim">
              Your original files on disk are never touched — but everything MeOS derived from them is
              permanently deleted.
            </span>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => setConfirming(true)}
          className="self-start border-ember/50 bg-transparent text-ember hover:border-ember hover:bg-ember/10 hover:text-ember"
        >
          <Trash2 className="size-4" />
          Reset everything…
        </Button>
      </div>

      <Dialog open={confirming} onOpenChange={(open) => (open ? setConfirming(true) : close())}>
        <DialogContent className="border-line">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-serif text-xl font-medium text-paper">
              <AlertTriangle className="size-5 text-ember" />
              Reset everything?
            </DialogTitle>
            <DialogDescription className="text-sm text-dim">
              All knowledge, the wiki, digests, and Git history will be permanently deleted. Type{" "}
              <span className="font-mono text-faded">reset</span> to confirm.
            </DialogDescription>
          </DialogHeader>

          <Input
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && phrase.trim() === "reset" && !busy) void reset();
            }}
            placeholder="reset"
            autoFocus
            autoComplete="off"
            className={inputClass}
          />
          {error && <p className="text-sm text-ember">⚠ {error}</p>}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={close}
              disabled={busy}
              className={actionButtonClass}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => void reset()}
              disabled={busy || phrase.trim() !== "reset"}
              className="border-ember/50 bg-transparent text-ember hover:border-ember hover:bg-ember/10 hover:text-ember"
            >
              {busy ? "Resetting…" : "Reset everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
