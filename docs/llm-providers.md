# LLM providers

MeOS talks to LLMs through the [Vercel AI SDK](https://ai-sdk.dev) (`ai` +
`@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google`), wrapped behind one
internal `LlmClient` interface so every stage (extraction, wiki writing, chat,
digests) uses a single client with unified completion / structured-output /
streaming / tool-use.

## Supported providers

- **Anthropic** (default)
- **OpenAI**
- **Google**
- **Local, OpenAI-compatible** servers (LM Studio, llama.cpp, Ollama's `/v1`) —
  point at the endpoint (e.g. `http://localhost:1234/v1`), no API key, nothing
  leaves the machine. Driven by the OpenAI client.

## Configuration

Provider, model, and API key are set in **Settings (⌘,)** and persisted in
`data/meos.db` (the `settings` table) — saving never touches source-adjacent
files. Changes apply immediately, no restart.

Fallbacks, used only when no key was set in Settings:

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` — env API keys.
- `MEOS_LLM_PROVIDER` — overrides the provider per run.

## Local embeddings

Embeddings always run **on-device**, regardless of the chat/extraction provider:
[`@huggingface/transformers`](https://github.com/huggingface/transformers.js)
with `all-MiniLM-L6-v2`, downloaded once to a local cache. This keeps vector
search private and offline by construction. In a packaged desktop app the model
is pre-seeded into the bundle so first launch works with no download. See
[`data-model.md`](data-model.md) for how embeddings feed retrieval.

## Testing

Tests run with no LLM and no network: provider calls are stubbed behind
`LlmClient`, so `pnpm test` is deterministic.
