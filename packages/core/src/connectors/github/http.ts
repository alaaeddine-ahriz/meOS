/**
 * Thin REST client for the GitHub API (v3 / `2022-11-28`). No `@octokit` dependency —
 * raw `fetch` with a small typed surface, mirroring the Google connector's clients.
 * Each function pulls + normalizes; the mappers (`map.ts`) and the connector turn
 * these into the framework's NormalizedItem / Extraction.
 */

import type { DeltaResult } from "../types.js";

const API = "https://api.github.com";
const PER_PAGE = 100;
/**
 * Page cap per sync run. Issues paginate oldest-first with a `since` cursor, so a
 * capped run is resumed exactly via `hasMore`. Repos paginate newest-first (the API
 * has no `since` for repos), so the cap is a hard ceiling on how many of the most-
 * recently-updated repositories an initial pull indexes — generous for any human's
 * account.
 */
const MAX_PAGES = 10;

/** The account owner, used to anchor "you" in the graph and scope search. */
export interface GithubViewer {
  login: string;
  /** Display name, falling back to the login when the profile name is unset. */
  name: string;
}

/** One repository, normalized. `updatedAt` drives the incremental cursor. */
export interface GithubRepoItem {
  externalId: string;
  fullName: string;
  name: string;
  ownerLogin: string;
  ownerIsOrg: boolean;
  description: string | null;
  language: string | null;
  topics: string[];
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  stars: number;
  pushedAt: string | null;
  updatedAt: string;
  htmlUrl: string;
}

/** One issue or pull request involving the user, normalized. */
export interface GithubIssueItem {
  externalId: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  isPullRequest: boolean;
  repoFullName: string;
  repoPrivate: boolean;
  authorLogin: string | null;
  assigneeLogins: string[];
  labels: string[];
  createdAt: string | null;
  updatedAt: string;
  htmlUrl: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function githubGet(token: string, pathOrUrl: string): Promise<any> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "meOS-connector",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${pathOrUrl} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json();
}

/** Resolve the repo "owner/name" from either the list payload or the search payload. */
function repoFullNameOf(raw: any): string {
  if (raw.repository?.full_name) return String(raw.repository.full_name);
  // search/issues items carry only repository_url, e.g. ".../repos/owner/name".
  const m = /\/repos\/([^/]+\/[^/]+)$/.exec(String(raw.repository_url ?? ""));
  return m?.[1] ?? "";
}

function normalizeRepo(raw: any): GithubRepoItem {
  return {
    externalId: String(raw.node_id ?? raw.id),
    fullName: String(raw.full_name),
    name: String(raw.name),
    ownerLogin: String(raw.owner?.login ?? ""),
    ownerIsOrg: raw.owner?.type === "Organization",
    description: raw.description ?? null,
    language: raw.language ?? null,
    topics: Array.isArray(raw.topics) ? raw.topics.map(String) : [],
    isPrivate: Boolean(raw.private),
    isFork: Boolean(raw.fork),
    isArchived: Boolean(raw.archived),
    stars: Number(raw.stargazers_count ?? 0),
    pushedAt: raw.pushed_at ?? null,
    updatedAt: String(raw.updated_at),
    htmlUrl: String(raw.html_url),
  };
}

