import type { Extraction } from "../../extract/schema.js";
import type { TaskItem } from "../types.js";
import { observation } from "./helpers.js";

/**
 * Map a Google Tasks task to an extraction. A task is modelled as a `task`-kind
 * observation on a concept entity named after the task itself, so it stays
 * searchable + answerable ("what do I need to do…") while carrying provenance
 * back to Google Tasks through the source the orchestrator materializes. The
 * task's list anchors it ("in <list>") and the due date feeds the temporal
 * layer. Completed tasks record their done state so a query can distinguish them.
 *
 * Unlike contacts/calendar/gmail this kind does not synthesize people edges — a
 * task is a thing-to-do, not a relationship — but linking to projects/people is a
 * natural future extension via the existing entity-linking pass.
 */
export function mapTask(item: TaskItem): Extraction {
  const due = item.due ? item.due.slice(0, 10) : null;
  const where = item.taskListTitle ? ` (list: ${item.taskListTitle})` : "";
  const state = item.completed ? "Completed" : "To do";
  const dueClause = due ? `, due ${due}` : "";
  const notesClause = item.notes ? ` — ${item.notes}` : "";

  const entities: Extraction["entities"] = [
    {
      name: item.title,
      type: "concept",
      aliases: [],
      summary: "",
      relevance: "high",
    },
  ];

  const observations: Extraction["observations"] = [
    observation({
      entity: item.title,
      claim: `${state} task${where}${dueClause}.${notesClause}`,
      kind: "task",
      confidence: 0.9,
      validFrom: due,
    }),
  ];

  return { entities, relationships: [], observations };
}
