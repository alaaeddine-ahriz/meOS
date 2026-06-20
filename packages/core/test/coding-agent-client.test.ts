import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AgentEvent,
  AgentRunInput,
  CodingAgentDefinition,
} from "../src/coding-agent/types.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import { StubLlmClient } from "../src/llm/stub.js";
import type {
  AgentActivityChunk,
  AgentRequest,
  ChatMessage,
  CompletionRequest,
  StructuredRequest,
} from "../src/llm/types.js";
import type { Sandbox } from "bash-tool";

/**
 * Drive {@link CodingAgentLlmClient} against a FAKE {@link CodingAgentDefinition}
 * whose `run` replays a scripted, deterministic event stream — so every path is
 * exercised offline, with no real CLI spawn. The fake also records each prompt and
 * tracks how many runs are in flight, which lets us assert the concurrency cap.
 */

/** A scripted agent: each call to `run` plays `script(input)` and counts overlap. */
class FakeAgent implements CodingAgentDefinition {
  id = "claude" as const;
  label = "Fake";
  bin = "fake";
  installHint = "";
  models = [{ value: "fake-model", label: "Fake" }];
  defaultModel = "fake-model";
  streaming = true;
  supportsResume = false;

  /** Prompts seen, in order — lets a test assert the retry prompt carried the error. */
  readonly prompts: string[] = [];
  /** Highest number of `run` iterations alive at once — the concurrency witness. */
  maxConcurrent = 0;
  private active = 0;

  constructor(
    private readonly script: (input: AgentRunInput, call: number) => AgentEvent[],
    /** Per-run delay so two overlapping calls actually contend for a permit. */
    private readonly delayMs = 0,
  ) {}

  private callCount = 0;

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const call = this.callCount++;
    this.prompts.push(input.prompt);
    this.active++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    try {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      for (const event of this.script(input, call)) {
        yield event;
      }
    } finally {
      this.active--;
    }
  }
}

/** Standard terminal-result event so a run looks complete to the collector. */
function result(text: string): AgentEvent {
  return {
    type: "result",
    sessionId: "s1",
    isError: false,
    subtype: "success",
    text,
    costUsd: 0,
    numTurns: 1,
    durationMs: 0,
  };
}

function userMessage(content: ChatMessage["content"]): ChatMessage {
  return { role: "user", content };
}

let scratchDir: string;

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "cac-test-"));
});

