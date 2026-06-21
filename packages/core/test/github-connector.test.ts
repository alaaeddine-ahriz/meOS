import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallOptions, ToolSet } from "ai";
import type { AgentToolContext } from "../src/connectors/framework.js";
import { connectorRegistry } from "../src/connectors/registry.js";
import { githubConnector } from "../src/connectors/github/connector.js";
import {
  fetchIssuesDelta,
  fetchReposDelta,
  type GithubIssueItem,
  type GithubRepoItem,
} from "../src/connectors/github/http.js";
import { mapIssue, mapRepo } from "../src/connectors/github/map.js";

const viewer = { login: "ada", name: "Ada Lovelace" };

const repo = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  node_id: "R_1",
  name: "engine",
  full_name: "ada/engine",
  owner: { login: "ada", type: "User" },
  description: "The analytical engine.",
  language: "Assembly",
  topics: ["compute", "history"],
  private: false,
  fork: false,
  archived: false,
  stargazers_count: 42,
  pushed_at: "2026-06-10T00:00:00Z",
  updated_at: "2026-06-12T00:00:00Z",
  html_url: "https://github.com/ada/engine",
  ...over,
});

const issue = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 9,
  node_id: "I_9",
  number: 7,
  title: "Punch-card jam",
  body: "The reader jams on column 80.",
  state: "open",
  user: { login: "charles" },
  assignees: [{ login: "ada" }],
  labels: [{ name: "bug" }, "regression"],
  repository: { full_name: "ada/engine", private: false },
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-11T00:00:00Z",
  html_url: "https://github.com/ada/engine/issues/7",
  ...over,
});

describe("GitHub mappers", () => {
  it("maps a repo to a project with owner/works-on edges and typed facts", () => {
    const ext = mapRepo(mapRepoItem(repo({ owner: { login: "babbage", type: "User" } })), viewer);

    const project = ext.entities.find((e) => e.name === "ada/engine")!;
    expect(project.type).toBe("project");
    expect(project.relevance).toBe("high");
    // A non-self owner becomes a person entity + an "owns" edge.
    expect(ext.entities.some((e) => e.name === "babbage" && e.type === "person")).toBe(true);
    expect(ext.relationships).toContainEqual({ from: "babbage", to: "ada/engine", label: "owns" });
    // You are anchored to every repo in your list.
    expect(ext.relationships).toContainEqual({
      from: "Ada Lovelace",
      to: "ada/engine",
      label: "works on",
    });
    expect(ext.observations.some((o) => o.claim.includes("written in Assembly"))).toBe(true);
    expect(ext.observations.some((o) => o.claim.includes("tagged with: compute, history"))).toBe(
      true,
    );
  });

  it("does not create a self-as-owner entity for your own repo", () => {
    const ext = mapRepo(mapRepoItem(repo()), viewer);
    expect(ext.entities.every((e) => e.name !== "ada")).toBe(true);
    expect(ext.relationships).toContainEqual({
      from: "Ada Lovelace",
      to: "ada/engine",
      label: "works on",
    });
  });

  it("tags private-repo facts as private", () => {
    const ext = mapRepo(mapRepoItem(repo({ private: true })), viewer);
    expect(ext.observations.every((o) => o.sensitivity === "private")).toBe(true);
  });

  it("maps an open issue to a task on the repo, attributing the author", () => {
    const ext = mapIssue(mapIssueItem(issue()), viewer);
    const work = ext.observations.find((o) => o.entity === "ada/engine")!;
    expect(work.kind).toBe("task");
    expect(work.claim).toContain('Issue #7 "Punch-card jam"');
    expect(work.validFrom).toBe("2026-06-01");
    // Author is a non-self person tied to the project; the assignee (you) is not duplicated.
    expect(ext.entities.some((e) => e.name === "charles" && e.type === "person")).toBe(true);
    expect(ext.entities.every((e) => e.name !== "ada")).toBe(true);
    expect(ext.relationships).toContainEqual({
      from: "charles",
      to: "ada/engine",
      label: "works on",
    });
  });

  it("maps a closed PR to a fact and marks it a pull request", () => {
    const ext = mapIssue(
      mapIssueItem(issue({ state: "closed", pull_request: { url: "x" }, title: "Add reader" })),
      viewer,
    );
    const work = ext.observations.find((o) => o.entity === "ada/engine")!;
    expect(work.kind).toBe("fact");
    expect(work.claim).toContain("PR #7");
    expect(work.claim).toContain("pull request");
  });
});

describe("GitHub REST delta fetchers", () => {
  afterEach(() => vi.restoreAllMocks());

  function stubFetch(routes: (url: string) => unknown) {
    vi.stubGlobal("fetch", async (url: string) => {
      const body = routes(url);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    });
  }

  it("pages repos newest-first, stops at the cursor, returns a high-water token", async () => {
    stubFetch((url) => {
      if (url.includes("/user/repos")) {
        return [
          repo({ node_id: "R_new", updated_at: "2026-06-12T00:00:00Z" }),
          repo({ node_id: "R_old", updated_at: "2026-06-01T00:00:00Z" }),
        ];
      }
      return {};
    });
    const delta = await fetchReposDelta("tok", "2026-06-05T00:00:00Z");
    // Only the repo newer than the cursor is taken; the older one halts the walk.
    expect(delta.items.map((r) => r.externalId)).toEqual(["R_new"]);
    expect(delta.nextSyncToken).toBe("2026-06-12T00:00:00Z");
    expect(delta.deletions).toEqual([]);
  });

  it("passes the saved cursor as `since` and skips the inclusive boundary issue", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.includes("/issues")) {
        return [
          issue({ node_id: "I_boundary", updated_at: "2026-06-05T00:00:00Z" }),
          issue({ node_id: "I_new", updated_at: "2026-06-09T00:00:00Z" }),
        ];
      }
      return {};
    });
    const delta = await fetchIssuesDelta("tok", "2026-06-05T00:00:00Z");
    const call = seen.find((u) => u.includes("/issues"))!;
    expect(call).toContain("since=");
    expect(decodeURIComponent(call)).toContain("since=2026-06-05T00:00:00Z");
    // Boundary item (== cursor) dropped; only the strictly-newer one survives.
    expect(delta.items.map((i) => i.externalId)).toEqual(["I_new"]);
    expect(delta.nextSyncToken).toBe("2026-06-09T00:00:00Z");
  });
});

