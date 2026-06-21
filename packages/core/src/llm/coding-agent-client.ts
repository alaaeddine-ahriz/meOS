import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { diffSnapshots, snapshotDir } from "../coding-agent/fileChanges.js";
import type {
  AgentEvent,
  AgentRunInput,
  CodingAgentDefinition,
  McpServerSpec,
} from "../coding-agent/types.js";
import { Semaphore } from "../jobs/semaphore.js";
import { normalizeLlmError } from "./errors.js";
import {
  contentToText,
  type AgentActivityChunk,
  type AgentRequest,
  type AgentResult,
  type AgentStreamRequest,
  type ChatMessage,
  type CompletionRequest,
  type LlmClient,
  type StreamChunk,
  type StructuredRequest,
} from "./types.js";

/**
 * Back an {@link LlmClient} with a LOCAL coding-agent CLI (Claude Code, Codex,
 * Cursor, …) instead of a cloud API. Any task that already speaks `LlmClient` —
 * extraction, the wiki maintainer, the agentic chat — can therefore run entirely
 * on the user's own logged-in CLI, with no API key in meOS at all.
 *
 * The class is a thin translator over a {@link CodingAgentDefinition}: it flattens
 * our message shape into a single prompt the CLI reads on stdin, drives the run as
 * a {@link AgentEvent} stream (the same stream agent-mode chat consumes), and maps
 * those events back onto the four LlmClient capabilities. Three traits of a CLI
 * shape the design:
 *
 *  - It can't take inline images. A multimodal completion is delegated to the
 *    cloud {@link fallback} rather than silently dropping the picture.
 *  - It has no structured-output mode. `completeStructured` prompts for raw JSON,
 *    extracts + validates it, retries with the validation error, and finally falls
 *    back to the cloud client so correctness never regresses.
 *  - Each run spawns a real OS process. A {@link Semaphore} caps how many run at
 *    once so a burst of completions can't fork-bomb the machine.
 */
export interface CodingAgentLlmClientOptions {
  /** The CLI to drive (from `getCodingAgent(id)`). Owns argv, MCP wiring, parsing. */
  agent: CodingAgentDefinition;
  /** Model id forwarded to the CLI's `--model`-style flag. Falls back to the agent's default. */
  model?: string;
  /**
   * A writable directory the client owns. Every run gets a fresh unique subdir
   * under it (a contained scratch space the bypassed-permission CLI works in),
   * and {@link runAgent} materializes the request's sandbox here. Created on demand.
   */
  scratchDir: string;
  /**
   * Cloud client used when the CLI can't do the job: a multimodal {@link complete},
   * or a {@link completeStructured} the CLI never returns valid JSON for. Keeps
   * correctness from regressing when we move a task onto a local agent.
   */
  fallback: LlmClient;
  /** Max concurrent CLI spawns. Default 2 — generous for a desktop, bounded enough to not thrash. */
  concurrency?: number;
  /** meOS MCP servers exposed to {@link runAgent} / {@link streamAgent} (tool-using runs). */
  mcpServers?: Record<string, McpServerSpec>;
}

/** Default concurrent-spawn budget (see {@link CodingAgentLlmClientOptions.concurrency}). */
const DEFAULT_CONCURRENCY = 2;

/** Initial attempt aside, how many times we re-prompt the agent with its own validation error. */
const STRUCTURED_MAX_RETRIES = 2;

/**
 * How a tool-less completion's text is assembled from a run's events. A CLI emits
 * answer text as streamed `text` blocks AND a terminal `result` (the final, often
 * fuller answer). We prefer the streamed text when present and fall back to the
 * result — mirroring `runCodingAgent`'s `reply.trim() || resultText.trim()`.
 */
interface CollectedRun {
  /** Concatenated `text` event chunks. */
  text: string;
  /** The terminal `result` event's text, if the run produced one. */
  resultText: string;
  /** A terminal `error` event's message, or a failing `result`'s text. */
  failure: string | null;
}

export class CodingAgentLlmClient implements LlmClient {
  private readonly agent: CodingAgentDefinition;
  private readonly model?: string;
  private readonly scratchDir: string;
  private readonly fallback: LlmClient;
  private readonly mcpServers?: Record<string, McpServerSpec>;
  /** Caps concurrent `agent.run(...)` spawns; every run goes through `sem.run`. */
  private readonly sem: Semaphore;

  constructor(options: CodingAgentLlmClientOptions) {
    this.agent = options.agent;
    this.model = options.model;
    this.scratchDir = options.scratchDir;
    this.fallback = options.fallback;
    this.mcpServers = options.mcpServers;
    this.sem = new Semaphore(options.concurrency ?? DEFAULT_CONCURRENCY);
  }

