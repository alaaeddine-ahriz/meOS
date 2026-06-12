import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  createLlmClient,
  PROVIDER_MODELS,
  type LlmProvider,
} from "@meos/core";
import type { AppContext } from "../context.js";

const CLOUD_PROVIDERS = ["anthropic", "openai", "google"] as const;
type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

const ENV_KEYS: Record<CloudProvider, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

function hasKey(ctx: AppContext, provider: CloudProvider): boolean {
  return Boolean(
    ctx.config.llm[provider].apiKey || ENV_KEYS[provider].some((name) => process.env[name]),
  );
}

/** Never returns API keys — only whether one is configured. */
function llmSettingsView(ctx: AppContext) {
  const { llm } = ctx.config;
  return {
    provider: llm.provider,
    models: PROVIDER_MODELS,
    providers: {
      anthropic: { model: llm.anthropic.model, hasKey: hasKey(ctx, "anthropic") },
      openai: { model: llm.openai.model, hasKey: hasKey(ctx, "openai") },
      google: { model: llm.google.model, hasKey: hasKey(ctx, "google") },
      ollama: { model: llm.ollama.model, baseUrl: llm.ollama.baseUrl },
    },
  };
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/settings/llm", async () => llmSettingsView(ctx));

  app.put<{ Body: { provider?: string; model?: string; apiKey?: string; baseUrl?: string } }>(
    "/api/settings/llm",
    async (request, reply) => {
      const { provider, model, apiKey, baseUrl } = request.body ?? {};
      const validProviders: LlmProvider[] = ["anthropic", "openai", "google", "ollama"];
      if (!provider || !validProviders.includes(provider as LlmProvider)) {
        return reply.code(400).send({ error: `Field 'provider' must be one of: ${validProviders.join(", ")}` });
      }
      const llm = ctx.config.llm;
      llm.provider = provider as LlmProvider;

      if (provider === "ollama") {
        if (model?.trim()) llm.ollama.model = model.trim();
        if (baseUrl?.trim()) llm.ollama.baseUrl = baseUrl.trim();
      } else {
        const cloud = provider as CloudProvider;
        if (model?.trim()) {
          if (!PROVIDER_MODELS[cloud].includes(model.trim())) {
            return reply.code(400).send({ error: `Unknown ${cloud} model: ${model}` });
          }
          llm[cloud].model = model.trim();
          if (cloud === "anthropic") llm.anthropic.extractionModel = model.trim();
        }
        if (apiKey?.trim()) llm[cloud].apiKey = apiKey.trim();
        if (!hasKey(ctx, cloud)) {
          return reply.code(400).send({ error: `No API key configured for ${cloud} — paste one first` });
        }
      }

      try {
        ctx.llm.swap(createLlmClient(ctx.config));
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
      // Persisted in the DB — never write near source files: the dev server
      // watches the tree and a config write would restart it mid-request.
      ctx.store.setSetting("llm", llm);
      return llmSettingsView(ctx);
    },
  );

  app.get("/api/settings/folders", async () => ({
    folders: ctx.store.listWatchedFolders(),
  }));

  app.post<{ Body: { path?: string } }>("/api/settings/folders", async (request, reply) => {
    const raw = request.body?.path?.trim();
    if (!raw) {
      return reply.code(400).send({ error: "Field 'path' is required" });
    }
    const folderPath = path.resolve(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(folderPath);
    } catch {
      return reply.code(400).send({ error: `Folder not found: ${folderPath}` });
    }
    if (!stat.isDirectory()) {
      return reply.code(400).send({ error: `Not a folder: ${folderPath}` });
    }

    const folder = ctx.store.addWatchedFolder(folderPath);
    ctx.watcher.addFolder(folderPath);
    return reply.code(201).send({ folder });
  });

  app.delete<{ Params: { id: string } }>("/api/settings/folders/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const removedPath = Number.isInteger(id) ? ctx.store.removeWatchedFolder(id) : undefined;
    if (!removedPath) {
      return reply.code(404).send({ error: "No such folder" });
    }
    ctx.watcher.removeFolder(removedPath);
    return { removed: true };
  });
}
