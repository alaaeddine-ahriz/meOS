import { effectiveDate, type KnowledgeStore } from "./knowledge/store.js";
import { proposeResolution } from "./memory/resolution.js";

/**
 * Output modes (gist item 14): the wiki shouldn't only answer in prose. The same
 * knowledge base projects into briefs, timelines, dependency graphs, and
 * contradiction reports — the artifacts a consultant/director actually hands
 * over. All deterministic (no LLM): they assemble stored knowledge into portable
 * Markdown, so they're cheap, reproducible, and exportable.
 */

export type OutputMode = "decision_brief" | "timeline" | "dependency_graph" | "contradiction_report" | "meeting_brief";

function confidenceTag(confidence: number): string {
  return confidence >= 0.7 ? "" : confidence >= 0.4 ? " _(tentative)_" : " _(low confidence)_";
}

/**
 * Decision brief: every recorded decision, newest first, with the entity it
 * concerns and a confidence caveat. The director's "what have we committed to".
 */
export function decisionBrief(store: KnowledgeStore): string {
  const decisions = store.observationsByKind("decision");
  if (decisions.length === 0) return "# Decision brief\n\n_No decisions recorded yet._";
  const lines = decisions.map((d) => {
    const when = effectiveDate(d).slice(0, 10);
    const source = d.source_id ? store.getSource(d.source_id)?.title : undefined;
    return `- **${when}** — ${d.text}${confidenceTag(d.confidence)}${source ? ` _(source: ${source})_` : ""}`;
  });
  return `# Decision brief\n\n${lines.join("\n")}`;
}

/**
 * Timeline for one entity: its dated claims in chronological order. The history
 * of a person/project at a glance.
 */
export function entityTimeline(store: KnowledgeStore, entityId: number): string {
  const entity = store.getEntity(entityId);
  if (!entity) return "_Unknown entity._";
  const dated = store
    .visibleObservations(entityId)
    .map((o) => ({ when: effectiveDate(o), text: o.text, confidence: o.confidence }))
    .sort((a, b) => a.when.localeCompare(b.when));
  if (dated.length === 0) return `# Timeline — ${entity.name}\n\n_No dated facts yet._`;
  const lines = dated.map((d) => `- **${d.when.slice(0, 10)}** — ${d.text}${confidenceTag(d.confidence)}`);
  return `# Timeline — ${entity.name}\n\n${lines.join("\n")}`;
}

/**
 * Dependency graph around an entity: its impact-bearing edges (uses, depends on,
 * blocks, supports…) rendered as a Mermaid diagram plus a readable edge list —
 * "what changes if I touch this".
 */
export function dependencyGraph(store: KnowledgeStore, entityId: number): string {
  const entity = store.getEntity(entityId);
  if (!entity) return "_Unknown entity._";
  const edges = store.relationshipsFor(entityId);
  if (edges.length === 0) return `# Dependencies — ${entity.name}\n\n_No connections recorded._`;

  const safe = (name: string) => name.replace(/[^A-Za-z0-9]+/g, "_");
  const mermaid = edges.map(
    (e) => `  ${safe(e.from_name)}["${e.from_name}"] -->|${e.label}| ${safe(e.to_name)}["${e.to_name}"]`,
  );
  const list = edges.map((e) =>
    e.from_entity === entityId ? `- ${entity.name} **${e.label}** ${e.to_name}` : `- ${e.from_name} **${e.label}** ${entity.name}`,
  );
  return [
    `# Dependencies — ${entity.name}`,
    "",
    "```mermaid",
    "graph LR",
    ...mermaid,
    "```",
    "",
    ...list,
  ].join("\n");
}

/**
 * Contradiction report: open conflicts with the system's suggested resolution
 * (recency / authority / confidence). The "what needs your decision" list.
 */
export function contradictionReport(store: KnowledgeStore): string {
  const open = store.unresolvedContradictions();
  if (open.length === 0) return "# Contradiction report\n\n_No open contradictions._";
  const blocks = open.map((c) => {
    const proposal = proposeResolution(store, c.id);
    return [
      `## ${c.entity_name}`,
      `- A: ${c.text_a}`,
      `- B: ${c.text_b}`,
      c.note ? `- Note: ${c.note}` : "",
      proposal ? `- **Suggested:** ${proposal.suggested} — ${proposal.rationale}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `# Contradiction report\n\n${blocks.join("\n\n")}`;
}

/**
 * Meeting-prep brief for an entity: summary, established facts, decisions,
 * connections, and any open contradictions — everything to walk into a meeting
 * about a person/project/org prepared.
 */
export function meetingBrief(store: KnowledgeStore, entityId: number): string {
  const entity = store.getEntity(entityId);
  if (!entity) return "_Unknown entity._";
  const observations = store.visibleObservations(entityId);
  const facts = observations.filter((o) => o.kind === "fact" || o.kind === "requirement" || o.kind === "preference");
  const decisions = observations.filter((o) => o.kind === "decision");
  const risks = observations.filter((o) => o.kind === "risk" || o.kind === "open_question");
  const edges = store.relationshipsFor(entityId);

  const section = (title: string, items: string[]) => (items.length ? `## ${title}\n${items.join("\n")}` : "");
  return [
    `# Meeting brief — ${entity.name} (${entity.type})`,
    entity.summary ? `\n${entity.summary}` : "",
    section("Key facts", facts.map((o) => `- ${o.text}${confidenceTag(o.confidence)}`)),
    section("Decisions", decisions.map((o) => `- ${o.text}`)),
    section("Risks & open questions", risks.map((o) => `- ${o.text}`)),
    section(
      "Connections",
      edges.map((e) =>
        e.from_entity === entityId ? `- ${e.label} ${e.to_name}` : `- ${e.from_name} ${e.label}`,
      ),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}