  /** Whether a message carries an image part — a CLI can't ingest one, so we delegate. */
  private static hasImage(messages: ChatMessage[]): boolean {
    return messages.some(
      (m) => Array.isArray(m.content) && m.content.some((part) => part.type === "image"),
    );
  }

  /**
   * Flatten a request into the single prompt a CLI reads. The system prompt leads
   * (the CLI has no separate system channel for a tool-less `-p` run), then each
   * turn is labelled with its role so a multi-turn history stays legible to the
   * model. Images are already filtered upstream — {@link contentToText} drops any.
   */
  private static flattenPrompt(request: CompletionRequest): string {
    const parts: string[] = [];
    if (request.system?.trim()) parts.push(request.system.trim());
    for (const message of request.messages) {
      const text = contentToText(message.content).trim();
      if (!text) continue;
      const label = message.role === "assistant" ? "Assistant" : "User";
      parts.push(`${label}: ${text}`);
    }
    return parts.join("\n\n");
  }

  /** A fresh, unique scratch subdir for one run (created recursively). Product code, so a random id is fine. */
  private freshDir(): string {
    const dir = path.join(this.scratchDir, `run-${Date.now()}-${randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Spawn the agent for one turn under the concurrency cap, draining its event
   * stream into the run's collected text. Tool-less by default (`mcpServers`
   * omitted) so a plain completion can't wander off editing files; callers that
   * need tools pass `mcpServers`/`systemPrompt`/`onEvent` explicitly. `cwd` is the
   * scratch subdir the run works in.
   */
  private async collect(
    cwd: string,
    prompt: string,
    extra?: Partial<AgentRunInput> & { onEvent?: (event: AgentEvent) => void },
  ): Promise<CollectedRun> {
    const { onEvent, ...input } = extra ?? {};
    return this.sem.run(async () => {
      const run: CollectedRun = { text: "", resultText: "", failure: null };
      try {
        for await (const event of this.agent.run({
          prompt,
          cwd,
          model: this.model,
          ...input,
        })) {
          onEvent?.(event);
          switch (event.type) {
            case "text":
              run.text += event.text;
              break;
            case "result":
              run.resultText = event.text;
              if (event.isError) run.failure = event.text || "the agent run failed";
              break;
            case "error":
              run.failure = event.message;
              break;
            // session/reasoning/tool-call/tool-result don't contribute to the answer.
          }
        }
      } catch (error) {
        // A spawn/parse failure surfaces as a thrown value — normalize it to the
        // same LlmError contract every other client rejects with.
        throw normalizeLlmError(error, this.agent.id);
      }
      return run;
    });
  }

  /** The answer a completion run produced: streamed text first, else the terminal result. */
  private static answerOf(run: CollectedRun): string {
    return run.text.trim() || run.resultText.trim();
  }

  async complete(request: CompletionRequest): Promise<string> {
    // A CLI can't see inline images — hand any multimodal turn to the cloud client.
    if (CodingAgentLlmClient.hasImage(request.messages)) {
      return this.fallback.complete(request);
    }
    const cwd = this.freshDir();
    const run = await this.collect(cwd, CodingAgentLlmClient.flattenPrompt(request));
    const answer = CodingAgentLlmClient.answerOf(run);
    if (!answer && run.failure) {
      throw normalizeLlmError(new Error(run.failure), this.agent.id);
    }
    return answer;
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    // No CLI exposes a structured-output mode, so we ask for raw JSON, validate it
    // ourselves, and retry with the validation error appended. Multimodal can't be
    // done locally either — delegate straight to the cloud client.
    if (CodingAgentLlmClient.hasImage(request.messages)) {
      return this.fallback.completeStructured(request);
    }

    const jsonSchema = z.toJSONSchema(request.schema, { target: "draft-7" });
    const base = CodingAgentLlmClient.buildStructuredPrompt(request, jsonSchema);
    let lastError = "";

    // 1 initial attempt + up to 2 retries, each fed the prior validation error.
    for (let attempt = 0; attempt <= STRUCTURED_MAX_RETRIES; attempt++) {
      const prompt = lastError
        ? `${base}\n\nYour previous response was invalid: ${lastError}\nReturn ONLY corrected JSON, no prose, no code fences.`
        : base;
      const cwd = this.freshDir();
      const run = await this.collect(cwd, prompt);
      const raw = CodingAgentLlmClient.extractJson(CodingAgentLlmClient.answerOf(run));
      try {
        return request.schema.parse(JSON.parse(raw));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    // The agent never produced valid JSON — the cloud client's structured-output
    // mode is the correctness backstop, so the result is exactly what callers expect.
    return this.fallback.completeStructured(request);
  }

  /** Wrap the schema in an instruction to emit ONLY a matching JSON object. */
  private static buildStructuredPrompt(
    request: StructuredRequest<unknown>,
    jsonSchema: unknown,
  ): string {
    return [
      CodingAgentLlmClient.flattenPrompt(request),
      "",
      `Respond with ONLY a single JSON object named "${request.schemaName}" that conforms to this JSON Schema.`,
      "Do not include any prose, explanation, or markdown code fences — output raw JSON only.",
      "",
      "JSON Schema:",
      JSON.stringify(jsonSchema, null, 2),
    ].join("\n");
  }

  /**
   * Pull a JSON object out of a CLI's free-form answer: strip a ```json fence if
   * present, then — if prose still surrounds it — take the substring from the first
   * `{` to the last `}`. Returns the original text when neither applies, letting
   * `JSON.parse` throw a useful error the retry loop feeds back to the model.
   */
  private static extractJson(text: string): string {
    let out = text.trim();
    const fenced = out.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) out = fenced[1].trim();
    if (!out.startsWith("{")) {
      const first = out.indexOf("{");
      const last = out.lastIndexOf("}");
      if (first !== -1 && last > first) out = out.slice(first, last + 1);
    }
    return out;
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    // Streaming a completion just means surfacing the run's text/reasoning events as
    // they arrive. Multimodal still has to go to the cloud client (it can't stream
    // an image to a CLI), so re-stream its output through the same chunk shape.
    if (CodingAgentLlmClient.hasImage(request.messages)) {
      yield* this.fallback.stream(request);
      return;
    }
    const cwd = this.freshDir();
    const prompt = CodingAgentLlmClient.flattenPrompt(request);
    // Hold one permit for the whole run by buffering its chunks inside `sem.run`,
    // so a queued caller can't begin spawning until this run finishes. The buffer
    // is bounded by the answer length, which the CLI already caps.
    const chunks = await this.sem.run(async () =>
      this.drain(
        this.agent.run({ prompt, cwd, model: this.model }),
        (event): StreamChunk | null => {
          if (event.type === "text") return { type: "text", text: event.text };
          if (event.type === "reasoning") return { type: "reasoning", text: event.text };
          return null;
        },
      ),
    );
    yield* chunks;
  }

  /**
   * Buffer a run's events into chunks under one permit: map each event, dropping
   * `null`s, surface a terminal `error` as a thrown {@link normalizeLlmError}.
   * Buffering (rather than yielding live) is what holds the permit for the whole
   * run, so a queued caller can't begin spawning until this one finishes.
   */
  private async drain<T>(
    events: AsyncIterable<AgentEvent>,
    map: (event: AgentEvent) => T | null,
  ): Promise<T[]> {
    const chunks: T[] = [];
    try {
      for await (const event of events) {
        if (event.type === "error") throw new Error(event.message);
        const chunk = map(event);
        if (chunk) chunks.push(chunk);
      }
    } catch (error) {
      throw normalizeLlmError(error, this.agent.id);
    }
    return chunks;
  }

  /**
   * Map a coding-agent {@link AgentEvent} onto the chat-facing
   * {@link AgentActivityChunk} the LlmClient surfaces. `session` and `result` carry
   * no transcript content, so they map to nothing.
   */
  private static toActivity(event: AgentEvent): AgentActivityChunk | null {
    switch (event.type) {
      case "reasoning":
        return { type: "reasoning", text: event.text };
      case "text":
        return { type: "text", text: event.text };
      case "tool-call":
        return {
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        };
      case "tool-result":
        return {
          type: "tool-result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
        };
      default:
        return null;
    }
  }

  async runAgent(request: AgentRequest): Promise<AgentResult> {
    // Bridge the in-memory bash-tool sandbox to the CLI, which only edits a real
    // directory: materialize the sandbox's files to a fresh scratch dir, run the
    // agent there, then read the files the run touched back into the sandbox so the
    // caller (e.g. the wiki maintainer) sees the edits exactly as with the cloud
    // client. See readSandbox / writeBackChanges for the assumptions this rests on.
    const cwd = this.freshDir();
    const before = await CodingAgentLlmClient.materializeSandbox(request.sandbox, cwd);

    const emit = (chunk: AgentActivityChunk) => {
      try {
        request.onActivity?.(chunk);
      } catch {
        /* a broken sink can't break the agent run */
      }
    };

    let steps = 0;
    const run = await this.collect(cwd, request.prompt, {
      systemPrompt: request.system,
      mcpServers: this.mcpServers,
      onEvent: (event) => {
        if (event.type === "result") steps++;
        const chunk = CodingAgentLlmClient.toActivity(event);
        if (chunk) emit(chunk);
      },
    });

    // Read back what changed on disk into the sandbox the caller will inspect.
    await CodingAgentLlmClient.writeBackChanges(request.sandbox, cwd, before);

    const text = CodingAgentLlmClient.answerOf(run);
    // A CLI reports turns in its terminal `result`; absent that we still ran once.
    return { text, steps: steps || 1 };
  }

  async *streamAgent(request: AgentStreamRequest): AsyncIterable<AgentActivityChunk> {
    // The sandbox-free, MCP-tool-driven run that powers agentic chat. There's no
    // sandbox to bridge — the tools act through meOS's MCP servers — so we just run
    // in a scratch cwd, inject the MCP servers, and map each event to a chunk. The
    // mapping mirrors coding-agent-command.ts so the chat renders this identically.
    const cwd = this.freshDir();
    const prompt = CodingAgentLlmClient.flattenAgentStream(request);
    const chunks = await this.sem.run(async () =>
      this.drain(
        this.agent.run({
          prompt,
          cwd,
          model: this.model,
          systemPrompt: request.system,
          mcpServers: this.mcpServers,
        }),
        (event) => CodingAgentLlmClient.toActivity(event),
      ),
    );
    yield* chunks;
  }

  /** Flatten a chat history into the single prompt a CLI turn reads (last user turn + context). */
  private static flattenAgentStream(request: AgentStreamRequest): string {
    return CodingAgentLlmClient.flattenPrompt({
      system: request.system,
      messages: request.messages,
    });
  }

  // ── runAgent sandbox bridge ────────────────────────────────────────────────
  //
  // ASSUMPTION (documented per the PR brief): the bash-tool `Sandbox` interface
  // exposes only `readFile(path)`, `writeFiles([{path,content}])`, and
  // `executeCommand(command)` — there is NO native "list every file" method. To
  // enumerate the sandbox we therefore run `find` THROUGH the sandbox's own shell
  // (`executeCommand`), which works for the in-memory just-bash sandbox the wiki
  // maintainer uses. The bridge is best-effort: if enumeration or a read fails we
  // skip that file rather than abort the run, so a sandbox whose shell behaves
  // differently degrades to "fewer files mirrored" instead of a hard failure.

  /**
   * Copy the sandbox's current files into the real directory `cwd` (so the CLI,
   * which only knows real paths, can read and edit them), and return a snapshot of
   * `cwd` taken right after — the baseline {@link writeBackChanges} diffs against.
   */
  private static async materializeSandbox(
    sandbox: AgentRequest["sandbox"],
    cwd: string,
  ): Promise<ReturnType<typeof snapshotDir>> {
    for (const rel of await CodingAgentLlmClient.listSandboxFiles(sandbox)) {
      let content: string;
      try {
        content = await sandbox.readFile(rel);
      } catch {
        continue; // unreadable in the sandbox — skip, don't fail the whole run
      }
      const dest = path.join(cwd, rel);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
      } catch {
        /* a path we can't write (e.g. escaping cwd) is simply not mirrored */
      }
    }
    return snapshotDir(cwd);
  }

