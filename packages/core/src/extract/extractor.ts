import { DEFAULT_SCHEMA_MD, RELATIONSHIP_VOCABULARY } from "../knowledge/schema-doc.js";
import type { LlmClient } from "../llm/types.js";
import { extractionSchema, type Extraction } from "./schema.js";

const SYSTEM_PROMPT = `You are the knowledge extraction engine of MeOS, a personal second brain.
You read documents the user has captured and extract what matters into a knowledge graph,
following the schema below.

Rules:
- Extract entities only when they matter to the user's world (see the schema's entity types).
- Skip generic terms, document boilerplate, and entities mentioned only in passing with no substance.
- Observations are atomic, self-contained facts about one entity, phrased in third person, understandable without the source document. Include dates when the document states them.
- Every observation must reference an entity from your entities list by its exact name.
- Relationship "from" and "to" must also be exact entity names from your list. Prefer labels from the controlled vocabulary: ${RELATIONSHIP_VOCABULARY.join(", ")}.
- Never invent facts that are not supported by the document.`;

export async function extractKnowledge(
  llm: LlmClient,
  source: { title: string; text: string },
  schema: string = DEFAULT_SCHEMA_MD,
): Promise<Extraction> {
  return llm.completeStructured({
    system: `${SYSTEM_PROMPT}\n\n--- SCHEMA ---\n${schema}`,
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
