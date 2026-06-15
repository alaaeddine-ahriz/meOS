# 3. On-device embeddings

Status: Accepted

## Context

Retrieval (vector search over chunks, observations, and wiki pages) needs
embeddings for every piece of text MeOS ingests. The chat/extraction LLM provider
is user-configurable and may be a remote API. Sending every chunk to a remote
embedding API would leak the full corpus off-device and break offline use — at
odds with a local-first, privacy-first product.

## Decision

Always compute embeddings on-device with `@huggingface/transformers`
(transformers.js) using `all-MiniLM-L6-v2`, independent of the chosen LLM
provider. The model is downloaded once to a local cache, and pre-seeded into the
desktop bundle so a packaged app works offline on first launch.

## Consequences

- Embeddings never leave the machine; vector search works fully offline.
- Decouples retrieval from the LLM provider — switching providers (or pointing at
  a local OpenAI-compatible server) doesn't change embeddings or invalidate the
  vector index.
- Adds a model download on first use (mitigated by pre-seeding in desktop builds)
  and runs inference on the host CPU.
- Embedding quality is fixed to one small model; a future change of model would
  require re-embedding the corpus.
