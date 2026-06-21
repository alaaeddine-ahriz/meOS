import type { ChatStatus } from "ai";
import { Check, ChevronDown, FileText, Library, Paperclip, Send, Terminal, X } from "lucide-react";
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
  type ChatEvent,
  type AgentTracePart,
  type AskAnswerItem,
  type AskQuestion,
  type CodingAgentSummary,
  type EntitySummary,
  type FileChange,
  type GraphLink,
  type GraphNode,
  type LlmErrorKind,
  type Message as MessageRecord,
  type RunTelemetry,
  type SourceRef,
} from "../api.js";
import { DiffView } from "../components/DiffView.js";
import { SourceList, type WikiPageRef } from "../components/SourceList.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
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
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
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

// Which coding agent (Claude Code, Codex, Cursor, …) and model agent-mode runs
// with. The available agents — and the models each offers — are discovered from
// the server (`/api/coding-agents`, which probes PATH), so the picker only ever
// lists agents this machine can actually run. The chosen agent + a per-agent
// model are persisted so the choice survives a reload.
const AGENT_ID_STORAGE_KEY = "meos.agentId";
const agentModelKey = (agentId: string) => `meos.agentModel.${agentId}`;

/** The persisted-or-default model for an agent (a stored value only if still offered). */
function resolveAgentModel(agent: CodingAgentSummary): string {
  try {
    const stored = localStorage.getItem(agentModelKey(agent.id));
    if (stored && agent.models.some((m) => m.value === stored)) return stored;
  } catch {
    // private mode / storage disabled — fall through to the agent's default
  }
  return agent.defaultModel;
}

// Map a model to a models.dev logo slug. The model `value` carries the brand for
// agents that proxy several providers (Cursor/Copilot run Claude *and* GPT), so
// derive from it first; "auto" and anything unrecognised fall back to the
// agent's own brand. All slugs below are confirmed present on models.dev.
function modelLogoProvider(value: string, agentId: string): string {
  const v = value.toLowerCase();
  if (v.startsWith("claude")) return "anthropic";
  if (v.startsWith("gpt") || /^o[0-9]/.test(v)) return "openai";
  if (v.startsWith("gemini")) return "google";
  switch (agentId) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    case "cursor":
      return "cursor";
    case "gemini":
      return "google";
    case "copilot":
      return "github-copilot";
    default:
      return agentId;
  }
}

/**
 * The agent-mode model picker: a searchable command palette (ai-elements
 * `ModelSelector`) whose trigger and items show each model's provider logo.
 */
