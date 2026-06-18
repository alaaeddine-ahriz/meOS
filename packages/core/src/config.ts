import fs from "node:fs";
import path from "node:path";
import { ensureSchemaDoc } from "./knowledge/schema-doc.js";
import { ensureProfileDocs } from "./profile/profile-doc.js";

export type LlmProvider = "anthropic" | "openai" | "google" | "openrouter" | "local" | "stub";

export interface LlmConfig {
  provider: LlmProvider;
  anthropic: {
    model: string;
    extractionModel: string;
    apiKey?: string;
  };
  openai: {
    model: string;
    apiKey?: string;
  };
  google: {
    model: string;
    apiKey?: string;
  };
  /**
   * OpenRouter — a single OpenAI-compatible gateway in front of many providers'
   * models (`anthropic/claude-…`, `openai/gpt-…`, etc.). `model` is the fully
   * namespaced model slug.
   */
  openrouter: {
    model: string;
    apiKey?: string;
  };
  /**
   * A locally-served, OpenAI-compatible endpoint (LM Studio, llama.cpp, Ollama's
   * /v1, etc.). `baseUrl` points at the server's OpenAI-compatible base (commonly
   * ending in `/v1`); `model` is the served model's identifier.
   */
  local: {
    baseUrl: string;
    model: string;
  };
  /**
   * The model that powers the agentic wiki maintainer (its reasoning + tool
   * calls are streamed to the Activity view). Independent of the chat/extraction
   * model and meant to be a reasoning-capable model. When unset, the maintainer
   * falls back to the active provider's main model with reasoning off.
   */
  maintainer?: {
    provider?: LlmProvider;
    model?: string;
  };
}

export interface MeosConfig {
  dataDir: string;
  llm: LlmConfig;
  embedding: {
    provider: "local" | "hash";
    model: string;
  };
  server: {
    port: number;
  };
  consolidation: {
    cron: string;
  };
}

export const defaultConfig: MeosConfig = {
  dataDir: "data",
  llm: {
    provider: "anthropic",
    anthropic: {
      model: "claude-opus-4-8",
      extractionModel: "claude-opus-4-8",
    },
    openai: {
      model: "gpt-5.1",
    },
    google: {
      model: "gemini-2.5-pro",
    },
    openrouter: {
      model: "anthropic/claude-opus-4-8",
    },
    local: {
      baseUrl: "http://localhost:1234/v1",
      model: "",
    },
  },
  embedding: {
    provider: "local",
    model: "Xenova/all-MiniLM-L6-v2",
  },
  server: {
    port: 4321,
  },
  consolidation: {
    cron: "0 3 * * *",
  },
};

export const LLM_PROVIDERS: LlmProvider[] = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "local",
  "stub",
];

function deepMerge<T>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const value = override[key];
    if (value === undefined) continue;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof base[key] === "object"
    ) {
      result[key] = deepMerge(base[key], value as Partial<T[keyof T]>);
    } else {
      result[key] = value as T[keyof T];
    }
  }
  return result;
}

export function loadConfig(rootDir: string): MeosConfig {
  const configPath = path.join(rootDir, "meos.config.json");
  let fileConfig: Partial<MeosConfig> = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  const config = deepMerge(defaultConfig, fileConfig);

  const envProvider = process.env.MEOS_LLM_PROVIDER as LlmProvider | undefined;
  if (envProvider && LLM_PROVIDERS.includes(envProvider)) {
    config.llm.provider = envProvider;
  }
  // The desktop shell relocates data to a writable per-user directory because
  // the app bundle itself is read-only; MEOS_DATA_DIR (absolute) wins outright.
  const envDataDir = process.env.MEOS_DATA_DIR;
  if (envDataDir) config.dataDir = envDataDir;
  if (!path.isAbsolute(config.dataDir)) {
    config.dataDir = path.join(rootDir, config.dataDir);
  }
  return config;
}

/**
 * Overlay LLM settings saved from the UI (a complete LlmConfig snapshot in
 * the settings table) onto the code/file defaults. The Settings UI is the
 * source of truth for provider, model, and API keys; meos.config.json holds
 * only infrastructure config. MEOS_LLM_PROVIDER still wins for one-off runs
 * and tests.
 */
export function overlayStoredLlmConfig(
  config: MeosConfig,
  stored: Partial<LlmConfig> | undefined,
): void {
  if (stored) {
    // Migrate settings saved under the old "ollama" provider: fold its endpoint
    // into the generic local provider so existing users aren't reset.
    const legacy = stored as Partial<LlmConfig> & { ollama?: { baseUrl?: string; model?: string } };
    const provider =
      (legacy.provider === ("ollama" as LlmProvider) ? "local" : legacy.provider) ??
      config.llm.provider;
    config.llm = {
      provider,
      anthropic: { ...config.llm.anthropic, ...stored.anthropic },
      openai: { ...config.llm.openai, ...stored.openai },
      google: { ...config.llm.google, ...stored.google },
      openrouter: { ...config.llm.openrouter, ...stored.openrouter },
      local: { ...config.llm.local, ...legacy.ollama, ...stored.local },
      maintainer: { ...config.llm.maintainer, ...stored.maintainer },
    };
  }
  const envProvider = process.env.MEOS_LLM_PROVIDER as LlmProvider | undefined;
  if (envProvider && LLM_PROVIDERS.includes(envProvider)) {
    config.llm.provider = envProvider;
  }
}

export function ensureDataDirs(config: MeosConfig): void {
  for (const dir of ["", "wiki", "digests", "vault"]) {
    fs.mkdirSync(path.join(config.dataDir, dir), { recursive: true });
  }
  // Seed the schema document (the user-editable conventions every LLM stage
  // reads) if the user has none yet.
  ensureSchemaDoc(config.dataDir);
  // Seed the profile scaffold (the user lens every LLM stage injects), private
  // by default — its documents hold sensitive professional context.
  ensureProfileDocs(config.dataDir);
}
