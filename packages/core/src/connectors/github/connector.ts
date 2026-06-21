/**
 * GitHub behind the connector framework — a sibling of `google/connector.ts`. It
 * indexes the repositories you own or collaborate on and the issues / pull requests
 * that involve you, normalizing each into the graph (a repo is a project; an issue is
 * a dated work item). Auth is an OAuth App whose credentials the user pastes in
 * Settings; the orchestrator never learns GitHub's name.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type {
  AgentToolContext,
  Connector,
  ConnectorManifest,
  NormalizedDelta,
  NormalizedItem,
  OAuthProvider,
  SyncContext,
} from "../framework.js";
import type { DeltaResult } from "../types.js";
import {
  fetchIssuesDelta,
  fetchReposDelta,
  fetchViewer,
  searchIssues,
  searchRepos,
  type GithubIssueItem,
  type GithubRepoItem,
  type GithubViewer,
} from "./http.js";
import { mapIssue, mapRepo } from "./map.js";
import {
  buildAuthUrl,
  exchangeCode,
  GITHUB_SCOPES,
  refreshAccessToken,
  revokeToken,
} from "./oauth.js";

/** The GitHub connector's static description: id, kinds, auth model. */
export const GITHUB_MANIFEST: ConnectorManifest = {
  id: "github",
  displayName: "GitHub",
  logo: "github",
  summary: "Index your repositories and the issues & PRs that involve you.",
  brandColor: "#181717",
  auth: { kind: "oauth2", scopes: GITHUB_SCOPES },
  kinds: [
    {
      kind: "repos",
      displayName: "Repositories",
      sourceType: "github:repos",
      contentMode: "document",
      defaultIntervalMinutes: 60,
      logo: "github",
      noun: { one: "repository", many: "repositories" },
      blurb: "The repos you own or contribute to, as projects in your graph.",
      // Content (a repo describes a project), so it earns a wiki page — private repos
      // produce private facts that stay on-device. Not a directory/identity source.
    },
    {
      kind: "issues",
      displayName: "Issues & PRs",
      sourceType: "github:issues",
      contentMode: "document",
      defaultIntervalMinutes: 30,
      logo: "github",
      noun: { one: "issue", many: "issues" },
      blurb: "Issues and pull requests assigned to, opened by, or mentioning you.",
    },
  ],
};

/** GitHub's OAuth surface, the framework's {@link OAuthProvider} over `oauth.ts`. */
const oauth: OAuthProvider = {
  scopes: GITHUB_SCOPES,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
};

/** Terse, label-led text — the NORMALIZED document that gets chunked + indexed. */
function renderRepo(r: GithubRepoItem): string {
  const lines = [`Repository: ${r.fullName}`];
  if (r.description) lines.push(`Description: ${r.description}`);
  if (r.language) lines.push(`Language: ${r.language}`);
  if (r.topics.length) lines.push(`Topics: ${r.topics.join(", ")}`);
  lines.push(`Visibility: ${r.isPrivate ? "private" : "public"}`);
  if (r.isFork) lines.push("Fork: yes");
  if (r.isArchived) lines.push("Archived: yes");
  if (r.stars) lines.push(`Stars: ${r.stars}`);
  if (r.pushedAt) lines.push(`Last pushed: ${r.pushedAt.slice(0, 10)}`);
  return lines.join("\n");
}

function renderIssue(i: GithubIssueItem): string {
  const kind = i.isPullRequest ? "Pull request" : "Issue";
  const lines = [
    `${kind} #${i.number}: ${i.title}`,
    `Repository: ${i.repoFullName}`,
    `State: ${i.state}`,
  ];
  if (i.authorLogin) lines.push(`Author: ${i.authorLogin}`);
  if (i.assigneeLogins.length) lines.push(`Assignees: ${i.assigneeLogins.join(", ")}`);
  if (i.labels.length) lines.push(`Labels: ${i.labels.join(", ")}`);
  if (i.body) lines.push(`Body: ${i.body}`);
  return lines.join("\n");
}

