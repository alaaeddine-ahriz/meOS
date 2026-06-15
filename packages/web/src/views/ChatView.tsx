import type { ChatStatus } from "ai";
import { FileText, Library, Paperclip, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  api,
  streamChat,
  type EntitySummary,
  type GraphLink,
  type GraphNode,
  type LlmErrorKind,
  type Message as MessageRecord,
  type SourceRef,
} from "../api.js";
import { DiffView } from "../components/DiffView.js";
import { SourceList } from "../components/SourceList.js";
import { Button } from "@/components/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolState,
} from "@/components/ai-elements/tool";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { ForceGraph } from "../components/ForceGraph.js";
import { WikiPageView } from "./WikiPage.js";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { InputGroupAddon } from "@/components/ui/input-group";
import { ENTITY_TYPES } from "@/lib/entity-meta";
import { resolveWikiLinks, wikiSlugFromHref } from "@/lib/wikilinks";
import { cn } from "@/lib/utils";

const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  { label: "Catch me up", prompt: "What has changed across my notes recently?" },
  { label: "About someone", prompt: "Tell me about the people I've been working with lately." },
  { label: "Project status", prompt: "Summarise the current state of my active projects." },
  { label: "Recall a decision", prompt: "What decisions have I made recently, and why?" },
  { label: "Edit my profile", prompt: "/profile " },
];

/** Slash commands surfaced when the composer input begins with "/". */
const SLASH_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "/profile", description: "Tell MeOS what to change about your profile" },
];

// A `/profile` reply embeds the change as a diff between these markers (see the
// server's profile-command). The chat renders it as a real diff + an action.
const PROFILE_DIFF_RE = /@@PROFILE_DIFF@@\n([\s\S]*?)\n@@END@@/;

/** Split an assistant reply into its prose and an optional embedded profile diff. */
function splitProfileEdit(content: string): { text: string; patch: string | null } {
  const match = PROFILE_DIFF_RE.exec(content);
  if (!match) return { text: content, patch: null };
  return { text: content.slice(0, match.index).trim(), patch: match[1]!.trim() };
}

// Text formats MeOS can read; references to other files are declined client-side.
const TEXT_FILE_ACCEPT = ".md,.markdown,.txt,.csv,.json,.org";
const MAX_FILE_CHARS = 20000;

interface FileRef {
  name: string;
  text: string;
}

const FILE_BLOCK = /<file name="([^"]*)">[\s\S]*?<\/file>\n?/g;
const LEADING_MENTION = /^\[\[([^\]]+)\]\]\s*/;

/**
 * Split a sent user message back into its parts: the file blocks and leading
 * wiki [[mentions]] the composer injected, plus the plain text the user typed —
 * so references render as chips rather than raw markup in the bubble.
 */
function parseUserMessage(content: string): { text: string; files: string[]; wikis: string[] } {
  const files: string[] = [];
  let rest = content.replace(FILE_BLOCK, (_match, name: string) => {
    files.push(name);
    return "";
  });
  rest = rest.trimStart();
  const wikis: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = LEADING_MENTION.exec(rest)) !== null) {
    wikis.push(match[1]!);
    rest = rest.slice(match[0].length);
  }
  return { text: rest.trim(), files, wikis };
}

/**
 * One step in an assistant turn's live agent trace: either the model's
 * (accreting) private reasoning, or a tool call with its eventual result. Kept
 * in arrival order so the UI reads as "thought → consulted → thought → answered".
 */
type AgentPart =
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      toolCallId?: string;
      toolName: string;
      input: unknown;
      output?: unknown;
      state: ToolState;
    };

/** Merge a reasoning delta into the trailing reasoning part, or open a new one. */
function appendReasoning(parts: AgentPart[], text: string): AgentPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === "reasoning") {
    return [...parts.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...parts, { kind: "reasoning", text }];
}

