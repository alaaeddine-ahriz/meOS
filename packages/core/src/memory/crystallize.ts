import { z } from "zod";
import type { Embedder } from "../embedding/embedder.js";
import { extractKnowledge } from "../extract/extractor.js";
import { DEFAULT_SCHEMA_MD, withSchema } from "../knowledge/schema-doc.js";
import { mergeExtraction, type MergeResult } from "../knowledge/merge.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { LlmClient } from "../llm/types.js";

/**
 * Crystallization (gist item 12): a completed work thread becomes a first-class
 * source. Rather than letting the reasoning in a conversation evaporate, MeOS
 * distils the transcript into a structured digest — question, conclusion,
 * decisions, entities, new facts, open questions, reusable lessons — then
 * ingests that digest like any document so its knowledge compounds.
 */

const sessionDigestSchema = z.object({
  /** What the user was trying to figure out. */
  question: z.string(),
  /** The useful conclusion reached, if any. */
  conclusion: z.string(),
  /** Decisions made during the thread. */
  decisions: z.array(z.string()),
  /** Durable facts established (third person, self-contained). */
  facts: z.array(z.string()),
  /** Questions left open. */
  openQuestions: z.array(z.string()),
  /** Reusable lessons / methods worth keeping (procedural memory). */
  lessons: z.array(z.string()),
});

const DIGEST_SYSTEM_PROMPT = `You distil a completed conversation in MeOS, a personal second brain, into a durable session digest.
Capture only what is worth keeping beyond this conversation: the question, the conclusion, decisions, durable facts, open questions, and reusable lessons.
Write facts and lessons in third person, self-contained (understandable without the transcript). If a field has nothing worth keeping, return an empty string or empty list — never pad.`;

export interface SessionCrystal {
  sourceId: number;
  merge: MergeResult;
  /** The human-readable digest that was stored as the session source. */
  digest: string;
}

/** Render the structured digest as the markdown body of the session source. */
function renderDigest(d: z.infer<typeof sessionDigestSchema>): string {
  const section = (title: string, items: string[]) =>
    items.length ? `## ${title}\n${items.map((i) => `- ${i}`).join("\n")}` : "";
  return [
    d.question ? `# ${d.question}` : "# Session",
    d.conclusion ? `## Conclusion\n${d.conclusion}` : "",
    section("Decisions", d.decisions),
    section("Facts", d.facts),
    section("Open questions", d.openQuestions),
    section("Lessons", d.lessons),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Distil one conversation into a session source and merge its knowledge.
 * Returns undefined when the conversation is empty or yields nothing durable.
 */
export async function crystallizeSession(deps: {
  store: KnowledgeStore;
  llm: LlmClient;
  embedder: Embedder;
  conversationId: number;
  schema?: string;
}): Promise<SessionCrystal | undefined> {
  const { store, llm, embedder, conversationId } = deps;
  const schema = deps.schema ?? DEFAULT_SCHEMA_MD;

  const messages = store.listMessages(conversationId);
  if (messages.length === 0) return undefined;

  const transcript = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  const distilled = await llm.completeStructured({
    system: withSchema(DIGEST_SYSTEM_PROMPT, schema),
    cacheSystem: true,
    schema: sessionDigestSchema,
    schemaName: "session_digest",
    messages: [{ role: "user", content: `Distil this conversation:\n\n${transcript}` }],
  });

  // Nothing durable came out of the thread — don't create an empty source.
  const hasContent =
    distilled.conclusion.trim() !== "" ||
    distilled.decisions.length > 0 ||
    distilled.facts.length > 0 ||
    distilled.lessons.length > 0;
  if (!hasContent) return undefined;

  const digest = renderDigest(distilled);
  const title = distilled.question.trim() ? `Session: ${distilled.question.slice(0, 80)}` : `Session ${conversationId}`;
  const sourceId = store.createSource({ type: "session", title, content: digest });

  // Extract knowledge from the digest and merge it like any source. "session"
  // source type carries its own quality weight in the confidence policy.
  const extraction = await extractKnowledge(llm, { title, text: digest }, schema);
  const merge = await mergeExtraction(store, embedder, extraction, sourceId, digest);
  for (const id of merge.staleEntityIds) store.recordStaleSource(id, sourceId);

  return { sourceId, merge, digest };
}
