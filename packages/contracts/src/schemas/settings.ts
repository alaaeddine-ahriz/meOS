import { z } from "zod";
import { NumericIdParam, OkSchema } from "./common.js";

export const LlmProviderSchema = z.enum(["anthropic", "openai", "google", "local"]);
export const CloudProviderSchema = z.enum(["anthropic", "openai", "google"]);

/** GET / PUT /api/settings/llm */
export const LlmSettingsSchema = z.object({
  provider: LlmProviderSchema,
  providers: z.object({
    anthropic: z.object({ model: z.string(), hasKey: z.boolean() }),
    openai: z.object({ model: z.string(), hasKey: z.boolean() }),
    google: z.object({ model: z.string(), hasKey: z.boolean() }),
    local: z.object({ model: z.string(), baseUrl: z.string() }),
  }),
  maintainer: z.object({
    provider: LlmProviderSchema,
    model: z.string(),
    configured: z.boolean(),
    reasoning: z.boolean(),
  }),
});

export const UpdateLlmSettingsBody = z.object({
  provider: LlmProviderSchema,
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

/** PUT /api/settings/llm/maintainer */
export const UpdateMaintainerBody = z.object({
  provider: LlmProviderSchema.optional(),
  model: z.string(),
});

/** GET /api/settings/llm/local/models?baseUrl= */
export const LocalModelsQuery = z.object({ baseUrl: z.string().optional() });
export const LocalModelsResponse = z.object({ models: z.array(z.string()) });

/** GET /api/settings/llm/:provider/models */
export const ProviderModelsParams = z.object({ provider: z.string().min(1) });
export const ModelListingSchema = z.object({
  models: z.array(z.string()),
  source: z.enum(["live", "curated"]),
  error: z.string().optional(),
});

/** GET /api/settings/folders */
export const WatchedFolderSchema = z.object({ id: z.number(), path: z.string() });
export const ListFoldersResponse = z.object({ folders: z.array(WatchedFolderSchema) });

/** POST /api/settings/folders */
export const AddFolderBody = z.object({ path: z.string().min(1) });
export const AddFolderResponse = z.object({ folder: WatchedFolderSchema });

/** DELETE /api/settings/folders/:id */
export const FolderIdParam = NumericIdParam;
export const RemoveFolderResponse = z.object({ removed: z.boolean() });

/** POST /api/settings/reset */
export const ResetResponse = OkSchema;

export type LlmProvider = z.infer<typeof LlmProviderSchema>;
export type CloudProvider = z.infer<typeof CloudProviderSchema>;
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;
export type ModelListing = z.infer<typeof ModelListingSchema>;
export type WatchedFolder = z.infer<typeof WatchedFolderSchema>;
