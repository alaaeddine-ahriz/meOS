import { useEffect, useRef, useState } from "react";
import { api, streamChat, type Conversation, type EntitySummary, type Message } from "../api.js";
import { Markdown } from "../components/Markdown.js";

export function ChatView() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.listConversations().then((r) => setConversations(r.conversations)).catch(() => {});
    api.listEntities().then((r) => setEntities(r.entities)).catch(() => {});
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (activeId === null) {
      setMessages([]);
      return;
    }
    api.getMessages(activeId).then((r) => setMessages(r.messages)).catch(() => {});
  }, [activeId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const message = draft.trim();
    if (!message || streaming) return;
    setDraft("");
    setError(null);
    setStreaming(true);
    setMessages((current) => [
      ...current,
      { id: -1, role: "user", content: message, created_at: "" },
      { id: -2, role: "assistant", content: "", created_at: "" },
    ]);

    try {
      for await (const event of streamChat(message, activeId ?? undefined)) {
        if (event.type === "start") {
          setActiveId(event.conversationId);
          api.listConversations().then((r) => setConversations(r.conversations)).catch(() => {});
        } else if (event.type === "delta") {
          setMessages((current) => {
            const next = [...current];
            const last = next[next.length - 1]!;
            next[next.length - 1] = { ...last, content: last.content + event.text };
            return next;
          });
        } else if (event.type === "error") {
          setError(event.message);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex h-full">
      <div className="flex w-56 shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between px-4 py-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">history</span>
          <button
            onClick={() => setActiveId(null)}
            className="rounded border border-line px-2 py-0.5 text-xs text-faded transition-colors hover:border-lamp-dim hover:text-paper"
          >
            + new
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto px-2 pb-4">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                onClick={() => setActiveId(conversation.id)}
                className={`w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
                  conversation.id === activeId ? "bg-card text-paper" : "text-faded hover:text-paper"
                }`}
              >
                {conversation.title ?? `Conversation ${conversation.id}`}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="rise max-w-md text-center">
                <p className="font-serif text-3xl italic text-faded">What do you want to recall?</p>
                <p className="mt-3 text-sm text-dim">
                  Ask about anything you've captured — people, projects, decisions. Answers come only
                  from your own knowledge base.
                </p>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
              {messages.map((message, index) => (
                <div key={index} className={message.role === "user" ? "flex justify-end" : ""}>
                  {message.role === "user" ? (
                    <div className="max-w-[85%] rounded-xl rounded-br-sm border border-line bg-card px-4 py-2.5 text-[14px] text-paper">
                      {message.content}
                    </div>
                  ) : (
                    <div className="text-[15px]">
                      {message.content ? (
                        <Markdown text={message.content} entities={entities} />
                      ) : (
                        <span className="working-dot inline-block h-2 w-2 rounded-full bg-lamp" />
                      )}
                    </div>
                  )}
                </div>
              ))}
              {error && <p className="text-sm text-ember">⚠ {error}</p>}
            </div>
          )}
        </div>

        <div className="border-t border-line px-6 py-4">
          <div className="mx-auto flex max-w-2xl items-end gap-3 rounded-xl border border-line bg-desk px-4 py-3 focus-within:border-lamp-dim">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={Math.min(6, Math.max(1, draft.split("\n").length))}
              placeholder="Ask your second brain..."
              className="max-h-40 flex-1 resize-none bg-transparent text-[14px] text-paper outline-none placeholder:text-dim"
            />
            <button
              onClick={() => void send()}
              disabled={streaming || !draft.trim()}
              className="rounded-lg bg-lamp px-3 py-1 text-sm font-medium text-ink transition-opacity disabled:opacity-30"
            >
              ↵
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