function normalizeIssue(raw: any): GithubIssueItem {
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((l: any) => (typeof l === "string" ? l : String(l?.name ?? "")))
        .filter(Boolean)
    : [];
  return {
    externalId: String(raw.node_id ?? raw.id),
    number: Number(raw.number),
    title: String(raw.title ?? ""),
    body: raw.body ?? null,
    state: String(raw.state ?? "open"),
    isPullRequest: Boolean(raw.pull_request),
    repoFullName: repoFullNameOf(raw),
    repoPrivate: Boolean(raw.repository?.private),
    authorLogin: raw.user?.login ? String(raw.user.login) : null,
    assigneeLogins: Array.isArray(raw.assignees)
      ? raw.assignees.map((a: any) => String(a?.login)).filter(Boolean)
      : [],
    labels,
    createdAt: raw.created_at ?? null,
    updatedAt: String(raw.updated_at),
    htmlUrl: String(raw.html_url),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Fetch the authenticated user (the graph's "you"). */
export async function fetchViewer(token: string): Promise<GithubViewer> {
  const me = await githubGet(token, "/user");
  return { login: String(me.login), name: me.name ? String(me.name) : String(me.login) };
}

/**
 * Repositories the user owns or collaborates on, newest-updated first. The high-
 * water cursor is the newest `updated_at` seen; an incremental run stops as soon as
 * it reaches a repo at or older than the saved cursor.
 */
export async function fetchReposDelta(
  token: string,
  cursor: string | null,
): Promise<DeltaResult<GithubRepoItem>> {
  const items: GithubRepoItem[] = [];
  let newest = cursor;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = (await githubGet(
      token,
      `/user/repos?per_page=${PER_PAGE}&page=${page}&sort=updated&direction=desc` +
        `&affiliation=owner,collaborator,organization_member`,
    )) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    let reachedCursor = false;
    for (const raw of rows) {
      const repo = normalizeRepo(raw);
      if (cursor && repo.updatedAt <= cursor) {
        reachedCursor = true;
        break;
      }
      if (!newest || repo.updatedAt > newest) newest = repo.updatedAt;
      items.push(repo);
    }
    if (reachedCursor || rows.length < PER_PAGE) break;
  }
  // The list endpoint can't report deletions (a removed repo simply vanishes), and
  // the connector is stateless, so deletions are left to the next full reconcile.
  return { items, deletions: [], nextSyncToken: newest ?? null };
}

/**
 * Issues and pull requests that involve the user (created, assigned, mentioned,
 * subscribed) across every repo, oldest-updated first so a `since` cursor walks
 * forward cleanly. `since` is inclusive, so the boundary item re-appears and is
 * skipped here; content-hash dedup in the orchestrator catches any that slip
 * through. A capped run sets `hasMore` so the orchestrator drains the backlog.
 */
export async function fetchIssuesDelta(
  token: string,
  cursor: string | null,
): Promise<DeltaResult<GithubIssueItem>> {
  const items: GithubIssueItem[] = [];
  let newest = cursor;
  let hasMore = false;
  const since = cursor ? `&since=${encodeURIComponent(cursor)}` : "";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = (await githubGet(
      token,
      `/issues?filter=all&state=all&per_page=${PER_PAGE}&page=${page}` +
        `&sort=updated&direction=asc${since}`,
    )) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const raw of rows) {
      const issue = normalizeIssue(raw);
      if (cursor && issue.updatedAt <= cursor) continue; // inclusive boundary
      if (!newest || issue.updatedAt > newest) newest = issue.updatedAt;
      items.push(issue);
    }
    if (rows.length < PER_PAGE) break;
    if (page === MAX_PAGES) hasMore = true;
  }
  return { items, deletions: [], nextSyncToken: newest ?? null, hasMore };
}

/** Search the user's repositories (agent tool). Returns the top matches. */
export async function searchRepos(token: string, query: string): Promise<GithubRepoItem[]> {
  const viewer = await fetchViewer(token);
  const q = `${query} user:${viewer.login} fork:true`;
  const body = await githubGet(
    token,
    `/search/repositories?per_page=10&q=${encodeURIComponent(q)}`,
  );
  const items = Array.isArray(body.items) ? body.items : [];
  return items.map(normalizeRepo);
}

/** Search issues + PRs that involve the user (agent tool). Returns the top matches. */
export async function searchIssues(token: string, query: string): Promise<GithubIssueItem[]> {
  const viewer = await fetchViewer(token);
  const q = `${query} involves:${viewer.login}`;
  const body = await githubGet(token, `/search/issues?per_page=10&q=${encodeURIComponent(q)}`);
  const items = Array.isArray(body.items) ? body.items : [];
  return items.map(normalizeIssue);
}