/** Attach a tool result to its pending call (matched by id, else by name). */
function settleTool(
  parts: AgentPart[],
  toolCallId: string | undefined,
  toolName: string,
  output: unknown,
): AgentPart[] {
  const next = [...parts];
  for (let i = next.length - 1; i >= 0; i--) {
    const part = next[i]!;
    if (part.kind !== "tool" || part.output !== undefined) continue;
    const matches = toolCallId ? part.toolCallId === toolCallId : part.toolName === toolName;
    if (matches) {
      next[i] = { ...part, output, state: "output-available" };
      return next;
    }
  }
  return next;
}

// Human-readable verb per knowledge tool, shown in the trace header.
const TOOL_LABELS: Record<string, string> = {
  search_knowledge: "Searched the knowledge base",
  read_wiki_page: "Read a wiki page",
  get_entity: "Looked up an entity",
  explore_graph: "Explored the graph",
};

/** The argument worth showing inline in a tool header ("…for 'Orion'"). */
function toolArg(input: unknown): string | null {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const value = record.query ?? record.entity ?? record.name;
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function ChatView() {
  // the active conversation lives in the URL (?c=<id>) so the command palette
  // can open past chats; no `c` means a fresh conversation
  const [searchParams, setSearchParams] = useSearchParams();
  const activeId = searchParams.has("c") ? Number(searchParams.get("c")) : null;
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<{ message: string; kind?: LlmErrorKind } | null>(null);
  // sources arrive per streamed reply, keyed by the assistant message's index
  const [liveSources, setLiveSources] = useState<ReadonlyMap<number, SourceRef[]>>(new Map());
  // the agent's live trace (reasoning + tool calls, in arrival order), keyed the
  // same way — so each turn shows the model thinking and consulting the brain
  const [liveTrace, setLiveTrace] = useState<ReadonlyMap<number, AgentPart[]>>(new Map());
  // the subgraph the agent traversed this turn, drawn as an interactive graph
  // beneath the answer (keyed by the assistant message's index)
  const [liveGraph, setLiveGraph] = useState<
    ReadonlyMap<number, { nodes: GraphNode[]; links: GraphLink[] }>
  >(new Map());
  // set when the stream itself assigns the conversation id, so the id change
  // doesn't trigger a refetch that would clobber the in-flight reply
  const streamAssignedId = useRef(false);
  // the wiki page opened beside the chat (a [[link]] click) — null when closed
  const [wikiPanelSlug, setWikiPanelSlug] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .listEntities()
      .then((r) => setEntities(r.entities))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (streamAssignedId.current) {
      streamAssignedId.current = false;
      return;
    }
    setLiveSources(new Map());
    setLiveTrace(new Map());
    setLiveGraph(new Map());
    setError(null);
    setStatus("ready");
    if (activeId === null) {
      setMessages([]);
      return;
    }
    api
      .getMessages(activeId)
      .then((r) => setMessages(r.messages))
      .catch(() => {});
  }, [activeId]);

  // Streamdown renders its own link element (a <button>, not an <a href>), so we
  // override the link renderer instead of delegating clicks: a wiki link opens
  // beside the chat (side panel), other internal links route, externals open out.
  const markdownComponents = useMemo<ComponentProps<typeof MessageResponse>["components"]>(
    () => ({
      a: ({ href, children }) => {
        const url = typeof href === "string" ? href : "";
        if (url.startsWith("/wiki/")) {
          return (
            <a
              href={url}
              className="cursor-pointer font-medium text-lamp underline-offset-2 hover:underline"
              onClick={(event) => {
                event.preventDefault();
                setWikiPanelSlug(wikiSlugFromHref(url));
              }}
            >
              {children}
            </a>
          );
        }
        if (url.startsWith("/")) {
          return (
            <a
              href={url}
              className="cursor-pointer underline-offset-2 hover:underline"
              onClick={(event) => {
                event.preventDefault();
                navigate(url);
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {children}
          </a>
        );
      },
    }),
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
            setSearchParams({ c: String(event.conversationId) }, { replace: true });
          }
        } else if (event.type === "sources") {
          setLiveSources((current) => new Map(current).set(assistantIndex, event.sources));
        } else if (event.type === "reasoning") {
          setLiveTrace((current) =>
            new Map(current).set(
              assistantIndex,
              appendReasoning(current.get(assistantIndex) ?? [], event.text),
            ),
          );
        } else if (event.type === "tool-call") {
          setLiveTrace((current) =>
            new Map(current).set(assistantIndex, [
              ...(current.get(assistantIndex) ?? []),
              {
                kind: "tool",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: event.input,
                state: "input-available",
              },
            ]),
          );
        } else if (event.type === "tool-result") {
          setLiveTrace((current) =>
            new Map(current).set(
              assistantIndex,
              settleTool(
                current.get(assistantIndex) ?? [],
                event.toolCallId,
                event.toolName,
                event.output,
              ),
            ),
          );
        } else if (event.type === "graph") {
          setLiveGraph((current) =>
            new Map(current).set(assistantIndex, { nodes: event.nodes, links: event.links }),
          );
        } else if (event.type === "delta") {
          setStatus("streaming");
          setMessages((current) => {
            const next = [...current];
            const last = next[next.length - 1]!;
            next[next.length - 1] = { ...last, content: last.content + event.text };
            return next;
          });
        } else if (event.type === "error") {
          failTurn({ message: event.message, kind: event.kind });
        }
      }
      setStatus((current) => (current === "error" ? current : "ready"));
    } catch (e) {
      failTurn({ message: e instanceof Error ? e.message : String(e) });
    }
  };

  // Drop the empty assistant placeholder (so it stops shimmering "Consulting…")
  // and surface the error banner instead.
  const failTurn = (next: { message: string; kind?: LlmErrorKind }) => {
    setError(next);
    setStatus("error");
    setMessages((current) =>
      current.length > 0 &&
      current[current.length - 1]!.role === "assistant" &&
      !current[current.length - 1]!.content
        ? current.slice(0, -1)
        : current,
    );
  };

  const lastIndex = messages.length - 1;

  if (messages.length === 0) {
    return (
      <PromptInputProvider>
        <div className="flex h-full flex-col items-center justify-center px-6">
          <div className="w-full max-w-2xl">
            <div className="rise flex flex-col items-center text-center">
              <h1 className="mt-5 font-serif text-3xl text-paper">How can I help you today?</h1>
            </div>

            <div className="rise rise-1 mt-7">
              <Composer status={status} busy={busy} onSend={send} entities={entities} />
            </div>

            <div className="rise rise-2 mt-5">
              <Suggestions className="justify-center">
                {SUGGESTIONS.map(({ label, prompt }) => (
                  <SuggestionPill key={label} label={label} prompt={prompt} />
                ))}
              </Suggestions>
            </div>
          </div>
        </div>
      </PromptInputProvider>
    );
  }

  return (
    <PromptInputProvider>
      <div className="flex h-full min-w-0">
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <Conversation className="flex-1">
            <ConversationContent className="mx-auto w-full max-w-2xl gap-6 px-6 py-10">
              <>
                {messages.map((message, index) => {
                  const trace = liveTrace.get(index);
                  const graph = liveGraph.get(index);
                  return (
                    <Message
                      key={message.id > 0 ? message.id : `pending-${index}`}
                      from={message.role}
                    >
                      <MessageContent className="group-[.is-user]:max-w-[85%] group-[.is-user]:rounded-xl group-[.is-user]:rounded-br-sm group-[.is-user]:border group-[.is-user]:border-line group-[.is-user]:bg-card group-[.is-user]:py-2.5 group-[.is-user]:text-[14px]">
                        {message.role === "assistant" ? (
                          <>
                            {trace && trace.length > 0 && (
                              <AgentTrace
                                trace={trace}
                                streaming={busy && index === lastIndex && !message.content}
                              />
                            )}
                            {message.content ? (
                              (() => {
                                const { text: proseText, patch: profilePatch } = splitProfileEdit(
                                  message.content,
                                );
                                return (
                                  <div className="text-[15px]">
                                    {proseText && (
                                      <MessageResponse
                                        className="prose-meos"
                                        isAnimating={busy && index === lastIndex}
                                        components={markdownComponents}
                                      >
                                        {resolveWikiLinks(proseText, entities)}
                                      </MessageResponse>
                                    )}
                                    {profilePatch && (
                                      <ProfileEditResult
                                        patch={profilePatch}
                                        onOpen={() => navigate("/settings")}
                                      />
                                    )}
                                    <div className="mt-3">
                                      <SourceList
                                        sources={liveSources.get(index) ?? message.sources ?? []}
                                      />
                                    </div>
                                  </div>
                                );
                              })()
                            ) : trace && trace.length > 0 ? null : (
                              <Shimmer className="text-sm" duration={1.6}>
                                Consulting the knowledge base…
                              </Shimmer>
                            )}
                            {graph && graph.nodes.length > 0 && <ChatGraph graph={graph} />}
                          </>
                        ) : (
                          <UserMessage content={message.content} entities={entities} />
                        )}
                      </MessageContent>
                    </Message>
                  );
                })}
                {error && <ChatError error={error} />}
              </>
            </ConversationContent>
            <ConversationScrollButton className="border-line bg-desk text-faded hover:bg-card hover:text-paper" />
          </Conversation>

          <div className="px-6 pb-5 pt-1">
            <div className="mx-auto max-w-2xl">
              <Composer status={status} busy={busy} onSend={send} entities={entities} />
            </div>
          </div>
        </div>

        {wikiPanelSlug && (
          <aside className="flex h-full w-[420px] shrink-0 flex-col border-l border-line bg-desk">
            <WikiPageView
              slug={wikiPanelSlug}
              embedded
              onNavigate={setWikiPanelSlug}
              onClose={() => setWikiPanelSlug(null)}
            />
          </aside>
        )}
      </div>
    </PromptInputProvider>
  );
}

