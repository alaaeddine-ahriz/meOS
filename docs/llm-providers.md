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
- **OpenRouter** — one key, hundreds of models (`vendor/model` slugs). Reaches
  models over OpenAI-compatible Chat Completions, so it reuses the OpenAI client.
- **Local, OpenAI-compatible** servers (LM Studio, llama.cpp, Ollama's `/v1`) —
  point at the endpoint (e.g. `http://localhost:1234/v1`), no API key, nothing
  leaves the machine. Driven by the OpenAI client.

## Configuration

Provider, model, and API key are set in **Settings (⌘,)** and persisted in
`data/meos.db` (the `settings` table) — saving never touches source-adjacent
files. Changes apply immediately, no restart.

Fallbacks, used only when no key was set in Settings:

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` —
  env API keys.
- `MEOS_LLM_PROVIDER` — overrides the provider per run.

## Backend: cloud API or local coding agent

The whole app's intelligence runs on **one** global backend, a binary choice:

- **`api`** (default) — the cloud provider configured above.
- **`agent`** — a local **coding-agent CLI** (Claude Code by default; also Codex,
  Cursor, Gemini, Copilot when detected). The CLI's own subscription does the
  inference, so AI features cost nothing against an API key.

The runtime keeps a client per **task group** — `background` (extraction,
contradiction detection, consolidation, OCR, crystallization), `wiki` (the
agentic maintainer), and `assistant` (profile drafting) — but all groups run on
the single chosen backend (`intelligence-routing.ts`). The backend is selected in
Settings; anything unset resolves to the safe `api` default. Available agents are
discovered via `GET /api/coding-agents`.

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