function ModelPicker({
  models,
  value,
  onValueChange,
  agentId,
}: {
  models: Array<{ value: string; label: string }>;
  value: string;
  onValueChange: (model: string) => void;
  agentId: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = models.find((m) => m.value === value) ?? models[0];
  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <button
          type="button"
          title="Model the agent runs with"
          className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-dim outline-none hover:text-paper"
        >
          {selected && <ModelSelectorLogo provider={modelLogoProvider(selected.value, agentId)} />}
          <span className="max-w-[10rem] truncate">{selected?.label ?? "Model"}</span>
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </ModelSelectorTrigger>
      <ModelSelectorContent className="border-line bg-desk" title="Select a model">
        <ModelSelectorInput
          placeholder="Search models…"
          className="text-paper placeholder:text-dim"
        />
        <ModelSelectorList>
          <ModelSelectorEmpty className="py-6 text-center text-[13px] text-dim">
            No models match.
          </ModelSelectorEmpty>
          <ModelSelectorGroup>
            {models.map((model) => (
              <ModelSelectorItem
                key={model.value}
                value={`${model.label} ${model.value}`}
                onSelect={() => {
                  onValueChange(model.value);
                  setOpen(false);
                }}
                className="gap-2 text-[13px] text-paper"
              >
                <ModelSelectorLogo provider={modelLogoProvider(model.value, agentId)} />
                <ModelSelectorName>{model.label}</ModelSelectorName>
                {model.value === value && <Check className="size-3.5 text-lamp" />}
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

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
 * One step in an assistant turn's live agent trace, kept in arrival order so the
 * UI reads as a chronological transcript — "thought → ran a tool → wrote → ran a
 * tool → answered" — instead of grouping every tool call above the prose:
 *  - `reasoning` — the model's (accreting) private thinking.
 *  - `text`      — answer prose the model emitted between/around tool calls.
 *  - `tool`      — a tool call with its eventual result.
 */
type AgentPart =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolCallId?: string;
      toolName: string;
      input: unknown;
      output?: unknown;
      state: ToolState;
    }
  // A mid-run question the agent posed (agent mode). The card collects the user's
  // choice and POSTs it back, unblocking the agent — see AskCard.
  | { kind: "ask"; op: string; id: string; questions: AskQuestion[] };

/**
 * Rebuild the live trace shape from a turn's persisted trace (loaded with the
 * message), so a reopened agent conversation renders the same chronological
 * timeline it streamed. The persisted form drops the live-only `state`/`toolCallId`
 * — a tool always has its result by the time it's persisted, so its state is
 * derived from `isError` here.
 */
function rehydrateTrace(parts: AgentTracePart[]): AgentPart[] {
  return parts.map((part) => {
    if (part.kind === "tool") {
      return {
        kind: "tool",
        toolName: part.toolName,
        input: part.input,
        output: part.output,
        state:
          part.output === undefined
            ? "input-available"
            : part.isError
              ? "output-error"
              : "output-available",
      };
    }
    return part;
  });
}

/** Render a failed tool's output as plain text for the error panel. */
function toErrorText(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return "Tool failed.";
  }
}

/** Merge a reasoning delta into the trailing reasoning part, or open a new one. */
function appendReasoning(parts: AgentPart[], text: string): AgentPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === "reasoning") {
    return [...parts.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...parts, { kind: "reasoning", text }];
}

/** Merge a text delta into the trailing text part, or open a new one — so a run
 * of prose stays one block but a tool call between two blocks splits them. */
function appendText(parts: AgentPart[], text: string): AgentPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === "text") {
    return [...parts.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...parts, { kind: "text", text }];
}

/** Attach a tool result to its pending call (matched by id, else by name). */
function settleTool(
  parts: AgentPart[],
  toolCallId: string | undefined,
  toolName: string,
  output: unknown,
  isError?: boolean,
): AgentPart[] {
  const next = [...parts];
  for (let i = next.length - 1; i >= 0; i--) {
    const part = next[i]!;
    if (part.kind !== "tool" || part.output !== undefined) continue;
    const matches = toolCallId ? part.toolCallId === toolCallId : part.toolName === toolName;
    if (matches) {
      next[i] = { ...part, output, state: isError ? "output-error" : "output-available" };
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
    // Knowledge tools key on query/entity/name; coding-agent tools (Bash, Read,
    // Edit, Glob, Grep…) key on command/file_path/path/pattern/description.
    const value =
      record.query ??
      record.entity ??
      record.name ??
      record.command ??
      record.file_path ??
      record.path ??
      record.pattern ??
      record.description;
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function ChatView() {
  // the active conversation lives in the URL (?c=<id>) so the command palette
  // can open past chats; no `c` means a fresh conversation.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeId = searchParams.has("c") ? Number(searchParams.get("c")) : null;
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<{ message: string; kind?: LlmErrorKind } | null>(null);
  // sources arrive per streamed reply, keyed by the assistant message's index
  const [liveSources, setLiveSources] = useState<ReadonlyMap<number, SourceRef[]>>(new Map());
  // wiki pages an answer drew on (agent turns surface the entities they consulted),
  // keyed the same way — live-only, rendered beside the source documents
  const [livePages, setLivePages] = useState<ReadonlyMap<number, WikiPageRef[]>>(new Map());
  // the agent's live trace (reasoning + tool calls, in arrival order), keyed the
  // same way — so each turn shows the model thinking and consulting the brain
  const [liveTrace, setLiveTrace] = useState<ReadonlyMap<number, AgentPart[]>>(new Map());
  // the subgraph the agent traversed this turn, drawn as an interactive graph
  // beneath the answer (keyed by the assistant message's index)
  const [liveGraph, setLiveGraph] = useState<
    ReadonlyMap<number, { nodes: GraphNode[]; links: GraphLink[] }>
  >(new Map());
  // an agent run's cost/turns/duration + the files it touched, keyed the same way
  // — rendered as a footer under the answer (also persisted, so reloads keep them)
  const [liveTelemetry, setLiveTelemetry] = useState<ReadonlyMap<number, RunTelemetry>>(new Map());
  const [liveFiles, setLiveFiles] = useState<ReadonlyMap<number, FileChange[]>>(new Map());
  // which assistant turns were driven by the coding agent (Claude Code), keyed by
  // index — only changes the "working…" label while the answer is still empty
  const [agentTurns, setAgentTurns] = useState<ReadonlyMap<number, boolean>>(new Map());
  // agent mode lives here (not in Composer) so it stays on across the empty→
  // conversation transition, where a fresh Composer instance is mounted
  const [agentMode, setAgentMode] = useState(false);
  // the coding agents installed on this machine, discovered from the server, plus
  // the selected agent + its model — all kept here (like agentMode) so they span
  // the Composer remount. Empty until the first fetch resolves.
  const [agents, setAgents] = useState<CodingAgentSummary[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [agentModel, setAgentModel] = useState<string>("");
  // Discover all supported agents once, then settle on the persisted-or-first
  // INSTALLED agent and its persisted-or-default model. Not-installed agents are
  // still listed (greyed out), but never auto-selected.
  useEffect(() => {
    let cancelled = false;
    api
      .listCodingAgents()
      .then(({ agents: all }) => {
        if (cancelled) return;
        setAgents(all);
        const installed = all.filter((a) => a.installed);
        if (installed.length === 0) return; // picker shows the install hint
        let storedId: string | null = null;
        try {
          storedId = localStorage.getItem(AGENT_ID_STORAGE_KEY);
        } catch {
          // storage disabled — fall back to the first installed agent
        }
        const chosen = installed.find((a) => a.id === storedId) ?? installed[0]!;
        setAgentId(chosen.id);
        setAgentModel(resolveAgentModel(chosen));
      })
      .catch(() => {
        // server unreachable / older server without the route — leave the list
        // empty; the picker shows a "no agents" hint and the toggle is inert.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Switch agent: remember it, and load that agent's persisted-or-default model.
  // Ignore not-installed agents (they're shown greyed out, not selectable).
  const handleAgentIdChange = (id: string) => {
    const agent = agents.find((a) => a.id === id);
    if (!agent || !agent.installed) return;
    setAgentId(id);
    setAgentModel(resolveAgentModel(agent));
    try {
      localStorage.setItem(AGENT_ID_STORAGE_KEY, id);
    } catch {
      // storage disabled — the in-memory choice still applies
    }
  };
  const handleAgentModelChange = (model: string) => {
    setAgentModel(model);
    try {
      if (agentId) localStorage.setItem(agentModelKey(agentId), model);
    } catch {
      // storage disabled — the in-memory choice still applies
    }
  };
  // set when the stream itself assigns the conversation id, so the id change
  // doesn't trigger a refetch that would clobber the in-flight reply
  const streamAssignedId = useRef(false);
  // Aborts the in-flight turn's fetch — fired on Stop, conversation switch, and
  // unmount. Closing the socket triggers the server to kill any agent child.
  const abortRef = useRef<AbortController | null>(null);
  // the wiki page opened beside the chat (a [[link]] click) — null when closed
  const [wikiPanelSlug, setWikiPanelSlug] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .listEntities()
      .then((r) => setEntities(r.entities))
      .catch(() => {});
  }, []);

  // Abort an in-flight run when the chat view unmounts (in-app navigation) so a
  // long agent run doesn't keep executing in the background after the user leaves.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (streamAssignedId.current) {
      streamAssignedId.current = false;
      return;
    }
    // Switching conversations cancels any run still streaming into the old one.
    abortRef.current?.abort();
    setLiveSources(new Map());
    setLivePages(new Map());
    setLiveTrace(new Map());
    setLiveGraph(new Map());
    setLiveTelemetry(new Map());
    setLiveFiles(new Map());
    setAgentTurns(new Map());
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

  // Apply one streamed run frame to the live view state, rendering reasoning /
  // tools / answer for the composer's send loop. `start`, `done`, and `error` are
  // owned by the caller (it drives the conversation/turn lifecycle).
  const applyFrame = (event: ChatEvent, assistantIndex: number, isAgent: boolean): void => {
    if (event.type === "sources") {
      setLiveSources((current) => new Map(current).set(assistantIndex, event.sources));
      if (event.pages && event.pages.length > 0) {
        const pages = event.pages;
        setLivePages((current) => new Map(current).set(assistantIndex, pages));
      }
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
            event.isError,
          ),
        ),
      );
    } else if (event.type === "graph") {
      setLiveGraph((current) =>
        new Map(current).set(assistantIndex, { nodes: event.nodes, links: event.links }),
      );
    } else if (event.type === "run-telemetry") {
      setLiveTelemetry((current) =>
        new Map(current).set(assistantIndex, {
          costUsd: event.costUsd,
          numTurns: event.numTurns,
          durationMs: event.durationMs,
        }),
      );
    } else if (event.type === "files-changed") {
      setLiveFiles((current) => new Map(current).set(assistantIndex, event.files));
    } else if (event.type === "ask-user") {
      // The agent paused to ask: drop a question card into the trace, in order.
      setLiveTrace((current) =>
        new Map(current).set(assistantIndex, [
          ...(current.get(assistantIndex) ?? []),
          { kind: "ask", op: event.op, id: event.id, questions: event.questions },
        ]),
      );
    } else if (event.type === "delta") {
      setStatus("streaming");
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1]!;
        next[next.length - 1] = { ...last, content: last.content + event.text };
        return next;
      });
      // Agent turns weave their answer text into the live trace, in position among
      // the tool calls, so the timeline stays chronological. (The plain knowledge
      // chat keeps a single answer block, rendered from `content`.)
      if (isAgent) {
        setLiveTrace((current) =>
          new Map(current).set(
            assistantIndex,
            appendText(current.get(assistantIndex) ?? [], event.text),
          ),
        );
      }
    }
  };

  const send = async (text: string, agent?: boolean, model?: string, runAgentId?: string) => {
    const assistantIndex = messages.length + 1;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setStatus("submitted");
    if (agent) setAgentTurns((current) => new Map(current).set(assistantIndex, true));
    setMessages((current) => [
      ...current,
      { id: -1, role: "user", content: text, created_at: "" },
      { id: -2, role: "assistant", content: "", created_at: "" },
    ]);

    // Tracks whether the turn streamed anything visible, so a turn that ends
    // with nothing (and no error) drops its placeholder instead of shimmering forever.
    let produced = false;
    try {
      for await (const event of streamChat(
        text,
        activeId ?? undefined,
        agent,
        model,
        controller.signal,
        runAgentId,
      )) {
        if (event.type !== "start" && event.type !== "done" && event.type !== "error") {
          produced = true;
        }
        if (event.type === "start") {
          // A fresh chat adopts the server-assigned conversation id so a reload or
          // the command palette can reopen it.
          if (event.conversationId !== activeId) {
            streamAssignedId.current = true;
            setSearchParams({ c: String(event.conversationId) }, { replace: true });
          }
        } else if (event.type === "error") {
          failTurn({ message: event.message, kind: event.kind });
        } else if (event.type !== "done") {
          applyFrame(event, assistantIndex, !!agent);
        }
      }
      if (!produced) {
        // Nothing came back (and no error frame) — drop the empty assistant bubble.
        setMessages(dropEmptyPlaceholder);
      }
      setStatus((current) => (current === "error" ? current : "ready"));
    } catch (e) {
      // An abort (Stop button, navigation, or a new turn) isn't an error — settle quietly.
      if (controller.signal.aborted) {
        setStatus((current) => (current === "error" ? current : "ready"));
      } else {
        failTurn({ message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  // Drop a trailing empty assistant bubble — used when a turn ends with nothing to
  // show (no streamed content and no error) and when a turn fails.
  const dropEmptyPlaceholder = (current: MessageRecord[]): MessageRecord[] => {
    const last = current[current.length - 1];
    return last && last.role === "assistant" && !last.content ? current.slice(0, -1) : current;
  };

  // Drop the empty assistant placeholder (so it stops shimmering "Consulting…")
  // and surface the error banner instead.
  const failTurn = (next: { message: string; kind?: LlmErrorKind }) => {
    setError(next);
    setStatus("error");
    setMessages(dropEmptyPlaceholder);
  };

  const lastIndex = messages.length - 1;

  if (messages.length === 0) {
    return (
      <PromptInputProvider>
        <div className="flex h-full flex-col items-center justify-center px-6">
          <div className="w-full max-w-2xl">
            <div className="flex flex-col items-center text-center">
              <h1 className="mt-5 font-serif text-3xl text-paper">How can I help you today?</h1>
            </div>

            <div className="mt-7">
              <Composer
                status={status}
                busy={busy}
                onSend={send}
                onStop={() => abortRef.current?.abort()}
                entities={entities}
                agentMode={agentMode}
                onAgentModeChange={setAgentMode}
                agents={agents}
                agentId={agentId}
                onAgentIdChange={handleAgentIdChange}
                agentModel={agentModel}
                onAgentModelChange={handleAgentModelChange}
              />
            </div>

            <div className="mt-5">
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
                  // Live trace while streaming; on reload, rebuilt from the turn's
                  // persisted trace so the timeline survives reopening the chat.
                  const trace =
                    liveTrace.get(index) ??
                    (message.trace ? rehydrateTrace(message.trace) : undefined);
                  const graph = liveGraph.get(index);
                  const telemetry = liveTelemetry.get(index) ?? message.telemetry;
                  const files = liveFiles.get(index) ?? message.filesChanged ?? [];
                  // An agent turn either streamed this session (agentTurns) or carries
                  // persisted agent metadata from a past run (trace/telemetry/files).
                  const isAgentTurn =
                    (agentTurns.get(index) ?? false) ||
                    !!message.trace?.length ||
                    !!message.telemetry ||
                    files.length > 0;
                  return (
                    <Message
                      key={message.id > 0 ? message.id : `pending-${index}`}
                      from={message.role}
                    >
                      <MessageContent className="group-[.is-user]:max-w-[85%] group-[.is-user]:rounded-xl group-[.is-user]:rounded-br-sm group-[.is-user]:border group-[.is-user]:border-line group-[.is-user]:bg-card group-[.is-user]:py-2.5 group-[.is-user]:text-[14px]">
                        {message.role === "assistant" ? (
                          isAgentTurn && trace && trace.length > 0 ? (
                            // Agent turn: one chronological timeline — thinking, tool
                            // calls, and answer text interleaved in the order they
                            // happened — then the references it leaned on, and a footer
                            // with what the run cost and which files it touched.
                            <>
                              <AgentTrace
                                trace={trace}
                                streaming={busy && index === lastIndex}
                                entities={entities}
                                components={markdownComponents}
                              />
                              <div className="mt-3">
                                <SourceList
                                  sources={liveSources.get(index) ?? message.sources ?? []}
                                  pages={livePages.get(index) ?? []}
                                  onOpenPage={setWikiPanelSlug}
                                />
                              </div>
                              {graph && graph.nodes.length > 0 && <ChatGraph graph={graph} />}
                              <AgentRunFooter telemetry={telemetry} files={files} />
                            </>
                          ) : (
                            <>
                              {trace && trace.length > 0 && (
                                <AgentTrace
                                  trace={trace}
                                  streaming={busy && index === lastIndex && !message.content}
                                  entities={entities}
                                  components={markdownComponents}
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
                                          pages={livePages.get(index) ?? []}
                                          onOpenPage={setWikiPanelSlug}
                                        />
                                      </div>
                                    </div>
                                  );
                                })()
                              ) : trace && trace.length > 0 ? null : (
                                <Shimmer className="text-sm" duration={1.6}>
                                  {agentTurns.get(index)
                                    ? `Running ${agents.find((a) => a.id === agentId)?.label ?? "the coding agent"}…`
                                    : "Consulting the knowledge base…"}
                                </Shimmer>
                              )}
                              {graph && graph.nodes.length > 0 && <ChatGraph graph={graph} />}
                            </>
                          )
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
              <Composer
                status={status}
                busy={busy}
                onSend={send}
                onStop={() => abortRef.current?.abort()}
                entities={entities}
                agentMode={agentMode}
                onAgentModeChange={setAgentMode}
                agents={agents}
                agentId={agentId}
                onAgentIdChange={handleAgentIdChange}
                agentModel={agentModel}
                onAgentModelChange={handleAgentModelChange}
              />
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
 * A mid-run question card (agent mode). The headless agent paused and asked the
 * user to choose; this collects the answer for every question and POSTs it back,
 * unblocking the run. State is local: once mounted the card keeps its place in
 * the trace (stable key), so the selection survives later streamed events.
 */
function AskCard({ op, id, questions }: { op: string; id: string; questions: AskQuestion[] }) {
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [submitted, setSubmitted] = useState<AskAnswerItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qi] ?? [];
      if (!multi) return { ...prev, [qi]: [label] };
      return {
        ...prev,
        [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
    });
  };

  const allAnswered = questions.every((_, qi) => (selected[qi]?.length ?? 0) > 0);

  const submit = async () => {
    if (!allAnswered || busy) return;
    const answers: AskAnswerItem[] = questions.map((q, qi) => ({
      question: q.question,
      answers: selected[qi] ?? [],
    }));
    setBusy(true);
    setFailed(false);
    try {
      await api.answerAsk(op, id, answers);
      setSubmitted(answers);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (submitted) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
        <span className="text-xs font-medium text-muted-foreground">Your answer</span>
        {submitted.map((a, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">{a.question}</span>
            <div className="flex flex-wrap gap-1.5">
              {a.answers.map((ans, j) => (
                <Badge key={j} variant="secondary">
                  {ans}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
      <span className="text-xs font-medium text-muted-foreground">The agent needs your input</span>
      {questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-2">
          {qi > 0 && <Separator />}
          <div className="flex flex-wrap items-center gap-2">
            {q.header && <Badge variant="secondary">{q.header}</Badge>}
            <span className="text-sm font-medium">{q.question}</span>
            {q.multiSelect && (
              <Badge variant="outline" className="text-muted-foreground">
                choose any
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {q.options.map((opt, oi) => {
              const active = (selected[qi] ?? []).includes(opt.label);
              return (
                <Button
                  key={oi}
                  type="button"
                  size="sm"
                  variant={active ? "default" : "outline"}
                  title={opt.description}
                  onClick={() => toggle(qi, opt.label, q.multiSelect ?? false)}
                  className="h-auto whitespace-normal py-1.5 text-left"
                >
                  {active && <Check />}
                  {opt.label}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" onClick={submit} disabled={!allAnswered || busy}>
          {busy ? <Spinner /> : <Send />}
          Send
        </Button>
        {failed && <span className="text-xs text-destructive">Couldn’t send — try again.</span>}
      </div>
    </div>
  );
}

/**
 * An assistant turn's trace, in the order things happened — built from
 * ai-elements Reasoning + Tool + the answer Response. For agent turns the model's
 * `text` is woven in among the tool calls (so a tool appears exactly where it was
 * used, between two stretches of prose); for the knowledge chat the trace holds
 * only reasoning + tools and the single answer is rendered separately from
 * `content`, so `text` parts simply never appear.
 */
function AgentTrace({
  trace,
  streaming,
  entities,
  components,
}: {
  trace: AgentPart[];
  streaming: boolean;
  entities: EntitySummary[];
  components: ComponentProps<typeof MessageResponse>["components"];
}) {
  return (
    <div className="flex flex-col gap-2">
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
        if (part.kind === "text") {
          return (
            <MessageResponse
              key={index}
              className="prose-meos text-[15px]"
              isAnimating={streaming && isLast}
              components={components}
            >
              {resolveWikiLinks(part.text, entities)}
            </MessageResponse>
          );
        }
        if (part.kind === "ask") {
          return <AskCard key={index} op={part.op} id={part.id} questions={part.questions} />;
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
              {part.state === "output-error" ? (
                <ToolOutput errorText={toErrorText(part.output)} />
              ) : (
                <ToolOutput output={part.output} />
              )}
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

/** Run cost in the agent footer — sub-cent costs collapse to "<$0.01"; "" if free. */
function formatCost(usd: number): string {
  if (usd <= 0) return "";
  if (usd < 0.01) return "<$0.01";
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

/** Run duration in the agent footer — ms under a second, else seconds, else m s. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

// Glyph + colour per file-change status, matching the app's diff palette (moss =
// added, ember = removed) so the footer reads like the rest of the UI.
const FILE_STATUS: Record<FileChange["status"], { glyph: string; className: string }> = {
  added: { glyph: "+", className: "text-moss" },
  modified: { glyph: "~", className: "text-faded" },
  deleted: { glyph: "−", className: "text-ember" },
};

/**
 * The footer under an agent turn: what the run cost (cost · turns · duration) and
 * which files it created/edited/removed. Both are optional — telemetry only shows
 * for CLIs that report it (Claude Code today), and files only when the run touched
 * any — so the whole footer disappears when there's nothing to say.
 */
function AgentRunFooter({ telemetry, files }: { telemetry?: RunTelemetry; files: FileChange[] }) {
  const showTelemetry =
    telemetry !== undefined && (telemetry.numTurns > 0 || telemetry.durationMs > 0);
  if (!showTelemetry && files.length === 0) return null;
  const cost = telemetry ? formatCost(telemetry.costUsd) : "";
  return (
    <div className="mt-3 flex flex-col gap-2">
      {files.length > 0 && (
        <figure className="overflow-hidden rounded-xl border border-line bg-desk">
          <figcaption className="flex items-center justify-between border-b border-line px-3 py-2 text-[11px] text-dim">
            <span className="font-mono uppercase tracking-wider">Files changed</span>
            <span>
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
          </figcaption>
          <ul className="divide-y divide-line/60">
            {files.map((file) => {
              const { glyph, className } = FILE_STATUS[file.status];
              return (
                <li
                  key={`${file.status}:${file.path}`}
                  className="flex items-center gap-2 px-3 py-1.5 font-mono text-[12px]"
                >
                  <span className={`w-3 shrink-0 text-center ${className}`} aria-hidden>
                    {glyph}
                  </span>
                  <span className="truncate text-faded" title={file.path}>
                    {file.path}
                  </span>
                  <span className="sr-only">{file.status}</span>
                </li>
              );
            })}
          </ul>
        </figure>
      )}
      {showTelemetry && telemetry && (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-dim">
          {cost && (
            <>
              <span>{cost}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span>
            {telemetry.numTurns} {telemetry.numTurns === 1 ? "turn" : "turns"}
          </span>
          <span aria-hidden>·</span>
          <span>{formatDuration(telemetry.durationMs)}</span>
        </div>
      )}
    </div>
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
  onStop,
  entities,
  agentMode,
  onAgentModeChange,
  agents,
  agentId,
  onAgentIdChange,
  agentModel,
  onAgentModelChange,
}: {
  status: ChatStatus;
  busy: boolean;
  onSend: (text: string, agent?: boolean, model?: string, agentId?: string) => void;
  onStop: () => void;
  entities: EntitySummary[];
  // Agent mode routes the turn to a local coding agent (Claude Code, Codex, …)
  // instead of the knowledge-base assistant. Owned by ChatView so it stays sticky.
  agentMode: boolean;
  onAgentModeChange: (on: boolean) => void;
  // The coding agents installed on this machine, the selected one, and its model.
  agents: CodingAgentSummary[];
  agentId: string;
  onAgentIdChange: (id: string) => void;
  agentModel: string;
  onAgentModelChange: (model: string) => void;
}) {
  const activeAgent = agents.find((a) => a.id === agentId);
  const hasInstalledAgent = agents.some((a) => a.installed);
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
    onSend(
      parts.join("\n\n"),
      agentMode,
      agentMode ? agentModel : undefined,
      agentMode ? agentId : undefined,
    );
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
              placeholder={
                agentMode
                  ? `Tell ${activeAgent?.label ?? "the agent"} what to build, edit, or run…`
                  : "Ask your second brain…  (type / for commands)"
              }
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onAgentModeChange(!agentMode)}
                aria-pressed={agentMode}
                title="Run a local coding agent (Claude Code, Codex, …) for this turn"
                className={cn(
                  "h-7 gap-1.5 rounded-lg px-2 text-[12px] font-medium",
                  agentMode
                    ? "bg-lamp/15 text-lamp hover:bg-lamp/20 hover:text-lamp"
                    : "text-dim hover:bg-card hover:text-paper",
                )}
              >
                <Terminal className="size-3.5" />
                Agent
              </Button>
              {agentMode &&
                (agents.length === 0 ? (
                  <span className="px-1 text-[12px] text-dim">No coding agents found</span>
                ) : (
                  <>
                    {/* All supported agents: installed ones selectable, the rest
                        greyed out with an install hint so the user sees what's available. */}
                    <PromptInputSelect value={agentId} onValueChange={onAgentIdChange}>
                      <PromptInputSelectTrigger
                        title="Which coding agent to run"
                        className="h-7 gap-1 rounded-lg px-2 text-[12px] text-dim hover:text-paper"
                      >
                        {hasInstalledAgent ? (
                          <PromptInputSelectValue />
                        ) : (
                          <span className="text-dim">No agents installed</span>
                        )}
                      </PromptInputSelectTrigger>
                      <PromptInputSelectContent className="border-line bg-desk">
                        {agents.map((agent) => (
                          <PromptInputSelectItem
                            key={agent.id}
                            value={agent.id}
                            disabled={!agent.installed}
                            title={agent.installed ? undefined : agent.installHint}
                            className={cn(
                              "text-[13px]",
                              agent.installed ? "text-paper" : "text-dim opacity-60",
                            )}
                          >
                            {agent.label}
                            {!agent.installed && " · not installed"}
                          </PromptInputSelectItem>
                        ))}
                      </PromptInputSelectContent>
                    </PromptInputSelect>
                    {activeAgent?.installed && activeAgent.models.length > 0 && (
                      <ModelPicker
                        models={activeAgent.models}
                        value={agentModel}
                        onValueChange={onAgentModelChange}
                        agentId={activeAgent.id}
                      />
                    )}
                  </>
                ))}
            </PromptInputTools>
            <PromptInputSubmit
              status={status}
              onStop={onStop}
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