/**
 * The agent's live trace above an answer: its reasoning and each knowledge-base
 * tool call, in the order they happened — the chat equivalent of the wiki
 * maintainer's transcript, built from ai-elements Reasoning + Tool.
 */
function AgentTrace({ trace, streaming }: { trace: AgentPart[]; streaming: boolean }) {
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {trace.map((part, index) => {
        const isLast = index === trace.length - 1;
        if (part.kind === "reasoning") {
          return (
            <Reasoning key={index} isStreaming={streaming && isLast}>
              <ReasoningTrigger />
              <ReasoningContent>{part.text}</ReasoningContent>
            </Reasoning>
          );
        }
        const label = TOOL_LABELS[part.toolName] ?? part.toolName;
        const arg = toolArg(part.input);
        return (
          <Tool key={index}>
            <ToolHeader
              state={part.state}
              title={
                <span className="flex items-baseline gap-1.5">
                  {label}
                  {arg && (
                    <span className="truncate font-normal text-muted-foreground">“{arg}”</span>
                  )}
                </span>
              }
            />
            <ToolContent>
              <ToolInput input={part.input} />
              <ToolOutput output={part.output} />
            </ToolContent>
          </Tool>
        );
      })}
    </div>
  );
}

/**
 * The subgraph the agent traversed to answer, drawn with the same interactive
 * force engine as the wiki Graph view — drag nodes, pan, click through to a page.
 * Wheel-zoom is off so it doesn't trap the chat scroll.
 */
