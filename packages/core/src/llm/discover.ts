import { PROVIDER_MODELS } from "./index.js";

export type CloudProvider = "anthropic" | "openai" | "google";

/** A live-discovered model list, plus where it came from so the UI can explain itself. */
export interface ModelListing {
  models: string[];
  /** "live" when fetched from the provider, "curated" when we fell back to the bundled list. */
  source: "live" | "curated";
  /** Why discovery fell back, if it did — surfaced as a hint in Settings. */
  error?: string;
}

const FETCH_TIMEOUT_MS = 8000;

/**
 * Ask a cloud provider which models its key can use, so Settings offers the
 * account's actual catalogue instead of a list we hard-code and have to chase.
 * Each provider exposes a list endpoint; we hit it, keep the text/chat models,
 * and sort newest-looking first. Any failure (no key, network, auth) falls back
 * to the curated {@link PROVIDER_MODELS} so the dropdown is never empty.
 */
export async function listProviderModels(
  provider: CloudProvider,
  apiKey: string | undefined,
): Promise<ModelListing> {
  const curated: ModelListing = { source: "curated", models: PROVIDER_MODELS[provider] };
  if (!apiKey?.trim()) {
    return { ...curated, error: "No API key — showing the built-in list." };
  }
  try {
    const models = await DISCOVERERS[provider](apiKey.trim());
    if (models.length === 0) return { ...curated, error: "Provider returned no usable models." };
    return { source: "live", models: dedupeSorted(models) };
  } catch (error) {
    return { ...curated, error: error instanceof Error ? error.message : String(error) };
  }
}

const DISCOVERERS: Record<CloudProvider, (apiKey: string) => Promise<string[]>> = {
  openai: discoverOpenAi,
  anthropic: discoverAnthropic,
  google: discoverGoogle,
};

async function discoverOpenAi(apiKey: string): Promise<string[]> {
  const body = await getJson("https://api.openai.com/v1/models", {
    Authorization: `Bearer ${apiKey}`,
  });
  const data = (body as { data?: Array<{ id?: string }> }).data ?? [];
  return data
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id))
    .filter(isOpenAiChatModel);
}

// Keep GPT/o-series chat models; drop the audio, image, embedding and other
// non-text variants that share the same list.
function isOpenAiChatModel(id: string): boolean {
  if (!/^(gpt-|o\d|chatgpt)/.test(id)) return false;
  return !/(audio|realtime|transcribe|tts|image|embedding|moderation|search|dall-e|whisper|instruct)/.test(
    id,
  );
}

async function discoverAnthropic(apiKey: string): Promise<string[]> {
  const body = await getJson("https://api.anthropic.com/v1/models?limit=100", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  });
  const data = (body as { data?: Array<{ id?: string }> }).data ?? [];
  return data.map((m) => m.id).filter((id): id is string => Boolean(id));
}

async function discoverGoogle(apiKey: string): Promise<string[]> {
  const body = await getJson(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
  );
  const models =
    (
      body as {
        models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
      }
    ).models ?? [];
  return models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name?.replace(/^models\//, ""))
    .filter((id): id is string => Boolean(id))
    .filter((id) => !/embedding|aqa/.test(id));
}

/** GET JSON, turning the provider's own error message into a thrown Error. */
async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const message =
      typeof body.error === "string"
        ? body.error
        : (body.error?.message ?? `HTTP ${response.status}`);
    throw new Error(message);
  }
  return body;
}

/** Unique ids, newest-looking first — reverse-lexical puts higher versions on top. */
function dedupeSorted(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => b.localeCompare(a));
}
