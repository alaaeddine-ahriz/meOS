import { z } from "zod";
import type { MeosEvents } from "../events.js";
import { DEFAULT_SCHEMA_MD, withSchema } from "../knowledge/schema-doc.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { LlmClient } from "../llm/types.js";

const judgementSchema = z.object({
  conflicts: z.array(
    z.object({
      new_id: z.number(),
      existing_id: z.number(),
      kind: z.enum(["supersedes", "contradicts"]),
      note: z.string(),
    }),
  ),
});

const SYSTEM_PROMPT = `You are the consistency checker of MeOS, a personal knowledge base.
You compare newly captured facts about an entity against facts already on record and report conflicts.

- "supersedes": the new fact is an update of an existing one — both cannot be current, and the new one is more recent ("moved to Berlin" supersedes "lives in Paris").
- "contradicts": the facts disagree and it is not clear which is right; a human should look.
- Facts that simply cover different aspects of the entity are NOT conflicts. Report only genuine incompatibilities.
- Use the numeric ids exactly as given. If there are no conflicts, return an empty list.`;

export interface ContradictionSummary {
  superseded: number;
  contradictions: number;
}

/**
 * Compare each new observation against the entity's prior knowledge.
 * Supersession retires the old fact; genuine contradictions are recorded and
 * surfaced for review — never silently left in place.
 */
export async function detectContradictions(
  store: KnowledgeStore,
  llm: LlmClient,
  newObservationIds: number[],
  schema: string = DEFAULT_SCHEMA_MD,
  /** When provided, onContradiction fires for each conflict recorded for review. */
  events?: MeosEvents,
): Promise<ContradictionSummary> {
  const summary: ContradictionSummary = { superseded: 0, contradictions: 0 };
  if (newObservationIds.length === 0) return summary;

  const newIds = new Set(newObservationIds);
  const byEntity = new Map<number, number[]>();
  for (const id of newObservationIds) {
    const observation = store.getObservation(id);
    if (!observation) continue;
    byEntity.set(observation.entity_id, [...(byEntity.get(observation.entity_id) ?? []), id]);
  }

  for (const [entityId, entityNewIds] of byEntity) {
    const all = store.activeObservations(entityId);
    const fresh = all.filter((o) => newIds.has(o.id));
    const prior = all.filter((o) => !newIds.has(o.id));
    if (fresh.length === 0 || prior.length === 0) continue;

    const entity = store.getEntity(entityId)!;
    const judgement = await llm.completeStructured({
      system: withSchema(SYSTEM_PROMPT, schema),
      cacheSystem: true,
      schema: judgementSchema,
      schemaName: "contradiction_judgement",
      messages: [
        {
          role: "user",
          content: [
            `Entity: ${entity.name} (${entity.type})`,
            "",
            "Existing facts:",
            ...prior.map((o) => `- id ${o.id}: ${o.text}`),
            "",
            "New facts:",
            ...fresh.map((o) => `- id ${o.id}: ${o.text}`),
          ].join("\n"),
        },
      ],
    });

    for (const conflict of judgement.conflicts) {
      const validPair =
        fresh.some((o) => o.id === conflict.new_id) &&
        prior.some((o) => o.id === conflict.existing_id);
      if (!validPair) continue;
      if (conflict.kind === "supersedes") {
        store.markSuperseded(conflict.existing_id, conflict.new_id);
        store.logAudit(
          "supersede",
          `obs ${conflict.existing_id} superseded by ${conflict.new_id} on ${entity.name}: ${conflict.note}`,
        );
        summary.superseded++;
      } else {
        const contradictionId = store.createContradiction(
          conflict.new_id,
          conflict.existing_id,
          conflict.note,
        );
        store.logAudit("contradiction", `flagged on ${entity.name}: ${conflict.note}`);
        summary.contradictions++;
        await events?.emit("onContradiction", { contradictionId, entityId });
      }
    }
    if (judgement.conflicts.length > 0) store.markWikiStale(entityId);
  }

  return summary;
}
