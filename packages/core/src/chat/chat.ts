import type { Embedder } from "../embedding/embedder.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { ChatMessage, LlmClient } from "../llm/types.js";
import { buildContextPack } from "./retrieval.js";

const SYSTEM_PROMPT = `You are MeOS, the user's personal second brain. You answer questions using ONLY the user's own accumulated knowledge base, provided as context with each question.

Rules:
- Synthesise across sources rather than quoting isolated fragments. Mention which sources or entities an answer draws on, in prose.
- The context annotates facts with confidence scores. State well-supported facts (>= 0.7) plainly; explicitly hedge weakly-supported ones ("a single note from March suggests...").
- Surface relevant connections the user may not have asked about directly ("this relates to...").
- If the knowledge base does not contain enough information to answer confidently, say so plainly. Never fill gaps with general world knowledge or invention — you are an interface to the user's knowledge, not a general assistant.
- Be concise and specific. This is a thinking tool; answer the question first, elaborate only where it helps.`;

const HISTORY_LIMIT = 20;

export class ChatService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly llm: LlmClient,
    private readonly embedder: Embedder,
  ) {}

  /**
   * Persist the user message, retrieve context, and stream the assistant
   * reply (persisted once the stream completes).
   */
  async *respond(conversationId: number, userMessage: string): AsyncIterable<string> {
    const history = this.store
      .listMessages(conversationId)
      .slice(-HISTORY_LIMIT)
      .map((m): ChatMessage => ({ role: m.role, content: m.content }));

    this.store.addMessage(conversationId, "user", userMessage);
    if (history.length === 0) {
      this.store.setConversationTitle(conversationId, userMessage.slice(0, 80));
    }

    const context = await buildContextPack(this.store, this.embedder, userMessage);

    const messages: ChatMessage[] = [
      ...history,
      {
        role: "user",
        content: `<knowledge_context>\n${context.text}\n</knowledge_context>\n\n${userMessage}`,
      },
    ];

    let reply = "";
    for await (const delta of this.llm.stream({
      system: SYSTEM_PROMPT,
      cacheSystem: true,
      messages,
    })) {
      reply += delta;
      yield delta;
    }
    this.store.addMessage(conversationId, "assistant", reply);
  }
}