describe("GitHub agent tools", () => {
  afterEach(() => vi.restoreAllMocks());

  function stubFetch(routes: (url: string) => unknown) {
    vi.stubGlobal("fetch", async (url: string) => {
      const body = routes(url);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    });
  }

  function agentCtx(enabled: string[], onToken?: () => void): AgentToolContext {
    return {
      store: {} as never,
      embedder: {} as never,
      enabledKinds: new Set(enabled),
      getAccessToken: async () => {
        onToken?.();
        return "tok";
      },
    } satisfies AgentToolContext;
  }

  const opts: ToolCallOptions = { toolCallId: "t1", messages: [] };
  async function callTool(tools: ToolSet, name: string, input: Record<string, unknown>) {
    const t = tools[name];
    if (!t || typeof t.execute !== "function") throw new Error(`tool ${name} is not executable`);
    const exec = t.execute as (i: Record<string, unknown>, o: ToolCallOptions) => Promise<unknown>;
    return String(await exec(input, opts));
  }

  it("contributes one tool per enabled kind, each gated on its kind", () => {
    expect(Object.keys(githubConnector.agentTools(agentCtx([])))).toEqual([]);
    expect(Object.keys(githubConnector.agentTools(agentCtx(["repos"])))).toEqual([
      "search_github_repos",
    ]);
    expect(Object.keys(githubConnector.agentTools(agentCtx(["issues"])))).toEqual([
      "search_github_issues",
    ]);
    expect(Object.keys(githubConnector.agentTools(agentCtx(["repos", "issues"]))).sort()).toEqual([
      "search_github_issues",
      "search_github_repos",
    ]);
  });

  it("builds tools lazily — no token is minted until a tool runs", () => {
    let minted = 0;
    githubConnector.agentTools(agentCtx(["repos", "issues"], () => minted++));
    expect(minted).toBe(0);
  });

  it("search_github_repos renders the matches it finds", async () => {
    stubFetch((url) => {
      if (url.includes("/user")) return { login: "ada", name: "Ada Lovelace" };
      if (url.includes("/search/repositories")) return { items: [repo()] };
      return {};
    });
    const tools = githubConnector.agentTools(agentCtx(["repos"]));
    const out = await callTool(tools, "search_github_repos", { query: "engine" });
    expect(out).toContain("Repository: ada/engine");
    expect(out).toContain("Language: Assembly");
  });

  it("returns a graceful message instead of throwing when GitHub errors", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }) as Response,
    );
    const tools = githubConnector.agentTools(agentCtx(["issues"]));
    const out = await callTool(tools, "search_github_issues", { query: "x" });
    expect(out).toContain("Couldn't search GitHub issues");
  });
});

describe("GitHub connector registration", () => {
  it("is registered and exposes unique, well-formed source types", () => {
    const c = connectorRegistry.get("github")!;
    expect(c).toBeTruthy();
    expect(c.manifest.displayName).toBe("GitHub");
    const types = c.manifest.kinds.map((k) => k.sourceType);
    expect(types).toEqual(["github:repos", "github:issues"]);
    expect(c.oauth).toBeDefined();
  });
});

// --- small adapters: the mappers take the normalized item shapes, so the test
// fixtures (raw-ish JSON) are projected through the same fields the http client sets.
function mapRepoItem(raw: ReturnType<typeof repo>): GithubRepoItem {
  return {
    externalId: String(raw.node_id),
    fullName: String(raw.full_name),
    name: String(raw.name),
    ownerLogin: String(raw.owner.login),
    ownerIsOrg: raw.owner.type === "Organization",
    description: (raw.description as string | null) ?? null,
    language: (raw.language as string | null) ?? null,
    topics: raw.topics as string[],
    isPrivate: Boolean(raw.private),
    isFork: Boolean(raw.fork),
    isArchived: Boolean(raw.archived),
    stars: Number(raw.stargazers_count),
    pushedAt: (raw.pushed_at as string | null) ?? null,
    updatedAt: String(raw.updated_at),
    htmlUrl: String(raw.html_url),
  };
}

function mapIssueItem(raw: ReturnType<typeof issue>): GithubIssueItem {
  return {
    externalId: String(raw.node_id),
    number: Number(raw.number),
    title: String(raw.title),
    body: (raw.body as string | null) ?? null,
    state: String(raw.state),
    isPullRequest: Boolean((raw as Record<string, unknown>).pull_request),
    repoFullName: String(raw.repository.full_name),
    repoPrivate: Boolean(raw.repository.private),
    authorLogin: raw.user ? String(raw.user.login) : null,
    assigneeLogins: (raw.assignees as Array<{ login: string }>).map((a) => a.login),
    labels: (raw.labels as Array<string | { name: string }>).map((l) =>
      typeof l === "string" ? l : l.name,
    ),
    createdAt: (raw.created_at as string | null) ?? null,
    updatedAt: String(raw.updated_at),
    htmlUrl: String(raw.html_url),
  };
}
