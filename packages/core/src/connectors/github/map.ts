/**
 * Deterministic GitHub → {@link Extraction} mappers. A repository becomes a project
 * entity with its facts; an issue/PR becomes a dated work item attributed to its
 * author and tied to its repository. No LLM, no network — just a faithful structural
 * mapping, so the derived semantic stage has clean, typed input to merge.
 */

import type { Extraction } from "../../extract/schema.js";
import type { GithubIssueItem, GithubRepoItem, GithubViewer } from "./http.js";
import { observation, personEntity } from "../map/helpers.js";

type EntityInput = Extraction["entities"][number];

/** A project (repository) entity, kept high-relevance so it survives the merge gate. */
function projectEntity(name: string, summary = ""): EntityInput {
  return { name, type: "project", aliases: [], summary, relevance: "high" };
}

const dateOnly = (iso: string | null | undefined): string | null => (iso ? iso.slice(0, 10) : null);

/**
 * Map a repository to a project entity with language / topic / description facts, an
 * owner edge, and a "you work on it" edge. Facts inherit the repo's privacy: private
 * repos produce `private` observations so they stay searchable but off the synced
 * wiki, exactly like private contact facts.
 */
export function mapRepo(repo: GithubRepoItem, viewer: GithubViewer): Extraction {
  const name = repo.fullName;
  const sensitivity = repo.isPrivate ? "private" : "normal";
  const entities: EntityInput[] = [projectEntity(name, repo.description ?? "")];
  const relationships: Extraction["relationships"] = [];
  const observations: Extraction["observations"] = [];

  // The owner is a real actor in the graph — but not when it's you (you're anchored
  // by the "works on" edge below, and a self-as-person entity would be noise).
  if (repo.ownerLogin && repo.ownerLogin !== viewer.login) {
    entities.push(
      repo.ownerIsOrg
        ? {
            name: repo.ownerLogin,
            type: "organisation",
            aliases: [],
            summary: "",
            relevance: "high",
          }
        : personEntity({ name: repo.ownerLogin }),
    );
    relationships.push({ from: repo.ownerLogin, to: name, label: "owns" });
  }
  // You appear in your repo list because you own or contribute to it.
  relationships.push({ from: viewer.name, to: name, label: "works on" });

  if (repo.description) {
    observations.push(
      observation({
        entity: name,
        claim: `${name}: ${repo.description}`,
        kind: "fact",
        confidence: 0.9,
        sensitivity,
      }),
    );
  }
  if (repo.language) {
    observations.push(
      observation({
        entity: name,
        claim: `${name} is primarily written in ${repo.language}.`,
        kind: "fact",
        confidence: 0.9,
        sensitivity,
      }),
    );
  }
  if (repo.topics.length) {
    observations.push(
      observation({
        entity: name,
        claim: `${name} is tagged with: ${repo.topics.join(", ")}.`,
        kind: "fact",
        confidence: 0.85,
        sensitivity,
      }),
    );
  }
  observations.push(
    observation({
      entity: name,
      claim: `${name} is a ${repo.isPrivate ? "private" : "public"}${repo.isFork ? " forked" : ""}${
        repo.isArchived ? " archived" : ""
      } GitHub repository.`,
      kind: "fact",
      confidence: 0.95,
      sensitivity,
      validFrom: dateOnly(repo.pushedAt),
    }),
  );

  return { entities, relationships, observations };
}

/**
 * Map an issue or pull request to a dated work item on its repository, attributed to
 * its author and assignees. Open items are `task` observations (a thing to do); closed
 * ones are `fact`s of record. Items from private repos are tagged `private`.
 */
export function mapIssue(issue: GithubIssueItem, viewer: GithubViewer): Extraction {
  const repo = issue.repoFullName || "an unknown repository";
  const kindLabel = issue.isPullRequest ? "PR" : "Issue";
  const ref = `${kindLabel} #${issue.number}`;
  const sensitivity = issue.repoPrivate ? "private" : "normal";
  const validFrom = dateOnly(issue.createdAt);

  const entities: EntityInput[] = [projectEntity(repo)];
  const relationships: Extraction["relationships"] = [
    { from: viewer.name, to: repo, label: "works on" },
  ];
  const observations: Extraction["observations"] = [];

  const people = new Set<string>();
  if (issue.authorLogin && issue.authorLogin !== viewer.login) people.add(issue.authorLogin);
  for (const a of issue.assigneeLogins) if (a !== viewer.login) people.add(a);
  for (const login of people) {
    entities.push(personEntity({ name: login }));
    relationships.push({ from: login, to: repo, label: "works on" });
  }

  observations.push(
    observation({
      entity: repo,
      claim: `${ref} "${issue.title}" in ${repo} is ${issue.state}${
        issue.isPullRequest ? " (pull request)" : ""
      }.`,
      kind: issue.state === "open" ? "task" : "fact",
      confidence: 0.9,
      sensitivity,
      validFrom,
    }),
  );
  if (issue.authorLogin && issue.authorLogin !== viewer.login) {
    observations.push(
      observation({
        entity: issue.authorLogin,
        claim: `${issue.authorLogin} opened ${kindLabel.toLowerCase()} "${issue.title}" in ${repo}.`,
        kind: "event",
        confidence: 0.85,
        sensitivity,
        validFrom,
      }),
    );
  }

  return { entities, relationships, observations };
}