function ChatGraph({ graph }: { graph: { nodes: GraphNode[]; links: GraphLink[] } }) {
  return (
    <figure className="mt-3 overflow-hidden rounded-xl border border-line bg-desk">
      <figcaption className="flex items-center justify-between border-b border-line px-3 py-2 text-[11px] text-dim">
        <span className="font-mono uppercase tracking-wider">Traversed</span>
        <span>
          {graph.nodes.length} {graph.nodes.length === 1 ? "node" : "nodes"} · {graph.links.length}{" "}
          {graph.links.length === 1 ? "link" : "links"}
        </span>
      </figcaption>
      <ForceGraph nodes={graph.nodes} links={graph.links} wheelZoom={false} className="h-72" />
    </figure>
  );
}

/** The result of a `/profile` edit: the change as a diff, plus a link to the full profile. */
function ProfileEditResult({ patch, onOpen }: { patch: string; onOpen: () => void }) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      <DiffView patch={patch} />
      <Button
        variant="outline"
        size="sm"
        onClick={onOpen}
        className="self-start border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-transparent hover:text-paper"
      >
        See full profile
      </Button>
    </div>
  );
}

// Errors the user fixes in Settings (key, credits, model) get a direct link.
const SETTINGS_KINDS: ReadonlySet<LlmErrorKind> = new Set(["auth", "credits", "model"]);

