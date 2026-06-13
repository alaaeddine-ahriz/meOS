/**
 * Query planner (gist item 8): classify what the user is actually asking before
 * retrieving, so the context pack can be assembled the right way — a "where did
 * I mention X" needs raw sources, a "what changed" needs a timeline, a "what
 * depends on X" leans on the graph.
 *
 * Heuristic and deterministic: it runs on every turn with zero added latency or
 * LLM cost. (An LLM planner can be layered on later for ambiguous queries.)
 */

export type QueryIntent =
  | "ask_fact"
  | "summarize_entity"
  | "find_source"
  | "compare"
  | "trace_timeline"
  | "find_contradictions"
  | "generate_output"
  | "update_memory";

/** Ordered most-specific first; the first matching pattern wins. */
const RULES: Array<{ intent: QueryIntent; pattern: RegExp }> = [
  { intent: "update_memory", pattern: /^\s*(remember|note that|fyi[:,\s]|actually[:,\s]|update:|for the record)/i },
  {
    intent: "generate_output",
    pattern: /\b(write|generate|draft|create|make|produce|prepare)\b.{0,30}\b(brief|timeline|table|report|summary|digest|deck|slides|export|overview document)\b/i,
  },
  { intent: "find_contradictions", pattern: /\b(contradict\w*|conflict\w*|inconsisten\w*|disagree\w*)\b/i },
  { intent: "compare", pattern: /\b(compare|comparison|versus|vs\.?|difference between|differ\b|trade-?offs?)\b/i },
  {
    intent: "trace_timeline",
    pattern: /\b(timeline|history of|over time|chronolog\w*|evolv\w*|evolution|when did|what changed|recently|latest|so far)\b/i,
  },
  {
    intent: "find_source",
    pattern: /\b(where did i|where do i|which (document|source|file|note|doc)|what (document|source|file|note)|find (the )?(source|document|note|file)|cite|citation)\b/i,
  },
  {
    intent: "summarize_entity",
    pattern: /\b(summar\w+|tell me about|who is|who'?s|what is|what'?s|overview of|profile of|brief me on)\b/i,
  },
];

export function classifyIntent(query: string): QueryIntent {
  for (const rule of RULES) {
    if (rule.pattern.test(query)) return rule.intent;
  }
  return "ask_fact";
}