afterEach(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("CodingAgentLlmClient.complete", () => {
  it("returns the scripted final answer text", async () => {
    const agent = new FakeAgent(() => [
      { type: "text", text: "Hello, " },
      { type: "text", text: "world." },
      result("Hello, world."),
    ]);
    const client = new CodingAgentLlmClient({
      agent,
      scratchDir,
      fallback: new StubLlmClient(),
    });

    const request: CompletionRequest = { messages: [userMessage("hi")] };
    await expect(client.complete(request)).resolves.toBe("Hello, world.");
  });

  it("flattens system + history into the prompt the CLI receives", async () => {
    const agent = new FakeAgent(() => [result("ok")]);
    const client = new CodingAgentLlmClient({
      agent,
      scratchDir,
      fallback: new StubLlmClient(),
    });

    await client.complete({
      system: "You are terse.",
      messages: [userMessage("What is 2+2?")],
    });

    expect(agent.prompts[0]).toContain("You are terse.");
    expect(agent.prompts[0]).toContain("User: What is 2+2?");
  });
});

describe("CodingAgentLlmClient.completeStructured", () => {
  const schema = z.object({ city: z.string(), population: z.number() });

  function structuredRequest(): StructuredRequest<{ city: string; population: number }> {
    return {
      schema,
      schemaName: "CityInfo",
      messages: [userMessage("Give me a city.")],
    };
  }

  it("parses a valid JSON answer into the zod type", async () => {
    const agent = new FakeAgent(() => [result('{"city":"Paris","population":2161000}')]);
    const client = new CodingAgentLlmClient({
      agent,
      scratchDir,
      fallback: new StubLlmClient(),
    });

    await expect(client.completeStructured(structuredRequest())).resolves.toEqual({
      city: "Paris",
      population: 2161000,
    });
  });

  it("strips a ```json fence and surrounding prose before parsing", async () => {
    const agent = new FakeAgent(() => [
      result('Here you go:\n```json\n{"city":"Berlin","population":3645000}\n```'),
    ]);
    const client = new CodingAgentLlmClient({
      agent,
      scratchDir,
      fallback: new StubLlmClient(),
    });

    await expect(client.completeStructured(structuredRequest())).resolves.toEqual({
      city: "Berlin",
      population: 3645000,
    });
  });

  it("retries with the validation error, then FALLS BACK when the agent keeps emitting bad JSON", async () => {
    // The agent never returns valid JSON, so all 1 + 2 attempts fail and the
    // client must hand off to the fallback's structured-output mode.
    const agent = new FakeAgent(() => [result("definitely not json")]);
    let fallbackCalls = 0;
    const fallback = new StubLlmClient({
      onStructured: () => {
        fallbackCalls++;
        return { city: "Fallbackville", population: 1 };
      },
    });
    const client = new CodingAgentLlmClient({ agent, scratchDir, fallback });

    const value = await client.completeStructured(structuredRequest());

    // The fallback's value is returned verbatim (correctness never regresses).
    expect(value).toEqual({ city: "Fallbackville", population: 1 });
    expect(fallbackCalls).toBe(1);
    // 1 initial attempt + 2 retries were spent on the agent before falling back.
    expect(agent.prompts).toHaveLength(3);
    // A retry prompt carries the prior validation error so the model can correct.
    expect(agent.prompts[1]).toMatch(/previous response was invalid/i);
  });
});

describe("CodingAgentLlmClient multimodal delegation", () => {
  it("delegates a complete() carrying an image to the fallback", async () => {
    // The fake agent would throw if it ran (no script for an image turn); reaching
    // the fallback proves the image short-circuited before any CLI spawn.
    const agent = new FakeAgent(() => {
      throw new Error("agent should not run for a multimodal request");
    });
    let fallbackText = "";
    const fallback = new StubLlmClient({
      onComplete: () => {
        fallbackText = "from-fallback";
        return fallbackText;
      },
    });
    const client = new CodingAgentLlmClient({ agent, scratchDir, fallback });

    const request: CompletionRequest = {
      messages: [
        userMessage([
          { type: "text", text: "What is in this image?" },
          { type: "image", mediaType: "image/png", data: "deadbeef" },
        ]),
      ],
    };

    await expect(client.complete(request)).resolves.toBe("from-fallback");
    expect(fallbackText).toBe("from-fallback");
    // The agent was never spawned.
    expect(agent.prompts).toHaveLength(0);
  });
});

describe("CodingAgentLlmClient concurrency cap", () => {
  it("never runs two agent spawns at once when concurrency=1", async () => {
    // Each run holds a permit for `delayMs`; with two overlapping calls and a cap
    // of 1, the second must wait — so maxConcurrent never exceeds 1.
    const agent = new FakeAgent(() => [result("done")], 20);
    const client = new CodingAgentLlmClient({
      agent,
      scratchDir,
      fallback: new StubLlmClient(),
      concurrency: 1,
    });

    await Promise.all([
      client.complete({ messages: [userMessage("a")] }),
      client.complete({ messages: [userMessage("b")] }),
    ]);

    expect(agent.maxConcurrent).toBe(1);
  });

  it("allows overlap up to the configured cap", async () => {
    const agent = new FakeAgent(() => [result("done")], 20);
    const client = new CodingAgentLlmClient({
      agent,
      scratchDir,
      fallback: new StubLlmClient(),
      concurrency: 2,
    });

    await Promise.all([
      client.complete({ messages: [userMessage("a")] }),
      client.complete({ messages: [userMessage("b")] }),
    ]);

    expect(agent.maxConcurrent).toBe(2);
  });
});

/**
 * A minimal in-memory {@link Sandbox} for the runAgent bridge test. It backs its
 * three methods with a plain map and answers the bridge's `find . -type f` by
 * listing every key — exactly the contract `materializeSandbox`/`listSandboxFiles`
 * assume. Files written back by the run land in `files` for the test to inspect.
 */
class FakeSandbox implements Sandbox {
  constructor(readonly files: Map<string, string> = new Map()) {}

  async executeCommand(command: string) {
    // The bridge only ever runs a `find` to enumerate files.
    const stdout = command.startsWith("find")
      ? [...this.files.keys()].map((p) => `./${p}`).join("\n")
      : "";
    return { stdout, stderr: "", exitCode: 0 };
  }

  async readFile(filePath: string): Promise<string> {
    const content = this.files.get(filePath.replace(/^\.\//, ""));
    if (content === undefined) throw new Error(`no such file: ${filePath}`);
    return content;
  }

  async writeFiles(files: Array<{ path: string; content: string | Buffer }>): Promise<void> {
    for (const { path: p, content } of files) {
      this.files.set(p, typeof content === "string" ? content : content.toString("utf8"));
    }
  }
}

describe("CodingAgentLlmClient.runAgent (sandbox bridge)", () => {
  it("materializes the sandbox, runs in that cwd, and writes changed files back", async () => {
    // The fake agent edits a real file in its cwd (where the sandbox was mirrored),
    // standing in for what a CLI would do; the bridge must then surface that edit
    // back into the sandbox so the caller (e.g. the wiki maintainer) reads it.
    const agent = new FakeAgent((input) => {
      const existing = fs.readFileSync(path.join(input.cwd, "page.md"), "utf8");
      fs.writeFileSync(path.join(input.cwd, "page.md"), `${existing}\nedited by agent`);
      return [{ type: "text", text: "updated" }, result("updated")];
    });
    const client = new CodingAgentLlmClient({
      agent,
      scratchDir,
      fallback: new StubLlmClient(),
    });

    const sandbox = new FakeSandbox(new Map([["page.md", "original"]]));
    const activity: AgentActivityChunk[] = [];
    const request: AgentRequest = {
      prompt: "edit the page",
      tools: {},
      sandbox,
      onActivity: (chunk) => activity.push(chunk),
    };

    const out = await client.runAgent(request);

    expect(out.text).toBe("updated");
    expect(out.steps).toBe(1);
    // The agent's on-disk edit was read back into the sandbox.
    expect(sandbox.files.get("page.md")).toBe("original\nedited by agent");
    // The run's text surfaced to onActivity.
    expect(activity).toContainEqual({ type: "text", text: "updated" });
  });
});

describe("CodingAgentLlmClient.stream", () => {
  it("maps text and reasoning events to stream chunks", async () => {
    const agent = new FakeAgent(() => [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "answer" },
      result("answer"),
    ]);
    const client = new CodingAgentLlmClient({
      agent,
      scratchDir,
      fallback: new StubLlmClient(),
    });

    const chunks = [];
    for await (const chunk of client.stream({ messages: [userMessage("go")] })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "answer" },
    ]);
  });
});
