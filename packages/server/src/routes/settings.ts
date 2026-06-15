import fs from "node:fs";
import path from "node:path";
import { settings as settingsSchema } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import {
  createLlmClient,
  ensureDataDirs,
  isReasoningModel,
  listProviderModels,
  normalizeLocalBaseUrl,
  resetDatabase,
  type LlmProvider,
} from "@meos/core";
import type { AppContext } from "../context.js";
import { ApiError, httpError, parseOrThrow } from "../errors.js";

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
  // The wiki maintainer's model: explicit when configured, else the active main
  // model. `reasoning` drives the "choose a reasoning-capable model" prompt.
  const maintainerProvider = llm.maintainer?.provider ?? llm.provider;
  const maintainerModel = llm.maintainer?.model ?? "";
  return {
    provider: llm.provider,
    providers: {
      anthropic: { model: llm.anthropic.model, hasKey: hasKey(ctx, "anthropic") },
      openai: { model: llm.openai.model, hasKey: hasKey(ctx, "openai") },
      google: { model: llm.google.model, hasKey: hasKey(ctx, "google") },
      local: { model: llm.local.model, baseUrl: llm.local.baseUrl },
    },
    maintainer: {
      provider: maintainerProvider,
      model: maintainerModel,
      configured: Boolean(llm.maintainer?.model),
      reasoning: isReasoningModel(maintainerProvider, maintainerModel),
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
  app.get<{ Querystring: { baseUrl?: string } }>(
    "/api/settings/llm/local/models",
    async (request) => {
      const base = normalizeLocalBaseUrl(
        request.query.baseUrl?.trim() || ctx.config.llm.local.baseUrl,
      );
      if (!base) {
        throw httpError.badRequest("No local endpoint configured");
      }
      try {
        const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5000) });
        // LM Studio answers an unknown route with HTTP 200 and an { error } body,
        // so a real model list is the one with a `data` array — not just an ok status.
        const body = (await response.json().catch(() => ({}))) as {
          data?: Array<{ id?: string }>;
          error?: string;
        };
        if (!response.ok || !Array.isArray(body.data)) {
          throw httpError.upstream(
            `No models at ${base}/models — check the endpoint points at an OpenAI-compatible server.`,
          );
        }
        const models = body.data.map((m) => m.id).filter((id): id is string => Boolean(id));
        return { models };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw httpError.upstream(
          "Couldn't reach the local server — is it running at that endpoint?",
        );
      }
    },
  );

  // Discover the models a cloud provider's key can actually use, so the picker
  // reflects the account's catalogue instead of a list we hard-code. The key is
  // read from the `x-llm-api-key` header (the UI's unsaved input) or, absent
  // that, the saved/env key — keeping it out of the URL and the logs. Discovery
  // falls back to the curated list on any failure, so this never 500s.
  app.get<{ Params: { provider: string } }>(
    "/api/settings/llm/:provider/models",
    async (request) => {
      const provider = request.params.provider;
      if (!CLOUD_PROVIDERS.includes(provider as CloudProvider)) {
        throw httpError.badRequest(`Unknown cloud provider: ${provider}`);
      }
      const cloud = provider as CloudProvider;
      const header = request.headers["x-llm-api-key"];
      const typedKey = (Array.isArray(header) ? header[0] : header)?.trim();
      const apiKey =
        typedKey ||
        ctx.config.llm[cloud].apiKey ||
        ENV_KEYS[cloud].map((n) => process.env[n]).find(Boolean);
      return listProviderModels(cloud, apiKey);
    },
  );

  app.put<{ Body: { provider?: string; model?: string; apiKey?: string; baseUrl?: string } }>(
    "/api/settings/llm",
    async (request) => {
      const { provider, model, apiKey, baseUrl } = parseOrThrow(
        settingsSchema.UpdateLlmSettingsBody,
        request.body,
        "body",
      );
      const llm = ctx.config.llm;
      llm.provider = provider as LlmProvider;

      if (provider === "local") {
        if (model?.trim()) llm.local.model = model.trim();
        // Store the canonical /v1 form so inference and discovery agree, and the
        // UI reflects the corrected URL after saving.
        if (baseUrl?.trim()) llm.local.baseUrl = normalizeLocalBaseUrl(baseUrl.trim());
        if (!llm.local.baseUrl.trim()) {
          throw httpError.validation(
            "A local endpoint URL is required (e.g. http://localhost:1234/v1)",
          );
        }
      } else {
        const cloud = provider as CloudProvider;
        // Models are discovered live from the provider, so we trust any non-empty
        // identifier here rather than gate it against a list we'd have to keep current.
        if (model?.trim()) {
          llm[cloud].model = model.trim();
          if (cloud === "anthropic") llm.anthropic.extractionModel = model.trim();
        }
        if (apiKey?.trim()) llm[cloud].apiKey = apiKey.trim();
        if (!hasKey(ctx, cloud)) {
          throw httpError.badRequest(`No API key configured for ${cloud} — paste one first`);
        }
      }

      try {
        ctx.llm.swap(createLlmClient(ctx.config));
      } catch (error) {
        throw httpError.badRequest(error instanceof Error ? error.message : String(error));
      }
      // Persisted in the DB — never write near source files: the dev server
      // watches the tree and a config write would restart it mid-request.
      ctx.store.setSetting("llm", llm);
      return llmSettingsView(ctx);
    },
  );

  // The wiki-maintainer model — the reasoning-capable model whose thinking and
  // tool calls stream to the Activity view. Independent of the chat/extraction
  // model; an empty model clears the override (falls back to the main model).
  app.put<{ Body: { provider?: string; model?: string } }>(
    "/api/settings/llm/maintainer",
    async (request) => {
      const { provider, model } = parseOrThrow(
        settingsSchema.UpdateMaintainerBody,
        request.body,
        "body",
      );
      const llm = ctx.config.llm;
      const next = model.trim();
      if (!next) {
        llm.maintainer = undefined;
      } else {
        const chosen = (provider as LlmProvider | undefined) ?? llm.provider;
        llm.maintainer = { provider: chosen, model: next };
      }

      try {
        ctx.llm.swap(createLlmClient(ctx.config));
      } catch (error) {
        throw httpError.badRequest(error instanceof Error ? error.message : String(error));
      }
      ctx.store.setSetting("llm", llm);
      return llmSettingsView(ctx);
    },
  );

  app.get("/api/settings/folders", async () => ({
    folders: ctx.store.listWatchedFolders(),
  }));

  app.post<{ Body: { path?: string } }>("/api/settings/folders", async (request, reply) => {
    const body = parseOrThrow(settingsSchema.AddFolderBody, request.body, "body");
    const raw = body.path.trim();
    if (!raw) {
      throw httpError.validation("Field 'path' is required");
    }
    const folderPath = path.resolve(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(folderPath);
    } catch {
      throw httpError.badRequest(`Folder not found: ${folderPath}`);
    }
    if (!stat.isDirectory()) {
      throw httpError.badRequest(`Not a folder: ${folderPath}`);
    }

    const folder = ctx.store.addWatchedFolder(folderPath);
    ctx.watcher.addFolder(folderPath);
    return reply.code(201).send({ folder });
  });

  app.delete<{ Params: { id: string } }>("/api/settings/folders/:id", async (request) => {
    const { id } = parseOrThrow(settingsSchema.FolderIdParam, request.params, "params");
    const removedPath = ctx.store.removeWatchedFolder(id);
    if (!removedPath) {
      throw httpError.notFound("No such folder");
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
      throw httpError.internal(error instanceof Error ? error.message : String(error));
    }
  });
}
