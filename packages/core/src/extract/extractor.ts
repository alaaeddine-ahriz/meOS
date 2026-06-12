import type { LlmClient } from "../llm/types.js";
import { extractionSchema, type Extraction } from "./schema.js";

const SYSTEM_PROMPT = `You are the knowledge extraction engine of MeOS, a personal second brain.
You read documents the user has captured and extract what matters into a knowledge graph.

Rules:
- Extract entities only when they matter to the user's world: people they interact with, projects they work on, organisations, recurring concepts, places, and decisions that were made.
- Skip generic terms, document boilerplate, and entities mentioned only in passing with no substance.
- "decision" entities capture choices that were made: name them descriptively (e.g. "Decision: use SQLite for storage").
- Observations are atomic, self-contained facts about one entity, phrased in third person, understandable without the source document. Include dates when the document states them.
- Every observation must reference an entity from your entities list by its exact name.
- Relationship "from" and "to" must also be exact entity names from your list; labels are short verb phrases ("works on", "founded", "part of").
- Never invent facts that are not supported by the document.`;

export async function extractKnowledge(
  llm: LlmClient,
  source: { title: string; text: string },
): Promise<Extraction> {
  return llm.completeStructured({
    system: SYSTEM_PROMPT,
    cacheSystem: true,
    schema: extractionSchema,
    schemaName: "knowledge_extraction",
    messages: [
      {
        role: "user",
        content: `Document title: ${source.title}\n\nDocument content:\n${source.text}`,
      },
    ],
  });
}