  /**
   * After the run, diff `cwd` against the pre-run snapshot and write every
   * added/modified file back into the sandbox via `writeFiles`, so the caller
   * reading the sandbox sees exactly what the CLI changed on disk. Deletions are
   * left in place — the sandbox has no delete primitive and the maintainer only
   * ever reads files it expects to exist.
   */
  private static async writeBackChanges(
    sandbox: AgentRequest["sandbox"],
    cwd: string,
    before: ReturnType<typeof snapshotDir>,
  ): Promise<void> {
    const changes = diffSnapshots(before, snapshotDir(cwd));
    const files: Array<{ path: string; content: string }> = [];
    for (const change of changes) {
      if (change.status === "deleted") continue;
      try {
        files.push({
          path: change.path,
          content: fs.readFileSync(path.join(cwd, change.path), "utf8"),
        });
      } catch {
        /* the file vanished between diff and read — skip it */
      }
    }
    if (files.length > 0) {
      try {
        await sandbox.writeFiles(files);
      } catch {
        /* best-effort: a sandbox that rejects the write leaves the caller its prior copy */
      }
    }
  }

  /**
   * List every regular file in the sandbox, relative to its working directory, by
   * running `find` through its shell. Returns `[]` on any failure (the
   * write-everything-back path then just mirrors nothing), so a sandbox without a
   * usable `find` degrades gracefully rather than throwing.
   */
  private static async listSandboxFiles(sandbox: AgentRequest["sandbox"]): Promise<string[]> {
    try {
      const result = await sandbox.executeCommand(
        "find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*'",
      );
      return result.stdout
        .split("\n")
        .map((line) => line.trim().replace(/^\.\//, ""))
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }
}
