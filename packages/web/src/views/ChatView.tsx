import type { ChatStatus } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, streamChat, type Conversation as ConversationRecord, type EntitySummary, type Message as MessageRecord, type SourceRef } from "../api.js";
import { SourceList } from "../components/SourceList.js";
import { Plus } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { InputGroupAddon } from "@/components/ui/input-group";
import { resolveWikiLinks } from "@/lib/wikilinks";
import { cn } from "@/lib/utils";

export function ChatView() {
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  // sources arrive per streamed reply, keyed by the assistant message's index
  const [liveSources, setLiveSources] = useState<ReadonlyMap<number, SourceRef[]>>(new Map());
  // set when the stream itself assigns the conversation id, so the id change
  // doesn't trigger a refetch that would clobber the in-flight reply
  const streamAssignedId = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.listConversations().then((r) => setConversations(r.conversations)).catch(() => {});
    api.listEntities().then((r) => setEntities(r.entities)).catch(() => {});
  }, []);

  useEffect(() => {
    if (streamAssignedId.current) {
      streamAssignedId.current = false;
      return;
    }
    setLiveSources(new Map());
    if (activeId === null) {
      setMessages([]);
      return;
    }
    api.getMessages(activeId).then((r) => setMessages(r.messages)).catch(() => {});
  }, [activeId]);

  // streamdown renders plain anchors; route internal links through the router
  const onProseClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const anchor = (event.target as HTMLElement).closest("a");
      const href = anchor?.getAttribute("href");
      if (href?.startsWith("/")) {
        event.preventDefault();
        navigate(href);
      }
    },
    [navigate],
  );

  const busy = status === "submitted" || status === "streaming";

  const send = async (text: string) => {
    const assistantIndex = messages.length + 1;
    setError(null);
    setStatus("submitted");
    setMessages((current) => [
      ...current,
      { id: -1, role: "user", content: text, created_at: "" },
      { id: -2, role: "assistant", content: "", created_at: "" },
    ]);

    try {
      for await (const event of streamChat(text, activeId ?? undefined)) {
        if (event.type === "start") {
          if (event.conversationId !== activeId) {
            streamAssignedId.current = true;
            setActiveId(event.conversationId);
          }
          api.listConversations().then((r) => setConversations(r.conversations)).catch(() => {});
        } else if (event.type === "sources") {
          setLiveSources((current) => new Map(current).set(assistantIndex, event.sources));
        } else if (event.type === "delta") {
          setStatus("streaming");
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
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  const onSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text || busy) return;
    void send(text);
  };

  const lastIndex = messages.length - 1;
  const startNew = useMemo(
    () => () => {
      setActiveId(null);
      setError(null);
      setStatus("ready");
    },
    [],
  );

  return (
    <div className="flex h-full">
      <div className="flex w-56 shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between px-4 pb-1 pt-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">history</span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={startNew}
            aria-label="New conversation"
            className="size-6 text-dim hover:bg-card hover:text-paper"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul className="space-y-0.5 px-2 pb-4">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  onClick={() => setActiveId(conversation.id)}
                  className={cn(
                    "block w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                    conversation.id === activeId ? "bg-card text-paper" : "text-faded hover:text-paper",
                  )}
                >
                  {conversation.title ?? `Conversation ${conversation.id}`}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {messages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="rise max-w-md text-center">
              <p className="font-serif text-3xl italic text-faded">What do you want to recall?</p>
              <p className="mt-3 text-sm text-dim">
                Ask about anything you've captured — people, projects, decisions. Answers come only
                from your own knowledge base.
              </p>
            </div>
          </div>
        ) : (
          <Conversation className="flex-1">
            <ConversationContent className="mx-auto w-full max-w-2xl gap-6 px-6 py-8">
              <>
                {messages.map((message, index) => (
                  <Message key={message.id > 0 ? message.id : `pending-${index}`} from={message.role}>
                    <MessageContent className="group-[.is-user]:max-w-[85%] group-[.is-user]:rounded-xl group-[.is-user]:rounded-br-sm group-[.is-user]:border group-[.is-user]:border-line group-[.is-user]:bg-card group-[.is-user]:py-2.5 group-[.is-user]:text-[14px]">
                      {message.role === "assistant" ? (
                        message.content ? (
                          <div onClick={onProseClick} className="text-[15px]">
                            <MessageResponse
                              className="prose-meos"
                              isAnimating={busy && index === lastIndex}
                            >
                              {resolveWikiLinks(message.content, entities)}
                            </MessageResponse>
                            <div className="mt-3">
                              <SourceList sources={liveSources.get(index) ?? []} />
                            </div>
                          </div>
                        ) : (
                          <Shimmer className="text-sm" duration={1.6}>
                            Consulting the knowledge base…
                          </Shimmer>
                        )
                      ) : (
                        message.content
                      )}
                    </MessageContent>
                  </Message>
                ))}
                {error && <p className="text-sm text-ember">⚠ {error}</p>}
              </>
            </ConversationContent>
            <ConversationScrollButton className="border-line bg-desk text-faded hover:bg-card hover:text-paper" />
          </Conversation>
        )}

        <div className="px-6 pb-5 pt-1">
          <PromptInput
            onSubmit={onSubmit}
            className="mx-auto max-w-2xl rounded-xl border-line bg-desk shadow-none focus-within:border-lamp-dim"
          >
            <PromptInputBody>
              <PromptInputTextarea
                placeholder="Ask your second brain…"
                className="min-h-10 text-[14px] text-paper placeholder:text-dim"
              />
              <InputGroupAddon align="inline-end">
                <PromptInputSubmit
                  status={status}
                  className="rounded-lg bg-lamp text-ink hover:bg-lamp/85"
                />
              </InputGroupAddon>
            </PromptInputBody>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
