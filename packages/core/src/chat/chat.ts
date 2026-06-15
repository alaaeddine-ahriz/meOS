import type { Embedder } from "../embedding/embedder.js";
import type { MeosEvents } from "../events.js";
import type { KnowledgeStore, SourceRef, SubgraphEdge, SubgraphNode } from "../knowledge/store.js";
import type { ChatMessage, LlmClient } from "../llm/types.js";
import { withProfile } from "../profile/profile-doc.js";
import { buildChatTools } from "./tools.js";

export type ChatResponseEvent =
  | { type: "sources"; sources: SourceRef[] }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId?: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId?: string; toolName: string; output: unknown }
  | { type: "graph"; nodes: SubgraphNode[]; links: SubgraphEdge[] }
  | { type: "delta"; text: string };

const SYSTEM_PROMPT = `You are MeOS, the user's personal second brain. You answer questions using ONLY the user's own accumulated knowledge base, which you reach through tools — never your own world knowledge.

You have tools to consult that knowledge base:
- search_knowledge: hybrid search over the wiki, curated facts, and source documents. Your default move — call it before answering almost anything, and again with refined queries to follow a thread or fill a gap.
- read_wiki_page: the full compiled summary of one entity.
- get_entity: one entity's dated, confidence-scored facts and relationships.
- explore_graph: a MULTI-HOP walk of the graph from one entity, returning the whole connected neighbourhood (with a depth you choose) — for impact, dependency, and "how does this all fit together" questions.
- fetch_email_threads (only when a Gmail account is connected): pull the text of the user's actual email threads. Email bodies are NOT in the knowledge base, so reach for this when a question needs the contents of correspondence with someone; cite what you find in prose.

How to work:
- Reach for tools first. Don't answer a substantive question before searching; if a first search is thin, refine the query or pivot to read_wiki_page / get_entity / explore_graph. Gather generously — it is better to pull more of the picture than you end up needing.
- Map the connections, fully. Whenever a question centres on a specific entity — a person, project, team, or topic — call explore_graph on it (after searching) before you answer. Start around depth 2; if the returned map still feels partial, or a neighbour you discover looks pivotal, call explore_graph again (on that neighbour, or at a greater depth) and keep going until you have the COMPLETE connected picture. Iterate as many hops as the question needs. ALWAYS do this for anything about impact, dependencies, what relates to what, or what a change would affect.
- Gather broadly, then answer narrowly. Use everything the tools surface to reason, but the written answer should be exhaustive on substance while staying tight — include every fact and connection that bears on the question, and leave out the rest. The full set of entities you traversed is drawn for the user as an interactive graph beneath your answer, so you don't need to enumerate the whole graph in prose.
- Never draw the graph yourself. The traversal is already rendered as an interactive diagram for the user, so do NOT reproduce it as a Mermaid block, ASCII art, or any other diagram in your answer — refer to the connections in prose instead. Use code blocks only for actual code or data the user asked for.
- Synthesise across what the tools return rather than quoting isolated fragments. Mention which sources or entities an answer draws on, in prose.
- When you mention an entity the tools surfaced (one with a "### " or "# " heading), wrap its name in double brackets — e.g. [[Orion]] — so it links to that entity's wiki page. Never bracket names the tools did not surface.
- Tool results annotate facts with confidence scores. State well-supported facts (>= 0.7) plainly; explicitly hedge weakly-supported ones ("a single note from March suggests...").
- Each fact is tagged with a date and, where relevant, a recency marker. Today's date is given below — judge pertinence by it: when claims about the same thing differ, trust the most recent; explicitly flag answers that rest on a fact marked "stale" or old enough to have lapsed ("as of early 2024 — this may be out of date"). A fact marked "upcoming" is not yet true, so describe it as planned, not current.
- Surface relevant connections the user may not have asked about directly ("this relates to...").
- If the tools turn up nothing that answers the question, say so plainly. Never fill gaps with general world knowledge or invention — you are an interface to the user's knowledge, not a general assistant.
- For broad questions ("what should I focus on?", "summarise my projects", "what matters in my current work?"), let the user profile lead: weight the user's stated projects, work context, and goals as the priority signal.
- Be concise and specific. This is a thinking tool; answer the question first, elaborate only where it helps.`;

