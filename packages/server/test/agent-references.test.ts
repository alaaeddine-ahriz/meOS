import { describe, expect, it } from "vitest";
import {
  collectMeosReferences,
  selectAnswerReferences,
  type AgentPage,
  type AgentSource,
} from "../src/coding-agent-command.js";

// A wiki_search result (proxies /api/search): entities + SourceRef documents.
const SEARCH = JSON.stringify({
  entities: [{ name: "Online Communities", slug: "online-communities", type: "concept" }],
  sources: [
    {
      id: 1,
      title: "W2 - Kraut10-Contribution-current",
      path: "/x/W2 - Kraut10.pdf",
      type: "watch",
    },
    {
      id: 2,
      title: "W3 - Kraut10-Contribution-current",
      path: "/x/W3 - Kraut10.pdf",
      type: "watch",
    },
    { id: 3, title: "W2 - Resnick10-Intro-current", path: "/x/Resnick10.pdf", type: "watch" },
    {
      id: 4,
      title: "W3 - Seering_etal_2018_Social_Identity",
      path: "/x/Seering.pdf",
      type: "watch",
    },
    { id: 5, title: "A “Nutrition Label” for Privacy", path: "/x/nutrition.pdf", type: "watch" },
    {
      id: 6,
      title: "Core Courses Track Selection (French Track)",
      path: "/x/track.pdf",
      type: "watch",
    },
  ],
});

// A wiki_context result (proxies /api/wiki/agent/context/:slug): one opened page,
// sources carrying `link` instead of `path`.
const CONTEXT = JSON.stringify({
  entity: { id: 9, name: "Online Communities", slug: "online-communities", type: "concept" },
  sources: [
    { id: 7, title: "Building Successful Online Communities", link: "/x/book.pdf", type: "watch" },
  ],
});

function collect(): { sources: Map<number, AgentSource>; pages: Map<string, AgentPage> } {
  const sources = new Map<number, AgentSource>();
  const pages = new Map<string, AgentPage>();
  collectMeosReferences("mcp__meos__wiki_search", SEARCH, sources, pages);
  collectMeosReferences("mcp__meos__wiki_context", CONTEXT, sources, pages);
  return { sources, pages };
}

describe("collectMeosReferences", () => {
  it("takes pages only from wiki_context, sources from both", () => {
    const { sources, pages } = collect();
    // The page is the one the agent OPENED (context) — search entities are skipped.
    expect([...pages.values()]).toEqual([
      { name: "Online Communities", slug: "online-communities", type: "concept" },
    ]);
    // Documents accumulate from search + context (context's `link` maps to `path`).
    expect([...sources.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(sources.get(7)?.path).toBe("/x/book.pdf");
  });

  it("ignores non-meos tools and unparseable output", () => {
    const sources = new Map<number, AgentSource>();
    const pages = new Map<string, AgentPage>();
    collectMeosReferences("Bash", SEARCH, sources, pages);
    collectMeosReferences("mcp__meos__wiki_search", "not json", sources, pages);
    expect(sources.size).toBe(0);
    expect(pages.size).toBe(0);
  });
});

describe("selectAnswerReferences", () => {
  it("keeps only documents the answer cites, deduping the same reading across weeks", () => {
    const { sources, pages } = collect();
    const answer =
      "Your readings (Kraut & Resnick, Building Successful Online Communities; " +
      "Seering et al. 2018) frame online communities as spaces for social support.";
    const result = selectAnswerReferences(answer, sources, pages);

    const titles = result.sources.map((s) => s.title);
    // Cited authors kept; the two Kraut copies (W2/W3) collapse to one.
    expect(titles).toContain("W2 - Kraut10-Contribution-current");
    expect(titles).not.toContain("W3 - Kraut10-Contribution-current");
    expect(titles).toContain("W2 - Resnick10-Intro-current");
    expect(titles).toContain("W3 - Seering_etal_2018_Social_Identity");
    expect(titles).toContain("Building Successful Online Communities");
    // Retrieval noise the answer never names is dropped.
    expect(titles).not.toContain("A “Nutrition Label” for Privacy");
    expect(titles.some((t) => t.includes("French Track"))).toBe(false);
    // The opened page is kept (answer names it).
    expect(result.pages.map((p) => p.slug)).toEqual(["online-communities"]);
  });

  it("keeps no documents when the answer cites none (only the page it names)", () => {
    const { sources, pages } = collect();
    const answer =
      "Online communities provide information sharing and social support, producing " +
      "public goods, grounded in your Intro to Social Computing readings.";
    const result = selectAnswerReferences(answer, sources, pages);
    // No author/title lead-word is named — a shared topic word like "social" is NOT
    // treated as a citation, so no documents survive.
    expect(result.sources).toEqual([]);
    // The page is still kept (its name appears in the answer).
    expect(result.pages.map((p) => p.slug)).toEqual(["online-communities"]);
  });

  it("matches a page by its [[wikilink]] even when the name isn't in prose verbatim", () => {
    const sources = new Map<number, AgentSource>();
    const pages = new Map<string, AgentPage>([
      ["haiyi-zhu", { name: "Haiyi Zhu", slug: "haiyi-zhu", type: "person" }],
      ["unused", { name: "Some Other Person", slug: "unused", type: "person" }],
    ]);
    const result = selectAnswerReferences("Your collaborator is [[Haiyi Zhu]].", sources, pages);
    expect(result.pages.map((p) => p.slug)).toEqual(["haiyi-zhu"]);
  });
});
