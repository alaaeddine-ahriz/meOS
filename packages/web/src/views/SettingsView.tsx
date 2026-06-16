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
  Calendar,
  Contact,
  Mail,
  Moon,
  Palette as PaletteIcon,
  Plug,
  RefreshCw,
  Search,
  Sparkles,
  Sun,
  Trash2,
  UserCircle,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
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
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { isTauri, openExternal } from "@/lib/platform";
import { isReasoningModel } from "@/lib/reasoning";
import { ProfileSection } from "./ProfileSection";
import {
  type Density,
  type FontPreset,
  type Motion,
  type Palette,
  setDensity,
  setFont,
  setMotion,
  setPalette,
  setTheme,
  setWidth,
  storedDensity,
  storedFont,
  storedMotion,
  storedPalette,
  storedTheme,
  storedWidth,
  type ThemePreference,
  type Width,
} from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  api,
  type ConnectorKind,
  type ConnectorStatus,
  type GitCommit,
  type GitStatus,
  type LlmProvider,
  type LlmSettings,
  type WatchedFolder,
} from "../api.js";

const THEMES: Array<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
];

const PALETTES: Array<{ value: Palette; label: string }> = [
  { value: "warm", label: "Warm" },
  { value: "neutral", label: "Neutral" },
  { value: "cool", label: "Cool" },
  { value: "shadcn", label: "shadcn" },
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

const WIDTHS: Array<{ value: Width; label: string }> = [
  { value: "readable", label: "Readable" },
  { value: "full", label: "Full width" },
];

const MOTIONS: Array<{ value: Motion; label: string }> = [
  { value: "full", label: "On" },
  { value: "reduced", label: "Off" },
];

/** One selectable Settings section. */
type SettingsItem = {
  id: TabId;
  label: string;
  icon: LucideIcon;
  /** Shown under the title at the top of the panel. */
  blurb: string;
};

type TabId =
  | "profile"
  | "appearance"
  | "intelligence"
  | "folders"
  | "connectors"
  | "sync"
  | "reset";

/**
 * The sections of Settings, presented as a grouped left rail — a focused panel
 * to the right of a searchable list, in the manner of a desktop preferences pane.
 */
const GROUPS: Array<{ heading: string; items: SettingsItem[] }> = [
  {
    heading: "Workspace",
    items: [
      {
        id: "profile",
        label: "Profile",
        icon: UserCircle,
        blurb: "Who you are, in MeOS's own words.",
      },
      {
        id: "appearance",
        label: "Appearance",
        icon: PaletteIcon,
        blurb: "Mode, palette, typeface, width and motion.",
      },
      {
        id: "intelligence",
        label: "Intelligence",
        icon: Sparkles,
        blurb: "The model that reads, writes and answers.",
      },
    ],
  },
  {
    heading: "Knowledge",
    items: [
      {
        id: "folders",
        label: "Folders",
        icon: FolderOpen,
        blurb: "The folders MeOS reads and keeps watching.",
      },
      {
        id: "connectors",
        label: "Connectors",
        icon: Plug,
        blurb: "Sync people from Google Contacts, Calendar and Mail.",
      },
      {
        id: "sync",
        label: "Sync",
        icon: GitBranch,
        blurb: "Version your wiki and digests with Git.",
      },
    ],
  },
  {
    heading: "Advanced",
    items: [
      { id: "reset", label: "Reset", icon: Trash2, blurb: "Erase everything MeOS has learned." },
    ],
  },
];

const ITEMS: SettingsItem[] = GROUPS.flatMap((group) => group.items);

const inputClass =
  "border-line bg-transparent font-mono text-[13px] text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0";

const comboboxClass =
  "border-line bg-transparent font-mono text-[13px] text-paper hover:bg-transparent hover:text-paper focus-visible:border-lamp-dim focus-visible:ring-0";

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
  const [query, setQuery] = useState("");

  // Filter the rail by name; hide a group entirely once nothing in it matches.
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return GROUPS;
    return GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.label.toLowerCase().includes(needle)),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  const active = ITEMS.find((item) => item.id === tab) ?? ITEMS[0]!;

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          "flex w-60 shrink-0 flex-col border-r border-line bg-desk/40 px-3 py-6",
          isTauri && "pt-10",
        )}
      >
        <div className="relative px-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-dim" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings"
            className={cn(inputClass, "h-9 rounded-lg bg-card/50 pl-9 font-sans text-sm")}
          />
        </div>

        <nav className="mt-5 flex flex-col gap-5 overflow-y-auto">
          {groups.map((group) => (
            <div key={group.heading} className="flex flex-col gap-1">
              <span className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-[0.18em] text-dim">
                {group.heading}
              </span>
              {group.items.map(({ id, label, icon: Icon }) => {
                const isActive = tab === id;
                return (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                      isActive
                        ? "bg-card text-paper"
                        : "text-faded hover:bg-card/50 hover:text-paper",
                    )}
                  >
                    <Icon className="size-4 shrink-0 opacity-70" />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-2.5 text-sm text-dim">Nothing matches “{query.trim()}”.</p>
          )}
        </nav>
      </aside>

      <div className="h-full flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-10 py-10">
          <header className="rise">
            <h1 className="font-serif text-2xl text-paper">{active.label}</h1>
            <p className="mt-1 text-sm text-dim">{active.blurb}</p>
          </header>

          <div className="mt-8">
            {tab === "profile" && <ProfileSection />}
            {tab === "appearance" && <AppearanceSection />}
            {tab === "intelligence" && <IntelligenceSection />}
            {tab === "folders" && <FoldersSection />}
            {tab === "connectors" && <ConnectorsSection />}
            {tab === "sync" && <GitSyncSection />}
            {tab === "reset" && <ResetSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AppearanceSection() {
  const [theme, setThemeState] = useState<ThemePreference>(storedTheme());
  const [palette, setPaletteState] = useState<Palette>(storedPalette());
  const [font, setFontState] = useState<FontPreset>(storedFont());
  const [density, setDensityState] = useState<Density>(storedDensity());
  const [width, setWidthState] = useState<Width>(storedWidth());
  const [motion, setMotionState] = useState<Motion>(storedMotion());

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
  const chooseWidth = (next: Width) => {
    setWidth(next);
    setWidthState(next);
  };
  const chooseMotion = (next: Motion) => {
    setMotion(next);
    setMotionState(next);
  };

  return (
    <section className="rise flex flex-col gap-4">
      <Segmented label="Mode" value={theme} options={THEMES} onChange={chooseTheme} />
      <Segmented label="Palette" value={palette} options={PALETTES} onChange={choosePalette} />
      <Segmented label="Typeface" value={font} options={FONTS} onChange={chooseFont} />
      <Segmented label="Density" value={density} options={DENSITIES} onChange={chooseDensity} />
      <Segmented label="Width" value={width} options={WIDTHS} onChange={chooseWidth} />
      <Segmented label="Animation" value={motion} options={MOTIONS} onChange={chooseMotion} />
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
  // Models discovered live from the active cloud provider, with a curated fallback.
  const [cloudModels, setCloudModels] = useState<string[]>([]);
  const [cloudSource, setCloudSource] = useState<"live" | "curated">("curated");
  const [cloudModelsError, setCloudModelsError] = useState<string | null>(null);
  const [loadingCloud, setLoadingCloud] = useState(false);
  // The reasoning-capable wiki-maintainer model (drives the Activity transcript).
  const [maintainerModel, setMaintainerModel] = useState("");
  const [savingMaintainer, setSavingMaintainer] = useState(false);
  const [maintainerSaved, setMaintainerSaved] = useState(false);
  const [maintainerError, setMaintainerError] = useState<string | null>(null);

  const applyLlm = (settings: LlmSettings, nextProvider?: LlmProvider) => {
    const active = nextProvider ?? settings.provider;
    setLlm(settings);
    setProvider(active);
    setModel(settings.providers[active].model);
    setBaseUrl(settings.providers.local.baseUrl);
    setMaintainerModel(settings.maintainer.configured ? settings.maintainer.model : "");
  };

  const saveMaintainer = async () => {
    setSavingMaintainer(true);
    setMaintainerError(null);
    setMaintainerSaved(false);
    try {
      const updated = await api.updateMaintainerModel({ provider, model: maintainerModel.trim() });
      applyLlm(updated, provider);
      setMaintainerSaved(true);
    } catch (e) {
      setMaintainerError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingMaintainer(false);
    }
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

  // Ask the cloud provider which models its key can use. Passes the unsaved key
  // when present so the list can be refreshed before saving; otherwise the server
  // uses the saved/env key.
  const refreshCloudModels = async (target: "anthropic" | "openai" | "google", key?: string) => {
    setLoadingCloud(true);
    setCloudModelsError(null);
    try {
      const listing = await api.listProviderModels(target, key);
      setCloudModels(listing.models);
      setCloudSource(listing.source);
      setCloudModelsError(listing.source === "curated" ? (listing.error ?? null) : null);
    } catch (e) {
      setCloudModels([]);
      setCloudSource("curated");
      setCloudModelsError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingCloud(false);
    }
  };

  // Pull the model list whenever a cloud provider becomes active.
  useEffect(() => {
    if (provider !== "local")
      void refreshCloudModels(provider as "anthropic" | "openai" | "google");
  }, [provider]);

  const chooseProvider = (next: LlmProvider) => {
    setLlmError(null);
    setLlmSaved(false);
    setApiKey("");
    setLocalModelsError(null);
    setCloudModelsError(null);
    if (next !== "local") setLocalModels([]);
    else setCloudModels([]);
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
      // A freshly-saved key may reveal the account's real catalogue.
      if (provider !== "local")
        void refreshCloudModels(provider as "anthropic" | "openai" | "google");
    } catch (e) {
      setLlmError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const cloudProvider = provider !== "local";
  const keySaved =
    cloudProvider && llm
      ? llm.providers[provider as "anthropic" | "openai" | "google"].hasKey
      : false;
  // Always keep the currently-selected model selectable, even if discovery hasn't
  // returned it (a key that's saved but unverified, an offline refresh, etc.).
  const cloudOptions =
    model && !cloudModels.includes(model) ? [model, ...cloudModels] : cloudModels;

  return (
    <section className="rise flex flex-col gap-4">
      <PanelIntro>
        The model that reads your documents, maintains the wiki, and answers your questions. API
        keys stay on this machine.
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
              <>
                <div className="flex min-w-0 items-center gap-2">
                  <Combobox
                    value={model}
                    onChange={setModel}
                    options={cloudOptions}
                    allowCustom
                    placeholder={loadingCloud ? "Loading models…" : "Choose a model"}
                    searchPlaceholder="Search or type a model…"
                    emptyText="No matching models."
                    className={cn(comboboxClass, "flex-1 min-w-0")}
                  />
                  <Button
                    variant="outline"
                    onClick={() =>
                      void refreshCloudModels(
                        provider as "anthropic" | "openai" | "google",
                        apiKey.trim() || undefined,
                      )
                    }
                    disabled={loadingCloud}
                    className={actionButtonClass}
                    aria-label="Refresh model list"
                  >
                    <RefreshCw className={cn("size-3.5", loadingCloud && "animate-spin")} />
                  </Button>
                </div>
                <p className="font-mono text-[11px] text-dim">
                  {cloudSource === "live"
                    ? `${cloudModels.length} model${cloudModels.length === 1 ? "" : "s"} available on your account`
                    : cloudModelsError
                      ? `⚠ ${cloudModelsError} — showing the built-in list.`
                      : "Built-in list — paste a key and refresh to load your account's models."}
                </p>
              </>
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
                  <Combobox
                    value={model}
                    onChange={setModel}
                    options={localModels}
                    allowCustom
                    placeholder="Choose a loaded model"
                    searchPlaceholder="Search or type a model…"
                    emptyText="No matching models."
                    className={comboboxClass}
                  />
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
                placeholder={
                  keySaved ? "API key saved — paste to replace" : KEY_PLACEHOLDERS[provider]
                }
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
                  <Check className="size-3.5" /> using{" "}
                  {provider === "local" ? model || "local model" : model}
                </span>
              )}
            </div>

            <MaintainerPicker
              provider={provider}
              options={cloudProvider ? cloudModels : localModels}
              value={maintainerModel}
              onChange={setMaintainerModel}
              onSave={() => void saveMaintainer()}
              saving={savingMaintainer}
              saved={maintainerSaved}
              error={maintainerError}
            />
          </div>
        </>
      )}
      {llmError && <p className="text-sm text-ember">⚠ {llmError}</p>}
    </section>
  );
}

/**
 * Picks the reasoning-capable model that powers the agentic wiki maintainer
 * (its thinking + tool calls stream to Activity). Reuses the active provider's
 * discovered models; an empty value falls back to the main model with reasoning
 * off. Flags whether the chosen model can actually emit reasoning.
 */
function MaintainerPicker({
  provider,
  options,
  value,
  onChange,
  onSave,
  saving,
  saved,
  error,
}: {
  provider: LlmProvider;
  options: string[];
  value: string;
  onChange: (model: string) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  error: string | null;
}) {
  const trimmed = value.trim();
  const reasoning = isReasoningModel(provider, trimmed);
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-line pt-4">
      <div>
        <p className="text-sm text-paper">Wiki maintainer model</p>
        <p className="mt-0.5 text-[13px] text-dim">
          A reasoning-capable model narrates wiki updates in Activity — showing its thinking and
          each edit as it works. Leave empty to reuse your main model (no reasoning).
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Combobox
          value={value}
          onChange={onChange}
          options={options}
          allowCustom
          placeholder="Same as main model"
          searchPlaceholder="Search or type a model…"
          emptyText="No matching models."
          className={cn(comboboxClass, "flex-1 min-w-0")}
        />
        <Button variant="outline" onClick={onSave} disabled={saving} className={actionButtonClass}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {trimmed ? (
        reasoning ? (
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-moss">
            <Check className="size-3.5" /> Reasoning-capable — its thinking will stream to Activity.
          </p>
        ) : (
          <p className="font-mono text-[11px] text-ember">
            ⚠ This model can't stream reasoning. Pick a Claude Opus/Sonnet, GPT-5/o-series, or
            Gemini 2.5/3 model for the full transcript.
          </p>
        )
      ) : (
        <p className="font-mono text-[11px] text-dim">
          Using your main model — tool calls stream, but no reasoning.
        </p>
      )}
      {saved && (
        <span className="flex items-center gap-1.5 text-sm text-moss">
          <Check className="size-3.5" /> Maintainer model saved.
        </span>
      )}
      {error && <p className="text-sm text-ember">⚠ {error}</p>}
    </div>
  );
}

function FoldersSection() {
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    api
      .listFolders()
      .then((r) => setFolders(r.folders))
      .catch(() => {});

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
        Everything readable in these folders is absorbed automatically — new files and edits alike.
        Your files are never moved or modified.
      </PanelIntro>

      <ul className="divide-y divide-line border-y border-line">
        {folders.map((folder) => (
          <li key={folder.id} className="group flex items-center gap-3 py-2.5">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[13px] text-paper"
              title={folder.path}
            >
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
          <li className="py-5 text-sm text-dim">
            No folders yet — add one and MeOS starts reading.
          </li>
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
        reads .md .txt .csv .json .org .pdf .docx .xlsx .xls .ods .pptx .eml .mbox .html .rtf .odt
        .ipynb .sql .png .jpg .gif .webp — everything else is left alone
      </p>
    </section>
  );
}

const KIND_META: Record<ConnectorKind, { label: string; icon: LucideIcon; blurb: string }> = {
  contacts: {
    label: "Contacts",
    icon: Contact,
    blurb: "People, with email and phone (kept private).",
  },
  calendar: { label: "Calendar", icon: Calendar, blurb: "Events and who you met with." },
  gmail: { label: "Mail", icon: Mail, blurb: "Who you correspond with (metadata only)." },
};

/** The coverage windows offered in the UI, ordered narrowest → broadest (#68). */
const COVERAGE_WINDOWS: Array<{ value: string; label: string }> = [
  { value: "recent", label: "Recent" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "all", label: "Everything" },
];

function ConnectorsSection() {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState<null | "creds" | "connect">(null);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  // The user's Google calendars, loaded lazily when Calendar is connected (#68).
  const [calendars, setCalendars] = useState<
    Array<{ id: string; summary: string; primary: boolean }>
  >([]);

  const refresh = () =>
    api
      .getConnectors()
      .then(setStatus)
      .catch(() => {});

  useEffect(() => {
    refresh();
  }, []);

  const google = status?.google;

  // Load the calendar list once Google is connected so the multi-calendar picker
  // has options (#68). Best-effort — a failure just leaves the picker empty.
  useEffect(() => {
    if (!google?.connected) return;
    api
      .listGoogleCalendars()
      .then((r) => setCalendars(r.calendars))
      .catch(() => {});
  }, [google?.connected]);

  const saveCredentials = async () => {
    if (!clientId.trim() || !clientSecret.trim()) return;
    setBusy("creds");
    setError(null);
    try {
      setStatus(await api.saveGoogleCredentials(clientId.trim(), clientSecret.trim()));
      setClientSecret("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy("connect");
    setError(null);
    try {
      const { url } = await api.startGoogleAuth();
      await openExternal(url);
      // Poll until the loopback callback records tokens (or the user gives up).
      const started = Date.now();
      const poll = setInterval(async () => {
        const next = await api.getConnectors().catch(() => null);
        if (next?.google.connected || Date.now() - started > 3 * 60_000) {
          clearInterval(poll);
          if (next) setStatus(next);
          setBusy(null);
        }
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setError(null);
    try {
      await api.disconnectGoogle();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const configure = async (
    kind: ConnectorKind,
    config: {
      enabled?: boolean;
      intervalMinutes?: number;
      coverageWindow?: string;
      contentMode?: string;
      enabledCalendars?: string[];
    },
  ) => {
    setError(null);
    try {
      setStatus(await api.configureConnectorKind(kind, config));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const syncNow = async (kind: ConnectorKind) => {
    setError(null);
    try {
      await api.syncConnectorKind(kind);
      // Status (last-synced) updates a moment after the queued sync runs.
      setTimeout(refresh, 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="rise flex flex-col gap-5">
      <PanelIntro>
        Connect a Google account to turn the people you know into entities — enriched with their
        contact details, the events you shared, and who you email. Contact details and email
        metadata stay private (searchable, but kept out of the synced wiki).
      </PanelIntro>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={cn("size-2 rounded-full", google?.connected ? "bg-emerald-500" : "bg-dim")}
          />
          <span className="text-faded">
            {google?.connected
              ? `Connected${google.accountEmail ? ` — ${google.accountEmail}` : ""}`
              : "Not connected"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowHelp(true)}
          className="text-dim hover:text-paper"
        >
          Show me how
        </Button>
      </div>

      {/* Credentials — the user's own Google OAuth desktop client. */}
      <div className="flex flex-col gap-3 border-y border-line py-4">
        <span className="text-sm text-faded">Google OAuth credentials (Desktop app client)</span>
        <Input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={
            google?.hasCredentials ? "•••• client ID saved — paste to replace" : "Client ID"
          }
          className={inputClass}
        />
        <div className="flex items-center gap-3">
          <Input
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            type="password"
            placeholder={
              google?.hasCredentials
                ? "•••• client secret saved — paste to replace"
                : "Client secret"
            }
            className={inputClass}
          />
          <Button
            variant="outline"
            onClick={() => void saveCredentials()}
            disabled={busy === "creds" || !clientId.trim() || !clientSecret.trim()}
            className={actionButtonClass}
          >
            {busy === "creds" ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {/* Connect / disconnect. */}
      <div className="flex items-center gap-3">
        {google?.connected ? (
          <Button variant="outline" onClick={() => void disconnect()} className={actionButtonClass}>
            Disconnect
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => void connect()}
            disabled={!google?.hasCredentials || busy === "connect"}
            className={actionButtonClass}
          >
            {busy === "connect" ? "Waiting for Google…" : "Connect Google"}
          </Button>
        )}
      </div>

      {/* Per-kind sync controls — only meaningful once connected. */}
      {google?.connected && (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {google.kinds.map((k) => {
            const meta = KIND_META[k.kind];
            const Icon = meta.icon;
            return (
              <li key={k.kind} className="flex flex-col gap-2 py-3.5">
                <div className="flex items-center gap-3">
                  <Icon className="size-4 shrink-0 text-dim" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-paper">{meta.label}</div>
                    <div className="text-[12px] text-dim">{meta.blurb}</div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void configure(k.kind, { enabled: !k.enabled })}
                    className={cn(actionButtonClass, k.enabled && "border-lamp-dim text-paper")}
                  >
                    {k.enabled ? "On" : "Off"}
                  </Button>
                </div>
                {k.enabled && (
                  <div className="flex flex-col gap-2.5 pl-7">
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-2 text-[12px] text-dim">
                        every
                        <Input
                          type="number"
                          min={1}
                          defaultValue={k.intervalMinutes}
                          onBlur={(e) => {
                            const value = Number(e.target.value);
                            if (
                              Number.isFinite(value) &&
                              value >= 1 &&
                              value !== k.intervalMinutes
                            ) {
                              void configure(k.kind, { intervalMinutes: value });
                            }
                          }}
                          className={cn(inputClass, "h-7 w-16")}
                        />
                        min
                      </label>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void syncNow(k.kind)}
                        className="text-dim hover:text-paper"
                      >
                        <RefreshCw className="size-3.5" />
                        Sync now
                      </Button>
                      {k.lastStatus && <span className="text-[11px] text-dim">{k.lastStatus}</span>}
                    </div>

                    {/* Coverage window — how far back we index (#68). Default "recent"
                        keeps the privacy-preserving seed; broader windows are explicit. */}
                    {(k.kind === "gmail" || k.kind === "calendar") && (
                      <label className="flex items-center gap-2 text-[12px] text-dim">
                        coverage
                        <select
                          value={k.coverage?.coverageWindow ?? "recent"}
                          onChange={(e) =>
                            void configure(k.kind, { coverageWindow: e.target.value })
                          }
                          className={cn(inputClass, "h-7 w-auto px-2")}
                        >
                          {COVERAGE_WINDOWS.map((w) => (
                            <option key={w.value} value={w.value}>
                              {w.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {/* Gmail content mode — metadata-only (default, private) vs richer
                        body indexing (explicit opt-in, clearly labelled) (#68). */}
                    {k.kind === "gmail" && (
                      <label className="flex items-start gap-2 text-[12px] text-dim">
                        <input
                          type="checkbox"
                          checked={k.coverage?.contentMode === "rich"}
                          onChange={(e) =>
                            void configure(k.kind, {
                              contentMode: e.target.checked ? "rich" : "metadata",
                            })
                          }
                          className="mt-0.5"
                        />
                        <span>
                          Index email bodies (not just metadata).{" "}
                          <span className="text-ember">
                            Broader: stores message text on this device.
                          </span>
                        </span>
                      </label>
                    )}

                    {/* Gmail backfill progress — make partial coverage obvious (#68). */}
                    {k.kind === "gmail" && k.coverage?.backfill && (
                      <span className="text-[11px] text-dim">
                        {k.coverage.backfill.complete
                          ? `Backfill complete — ${k.coverage.itemCount ?? 0} indexed`
                          : `Backfilling… ${k.coverage.backfill.indexed} indexed so far`}
                        {k.coverage.oldestIndexed
                          ? ` (back to ${k.coverage.oldestIndexed.slice(0, 10)})`
                          : ""}
                      </span>
                    )}

                    {/* Calendar multi-select — pick which calendars to sync (#68). */}
                    {k.kind === "calendar" && calendars.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-dim">Calendars</span>
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {calendars.map((cal) => {
                            const enabledCals = k.coverage?.enabledCalendars ?? ["primary"];
                            const on = enabledCals.includes(cal.id);
                            return (
                              <label
                                key={cal.id}
                                className="flex items-center gap-1.5 text-[12px] text-faded"
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? [...new Set([...enabledCals, cal.id])]
                                      : enabledCals.filter((id) => id !== cal.id);
                                    void configure(k.kind, {
                                      enabledCalendars: next.length > 0 ? next : ["primary"],
                                    });
                                  }}
                                />
                                {cal.summary}
                                {cal.primary ? " (primary)" : ""}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Calendar per-calendar coverage counts (#68). */}
                    {k.kind === "calendar" &&
                      k.coverage?.calendars &&
                      k.coverage.calendars.length > 0 && (
                        <span className="text-[11px] text-dim">
                          {k.coverage.itemCount ?? 0} events indexed across{" "}
                          {k.coverage.calendars.length} calendar
                          {k.coverage.calendars.length === 1 ? "" : "s"}
                        </span>
                      )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Visibility model — what connector data is allowed to influence. Connector
          sources default to private: they inform you here, but never leave the device. */}
      <div className="flex flex-col gap-2 rounded-md border border-line bg-card/50 p-3.5 text-[12px] text-dim">
        <span className="text-faded">What synced Google data can do</span>
        <ul className="flex flex-col gap-1">
          <li>
            <span className="text-paper">Searchable &amp; answerable</span> — yes. Synced people and
            events become entities your chat can find and cite.
          </li>
          <li>
            <span className="text-paper">Wiki</span> — non-private facts may appear on a person's
            page; contact details and email metadata are kept off it.
          </li>
          <li>
            <span className="text-paper">Sync &amp; export</span> — no. Connector-derived content is
            never written to the git-synced wiki/digests or any export. It stays on this device.
          </li>
        </ul>
      </div>

      {error && <p className="text-sm text-ember">⚠ {error}</p>}

      <Dialog open={showHelp} onOpenChange={setShowHelp}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect Google in a few steps</DialogTitle>
            <DialogDescription>
              MeOS uses your own Google Cloud OAuth client, so your data never passes through anyone
              else.
            </DialogDescription>
          </DialogHeader>
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-faded">
            <li>
              Open the{" "}
              <button
                type="button"
                onClick={() => void openExternal("https://console.cloud.google.com/")}
                className="text-lamp underline-offset-2 hover:underline"
              >
                Google Cloud Console
              </button>{" "}
              and create (or pick) a project.
            </li>
            <li>Enable the People API, Google Calendar API, and Gmail API.</li>
            <li>Configure the OAuth consent screen (External, add yourself as a test user).</li>
            <li>
              Create an OAuth client ID of type <strong>Desktop app</strong>.
            </li>
            <li>Paste the client ID and secret above, then click Connect Google.</li>
          </ol>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowHelp(false)}
              className={actionButtonClass}
            >
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    api
      .getGitStatus()
      .then(apply)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
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
    await api
      .setGitAutoSync(next)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <section className="rise flex flex-col gap-4">
      <PanelIntro>
        Version your wiki and digests as a Git repository — a portable, human-readable backup you
        can push to GitHub. The database itself stays local; only the markdown is synced.
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
          {status.lastCommit && (
            <p className="font-mono text-[11px] text-dim">{status.lastCommit}</p>
          )}

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
              disabled={
                busy === "remote" || !remote.trim() || remote.trim() === (status.remote ?? "")
              }
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
    api
      .getGitLog(30)
      .then((r) => setCommits(r.commits))
      .catch(() => setCommits([]));
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
                  {commit.hash} · {commit.relativeDate} · {commit.files} file
                  {commit.files === 1 ? "" : "s"}
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
              Your original files on disk are never touched — but everything MeOS derived from them
              is permanently deleted.
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
            <Button variant="outline" onClick={close} disabled={busy} className={actionButtonClass}>
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