/** The raw provider payload, stored verbatim so a reprocess needs no re-fetch. */
const rawPayload = (item: unknown): string => JSON.stringify(item, null, 2);

function toNormalized<T>(delta: DeltaResult<T>, map: (item: T) => NormalizedItem): NormalizedDelta {
  return {
    items: delta.items.map(map),
    deletions: delta.deletions,
    nextCursor: delta.nextSyncToken ?? null,
    fullResync: delta.fullResync,
    nextConfig: delta.nextConfig,
    hasMore: delta.hasMore,
  };
}

export class GithubConnector implements Connector {
  readonly manifest = GITHUB_MANIFEST;
  readonly oauth = oauth;

  /**
   * Live search tools the agent gains per connected kind: GitHub's full-text search
   * reaches repos/issues the knowledge base may not hold yet (or whose latest state
   * has changed). The token is minted lazily inside `execute`, so an unused kind adds
   * no per-turn cost.
   */
  agentTools(ctx: AgentToolContext): ToolSet {
    const tools: ToolSet = {};
    const fail = (what: string, error: unknown) =>
      `Couldn't ${what}: ${error instanceof Error ? error.message : String(error)}`;

    if (ctx.enabledKinds.has("repos")) {
      tools.search_github_repos = tool({
        description:
          "Search the user's GitHub repositories by keywords (name, topic, language, or description). Use to find a project the user owns or contributes to, or to confirm its current details. Cite what you find.",
        inputSchema: z.object({
          query: z.string().describe("Keywords to match across the user's repositories."),
        }),
        execute: async ({ query }) => {
          try {
            const repos = await searchRepos(await ctx.getAccessToken(), query);
            if (repos.length === 0) return `No repositories matched "${query}".`;
            return repos.map(renderRepo).join("\n\n");
          } catch (error) {
            return fail("search GitHub repositories", error);
          }
        },
      });
    }

    if (ctx.enabledKinds.has("issues")) {
      tools.search_github_issues = tool({
        description:
          "Search GitHub issues and pull requests that involve the user (opened by, assigned to, or mentioning them) by keywords. Use for questions about the user's open work, reviews, or a specific ticket. Cite what you find.",
        inputSchema: z.object({
          query: z.string().describe("Keywords to match across issues and pull requests."),
        }),
        execute: async ({ query }) => {
          try {
            const issues = await searchIssues(await ctx.getAccessToken(), query);
            if (issues.length === 0) return `No issues or pull requests matched "${query}".`;
            return issues.map(renderIssue).join("\n\n");
          } catch (error) {
            return fail("search GitHub issues", error);
          }
        },
      });
    }

    return tools;
  }

  readonly promptHint =
    "GitHub tools (each present only when its kind is connected): search_github_repos finds the user's repositories by keyword; search_github_issues finds issues and pull requests that involve the user. Prefer these for the current state of the user's code projects and open work, and cite what you find.";

  async fetchDelta(
    ctx: SyncContext,
    kind: string,
    cursor: string | null,
  ): Promise<NormalizedDelta> {
    const token = ctx.accessToken;
    const viewer: GithubViewer = await fetchViewer(token);

    if (kind === "repos") {
      const delta = await fetchReposDelta(token, cursor);
      return toNormalized(delta, (r) => ({
        externalId: r.externalId,
        title: r.fullName,
        path: r.htmlUrl,
        rawContent: rawPayload(r),
        normalizedContent: renderRepo(r),
        extraction: mapRepo(r, viewer),
      }));
    }

    if (kind === "issues") {
      const delta = await fetchIssuesDelta(token, cursor);
      return toNormalized(delta, (i) => ({
        externalId: i.externalId,
        title: `${i.isPullRequest ? "PR" : "Issue"} #${i.number}: ${i.title}`,
        path: i.htmlUrl,
        rawContent: rawPayload(i),
        normalizedContent: renderIssue(i),
        extraction: mapIssue(i, viewer),
      }));
    }

    throw new Error(`GitHub connector does not support kind: ${kind}`);
  }
}

/** The shared GitHub connector instance (stateless — safe to reuse). */
export const githubConnector = new GithubConnector();
