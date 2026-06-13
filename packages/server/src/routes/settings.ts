import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  createLlmClient,
  ensureDataDirs,
  normalizeLocalBaseUrl,
  PROVIDER_MODELS,
  resetDatabase,
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
      local: { model: llm.local.model, baseUrl: llm.local.baseUrl },
    },
  };
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/settings/llm", async () => llmSettingsView(ctx));

  // Discover the models a local OpenAI-compatible server (LM Studio, llama.cpp,
  // Ollama's /v1) currently has available, so Settings can offer a picker rather
  // than a blind text field. Proxied through the server to dodge browser CORS and
  // because the desktop shell calls our API anyway. `baseUrl` defaults to the
  // saved endpoint but the UI passes its live input so models can be detected
  // before saving.
  app.get<{ Querystring: { baseUrl?: string } }>("/api/settings/llm/local/models", async (request, reply) => {
    const base = normalizeLocalBaseUrl(request.query.baseUrl?.trim() || ctx.config.llm.local.baseUrl);
    if (!base) {
      return reply.code(400).send({ error: "No local endpoint configured" });
    }
    try {
      const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5000) });
      // LM Studio answers an unknown route with HTTP 200 and an { error } body,
      // so a real model list is the one with a `data` array — not just an ok status.
      const body = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }>; error?: string };
      if (!response.ok || !Array.isArray(body.data)) {
        return reply.code(502).send({
          error: `No models at ${base}/models — check the endpoint points at an OpenAI-compatible server.`,
        });
      }
      const models = body.data.map((m) => m.id).filter((id): id is string => Boolean(id));
      return { models };
    } catch {
      return reply.code(502).send({ error: "Couldn't reach the local server — is it running at that endpoint?" });
    }
  });

  app.put<{ Body: { provider?: string; model?: string; apiKey?: string; baseUrl?: string } }>(
    "/api/settings/llm",
    async (request, reply) => {
      const { provider, model, apiKey, baseUrl } = request.body ?? {};
      const validProviders: LlmProvider[] = ["anthropic", "openai", "google", "local"];
      if (!provider || !validProviders.includes(provider as LlmProvider)) {
        return reply.code(400).send({ error: `Field 'provider' must be one of: ${validProviders.join(", ")}` });
      }
      const llm = ctx.config.llm;
      llm.provider = provider as LlmProvider;

      if (provider === "local") {
        if (model?.trim()) llm.local.model = model.trim();
        // Store the canonical /v1 form so inference and discovery agree, and the
        // UI reflects the corrected URL after saving.
        if (baseUrl?.trim()) llm.local.baseUrl = normalizeLocalBaseUrl(baseUrl.trim());
        if (!llm.local.baseUrl.trim()) {
          return reply.code(400).send({ error: "A local endpoint URL is required (e.g. http://localhost:1234/v1)" });
        }
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

  // Start over: erase everything MeOS has learned. Wipes the knowledge base,
  // the human-readable wiki and digests on disk, and the git history. LLM
  // settings and the watched-folder list are kept, so ingestion resumes from
  // a clean slate. Irreversible — the UI gates it behind a typed confirmation.
  app.post("/api/settings/reset", async (_request, reply) => {
    try {
      resetDatabase(ctx.db, { keepSettings: true, keepFolders: true });

      // Drop the generated markdown, then re-seed the empty dirs + schema doc.
      for (const dir of ["wiki", "digests"]) {
        fs.rmSync(path.join(ctx.config.dataDir, dir), { recursive: true, force: true });
      }
      ensureDataDirs(ctx.config);

      // Fresh git history rooted at the now-empty tree.
      await ctx.git.reset();

      // The ingest ledger was cleared with the rest of the DB; re-absorb the
      // watched folders from scratch.
      ctx.watcher.rescan();

      return { ok: true };
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
