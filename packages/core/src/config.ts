import fs from "node:fs";
import path from "node:path";

export type LlmProvider = "anthropic" | "openai" | "google" | "ollama" | "stub";

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
  ollama: {
    baseUrl: string;
    model: string;
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
    ollama: {
      baseUrl: "http://localhost:11434",
      model: "llama3.1",
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

export const LLM_PROVIDERS: LlmProvider[] = ["anthropic", "openai", "google", "ollama", "stub"];

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
export function overlayStoredLlmConfig(config: MeosConfig, stored: Partial<LlmConfig> | undefined): void {
  if (stored) {
    config.llm = {
      provider: stored.provider ?? config.llm.provider,
      anthropic: { ...config.llm.anthropic, ...stored.anthropic },
      openai: { ...config.llm.openai, ...stored.openai },
      google: { ...config.llm.google, ...stored.google },
      ollama: { ...config.llm.ollama, ...stored.ollama },
    };
  }
  const envProvider = process.env.MEOS_LLM_PROVIDER as LlmProvider | undefined;
  if (envProvider && LLM_PROVIDERS.includes(envProvider)) {
    config.llm.provider = envProvider;
  }
}

export function ensureDataDirs(config: MeosConfig): void {
  for (const dir of ["", "wiki", "digests"]) {
    fs.mkdirSync(path.join(config.dataDir, dir), { recursive: true });
  }
}