const HISTORY_LIMIT = 20;
/** Tool-loop budget per turn: enough for a few search→read→refine rounds. */
const MAX_AGENT_STEPS = 10;

export class ChatService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly llm: LlmClient,
    private readonly embedder: Embedder,
    /** When provided, onChatAnswer fires after each reply (file-back automation). */
    private readonly events?: MeosEvents,
    /**
     * Supplies the user profile lens at answer time (re-read each turn so edits
     * apply immediately). Returns "" when the profile is empty — injection is
     * then a no-op.
     */
    private readonly getProfileContext?: () => string,
    /**
     * Builds a Gmail thread fetcher for this turn, or undefined when no Gmail
     * account is connected. Re-evaluated per turn so connecting/disconnecting
     * takes effect immediately and the `fetch_email_threads` tool only appears
     * when it can actually work.
     */
    private readonly gmailFetcher?: () => ((query: string) => Promise<string>) | undefined,
  ) {}

  /**
   * Persist the user message, then let the model drive a tool loop over the
   * knowledge base — streaming its reasoning, each tool call and result, the
   * sources it touches, and the answer text as they arrive. The reply is
   * persisted (with its citations) once the loop completes.
   */
  async *respond(conversationId: number, userMessage: string): AsyncIterable<ChatResponseEvent> {
    const history = this.store
      .listMessages(conversationId)
      .slice(-HISTORY_LIMIT)
      .map((m): ChatMessage => ({ role: m.role, content: m.content }));

    this.store.addMessage(conversationId, "user", userMessage);
    if (history.length === 0) {
      this.store.setConversationTitle(conversationId, userMessage.slice(0, 80));
    }

    const dated = `${SYSTEM_PROMPT}\n\nToday's date is ${new Date().toISOString().slice(0, 10)}.`;
    const system = withProfile(dated, this.getProfileContext?.() ?? "");

    // The tools share these collectors: `sources` grows as the model consults
    // documents (so we can announce citations live), and `graph` accumulates every
    // entity/edge the model traverses (drawn under the answer when the turn ends).
    const { tools, sources, graph } = buildChatTools(this.store, this.embedder, {
      gmail: this.gmailFetcher?.(),
    });
    const messages: ChatMessage[] = [...history, { role: "user", content: userMessage }];

    let reply = "";
    let announced = 0;
    const announceSources = () => {
      if (sources.size > announced) {
        announced = sources.size;
        return { type: "sources" as const, sources: [...sources.values()] };
      }
      return null;
    };

    for await (const chunk of this.llm.streamAgent({ system, messages, tools, maxSteps: MAX_AGENT_STEPS })) {
      switch (chunk.type) {
        case "reasoning":
          yield { type: "reasoning", text: chunk.text };
          break;
        case "tool-call":
          yield { type: "tool-call", toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input };
          break;
        case "tool-result": {
          yield { type: "tool-result", toolCallId: chunk.toolCallId, toolName: chunk.toolName, output: chunk.output };
          // A tool just ran — surface any new documents it drew on.
          const event = announceSources();
          if (event) yield event;
          break;
        }
        case "text":
          reply += chunk.text;
          yield { type: "delta", text: chunk.text };
          break;
      }
    }

    // A final sweep, in case the last tool's sources weren't flushed mid-loop.
    const trailing = announceSources();
    if (trailing) yield trailing;

    // The consolidated traversal — every entity/edge the model walked this turn —
    // drawn under the answer as the interactive graph behind it.
    if (graph.nodes.size > 0) {
      yield { type: "graph", nodes: [...graph.nodes.values()], links: [...graph.edges.values()] };
    }

    const messageId = this.store.addMessage(conversationId, "assistant", reply);
    if (sources.size > 0) {
      this.store.linkMessageSources(messageId, [...sources.keys()]);
    }
    // Automation hook: a turn completed — a subscriber may decide the answer is
    // worth filing back into memory. Fire-and-forget so it never delays the UI.
    void this.events?.emit("onChatAnswer", {
      conversationId,
      messageId,
      question: userMessage,
      answer: reply,
    });
  }
}