/** The chat error banner: the normalized LLM message plus, when relevant, a Settings link. */
function ChatError({ error }: { error: { message: string; kind?: LlmErrorKind } }) {
  const showSettings = error.kind !== undefined && SETTINGS_KINDS.has(error.kind);
  return (
    <div className="rounded-lg border border-ember/30 bg-ember/5 px-3 py-2.5 text-sm text-ember">
      <p>⚠ {error.message}</p>
      {showSettings && (
        <Link
          to="/settings"
          className="mt-1 inline-block font-medium underline underline-offset-2 hover:text-paper"
        >
          Open Settings → Model
        </Link>
      )}
    </div>
  );
}

/**
 * The prompt input, bound to the shared PromptInputProvider so suggestions can
 * fill it. The action menu lets the user attach references — wiki pages (sent as
 * [[mentions]] the retrieval pipeline understands) and text files (inlined as
 * context) — shown as removable chips above the textarea.
 */
function Composer({
  status,
  busy,
  onSend,
  entities,
}: {
  status: ChatStatus;
  busy: boolean;
  onSend: (text: string) => void;
  entities: EntitySummary[];
}) {
  const [wikiRefs, setWikiRefs] = useState<EntitySummary[]>([]);
  const [fileRefs, setFileRefs] = useState<FileRef[]>([]);
  const [wikiPickerOpen, setWikiPickerOpen] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Slash-command menu: surfaced while the input is a bare "/command" token.
  const { textInput } = usePromptInputController();
  const value = textInput.value;
  const slashMatch = /^\/(\S*)$/.exec(value);
  const [cmdClosed, setCmdClosed] = useState(false);
  const [cmdIndex, setCmdIndex] = useState(0);
  const matchedCommands = slashMatch
    ? SLASH_COMMANDS.filter((c) => c.command.slice(1).startsWith(slashMatch[1]!.toLowerCase()))
    : [];
  const showCommands = !cmdClosed && slashMatch !== null && matchedCommands.length > 0;

  useEffect(() => {
    setCmdIndex(0);
    if (!value.startsWith("/")) setCmdClosed(false);
  }, [value]);

  const completeCommand = (command: string) => {
    textInput.setInput(`${command} `);
    setCmdClosed(true);
  };

  const onCommandKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showCommands) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCmdIndex((i) => (i + 1) % matchedCommands.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCmdIndex((i) => (i - 1 + matchedCommands.length) % matchedCommands.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      completeCommand((matchedCommands[cmdIndex] ?? matchedCommands[0]!).command);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setCmdClosed(true);
    }
  };

  const addWiki = (entity: EntitySummary) => {
    setWikiRefs((current) =>
      current.some((e) => e.id === entity.id) ? current : [...current, entity],
    );
    setWikiPickerOpen(false);
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList) return;
    setFileError(null);
    const read = await Promise.all(
      [...fileList].map(async (file) => ({ name: file.name, text: await file.text() })),
    );
    const accepted: FileRef[] = [];
    const rejected: string[] = [];
    for (const file of read) {
      // a NUL / replacement char means we decoded a binary file (e.g. .docx, .pdf)
      // as text — skip it rather than inlining garbage into the prompt
      // eslint-disable-next-line no-control-regex -- NUL/replacement-char sniffing of binary files is intentional
      if (/[\u0000\uFFFD]/.test(file.text)) rejected.push(file.name);
      else accepted.push({ name: file.name, text: file.text.slice(0, MAX_FILE_CHARS) });
    }
    if (accepted.length > 0) setFileRefs((current) => [...current, ...accepted]);
    if (rejected.length > 0) {
      setFileError(
        `Can't read ${rejected.join(", ")} as text. Attach .md, .txt, .csv, .json or .org files.`,
      );
    }
  };

  const onSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if ((!text && wikiRefs.length === 0 && fileRefs.length === 0) || busy) return;
    const parts: string[] = [];
    if (wikiRefs.length > 0) parts.push(wikiRefs.map((e) => `[[${e.name}]]`).join(" "));
    for (const file of fileRefs) parts.push(`<file name="${file.name}">\n${file.text}\n</file>`);
    if (text) parts.push(text);
    onSend(parts.join("\n\n"));
    setWikiRefs([]);
    setFileRefs([]);
  };

  const hasRefs = wikiRefs.length > 0 || fileRefs.length > 0;

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={TEXT_FILE_ACCEPT}
        className="hidden"
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = "";
        }}
      />

      <div className="relative">
        {showCommands && (
          <div className="absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-xl border border-line bg-desk shadow-lg">
            <div className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
              Commands
            </div>
            {matchedCommands.map((cmd, i) => (
              <button
                key={cmd.command}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => completeCommand(cmd.command)}
                onMouseEnter={() => setCmdIndex(i)}
                className={cn(
                  "flex w-full items-baseline gap-2 px-3 py-2 text-left transition-colors",
                  i === cmdIndex ? "bg-card" : "hover:bg-card/50",
                )}
              >
                <span className="font-mono text-[13px] text-paper">{cmd.command}</span>
                <span className="text-[12px] text-dim">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}

        <PromptInput
          onSubmit={onSubmit}
          className="rounded-2xl border-line bg-desk shadow-sm transition-colors focus-within:border-lamp-dim"
        >
          {hasRefs && (
            <PromptInputHeader className="px-3 pt-2.5">
              {wikiRefs.map((entity) => {
                const Icon = ENTITY_TYPES[entity.type]?.icon ?? Library;
                return (
                  <RefChip
                    key={`w-${entity.id}`}
                    onRemove={() => setWikiRefs((c) => c.filter((e) => e.id !== entity.id))}
                  >
                    <Icon className="size-3.5 text-lamp" />
                    {entity.name}
                  </RefChip>
                );
              })}
              {fileRefs.map((file, index) => (
                <RefChip
                  key={`f-${index}`}
                  onRemove={() => setFileRefs((c) => c.filter((_, i) => i !== index))}
                >
                  <FileText className="size-3.5 text-dim" />
                  {file.name}
                </RefChip>
              ))}
            </PromptInputHeader>
          )}

          <PromptInputBody>
            <PromptInputTextarea
              onKeyDown={onCommandKeyDown}
              placeholder="Ask your second brain…  (type / for commands)"
              className="min-h-12 text-[15px] text-paper placeholder:text-dim"
            />
          </PromptInputBody>

          <PromptInputFooter className="px-2.5 pb-2">
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger className="text-dim hover:text-paper" />
                <PromptInputActionMenuContent className="border-line bg-desk">
                  <PromptInputActionMenuItem
                    onSelect={() => setTimeout(() => setWikiPickerOpen(true), 0)}
                  >
                    <Library className="mr-2 size-4" /> Reference a wiki page
                  </PromptInputActionMenuItem>
                  <PromptInputActionMenuItem onSelect={() => fileInputRef.current?.click()}>
                    <Paperclip className="mr-2 size-4" /> Attach a file
                  </PromptInputActionMenuItem>
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            </PromptInputTools>
            <PromptInputSubmit
              status={status}
              className="rounded-lg bg-lamp text-ink hover:bg-lamp/85"
            />
          </PromptInputFooter>
        </PromptInput>
      </div>

      {fileError && <p className="mt-2 px-1 text-[12px] text-ember">{fileError}</p>}

      <CommandDialog
        open={wikiPickerOpen}
        onOpenChange={setWikiPickerOpen}
        showCloseButton={false}
        className="top-[18vh] translate-y-0 border-line bg-desk"
      >
        <CommandInput
          placeholder="Reference a wiki page…"
          className="text-paper placeholder:text-dim"
        />
        <CommandList className="max-h-72">
          <CommandEmpty className="py-3 text-sm text-dim">No pages match.</CommandEmpty>
          <CommandGroup heading="Wiki">
            {entities.map((entity) => {
              const Icon = ENTITY_TYPES[entity.type]?.icon ?? Library;
              return (
                <CommandItem
                  key={entity.id}
                  value={`${entity.name} ${entity.type}`}
                  onSelect={() => addWiki(entity)}
                >
                  <Icon className="size-3.5 text-dim" />
                  <span>{entity.name}</span>
                  <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-dim">
                    {entity.type}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

/** A removable reference chip shown in the prompt input header. */
function RefChip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1.5 rounded-md border border-line bg-card px-2 py-1 text-[12px] text-faded">
      {children}
      <button
        onClick={onRemove}
        className="text-dim transition-colors hover:text-ember"
        aria-label="Remove reference"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/** Renders a sent user message: reference chips (wiki pages link out, files don't) above the text. */
function UserMessage({ content, entities }: { content: string; entities: EntitySummary[] }) {
  const { text, files, wikis } = parseUserMessage(content);
  const hasRefs = files.length > 0 || wikis.length > 0;
  return (
    <div className="flex flex-col gap-2">
      {hasRefs && (
        <div className="flex flex-wrap gap-1.5">
          {wikis.map((name, index) => {
            const entity = entities.find((e) => e.name === name);
            const Icon = (entity && ENTITY_TYPES[entity.type]?.icon) ?? Library;
            return (
              <MsgChip
                key={`w-${index}`}
                icon={<Icon className="size-3.5 text-lamp" />}
                label={name}
                to={entity ? `/wiki/${entity.slug}` : undefined}
              />
            );
          })}
          {files.map((name, index) => (
            <MsgChip
              key={`f-${index}`}
              icon={<FileText className="size-3.5 text-dim" />}
              label={name}
            />
          ))}
        </div>
      )}
      {text && <span className="whitespace-pre-wrap">{text}</span>}
    </div>
  );
}

/** A read-only reference chip inside a sent message; wiki chips link to their page. */
function MsgChip({ icon, label, to }: { icon: ReactNode; label: string; to?: string }) {
  const inner = (
    <span className="flex items-center gap-1.5 rounded-md border border-line bg-desk px-2 py-0.5 text-[12px] text-faded">
      {icon}
      {label}
    </span>
  );
  return to ? (
    <Link to={to} className="transition-colors hover:text-paper">
      {inner}
    </Link>
  ) : (
    inner
  );
}

/** A suggestion pill that pastes its prompt into the shared input rather than sending. */
function SuggestionPill({ label, prompt }: { label: string; prompt: string }) {
  const { textInput } = usePromptInputController();
  return (
    <Suggestion
      suggestion={prompt}
      onClick={(value) => textInput.setInput(value)}
      className="border-line bg-transparent text-faded hover:border-lamp-dim hover:bg-card hover:text-paper"
    >
      {label}
    </Suggestion>
  );
}
