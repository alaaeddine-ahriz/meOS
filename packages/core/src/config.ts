import fs from "node:fs";
import path from "node:path";

export interface MeosConfig {
  dataDir: string;
  llm: {
    provider: "anthropic" | "ollama" | "stub";
    anthropic: {
      model: string;
      extractionModel: string;
    };
    ollama: {
      baseUrl: string;
      model: string;
    };
  };
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

  const envProvider = process.env.MEOS_LLM_PROVIDER;
  if (envProvider === "anthropic" || envProvider === "ollama" || envProvider === "stub") {
    config.llm.provider = envProvider;
  }
  if (!path.isAbsolute(config.dataDir)) {
    config.dataDir = path.join(rootDir, config.dataDir);
  }
  return config;
}

export function ensureDataDirs(config: MeosConfig): void {
  for (const dir of ["", "wiki", "digests"]) {
    fs.mkdirSync(path.join(config.dataDir, dir), { recursive: true });
  }
}
