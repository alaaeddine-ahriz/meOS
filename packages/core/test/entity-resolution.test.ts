import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { findDuplicateEntities } from "../src/knowledge/entity-resolution.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { WikiWriter } from "../src/wiki/writer.js";

function store() {
  return new KnowledgeStore(openDatabase(":memory:"));
}

describe("duplicate detection", () => {
  it("flags two people who play the same graph role (both founded StudIA)", () => {
    const s = store();
    const ahriz = s.createEntity({ type: "person", name: "Alaaeddine Ahriz" });
    const elin = s.createEntity({ type: "person", name: "Alaa El Elin" });
    const studia = s.createEntity({ type: "project", name: "StudIA" });
    s.insertObservation({ entityId: ahriz.id, text: "x" });
    s.insertObservation({ entityId: ahriz.id, text: "y" });
    s.insertObservation({ entityId: elin.id, text: "z" });
    s.upsertRelationship(ahriz.id, studia.id, "founded");
    s.upsertRelationship(elin.id, studia.id, "founded");

    const [proposal] = findDuplicateEntities(s);
    expect(proposal).toBeDefined();
    expect(new Set([proposal!.aId, proposal!.bId])).toEqual(new Set([ahriz.id, elin.id]));
    expect(proposal!.reasons.join(" ")).toMatch(/relationship/);
    // the better-established entity (more observations) is the suggested survivor
    expect(proposal!.suggestedWinnerId).toBe(ahriz.id);
  });

  it("does not flag clearly distinct entities", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const orion = s.createEntity({ type: "person", name: "Marcus" });
    s.upsertRelationship(dana.id, orion.id, "knows");
    expect(findDuplicateEntities(s)).toHaveLength(0);
  });
});

describe("mergeEntities", () => {
  it("moves observations, relationships, and aliases to the survivor", () => {
    const s = store();
    const ahriz = s.createEntity({ type: "person", name: "Alaaeddine Ahriz" });
    const elin = s.createEntity({ type: "person", name: "Alaa El Elin" });
    const studia = s.createEntity({ type: "project", name: "StudIA" });
    s.insertObservation({ entityId: ahriz.id, text: "Ahriz fact." });
    s.insertObservation({ entityId: elin.id, text: "Elin fact." });
    s.upsertRelationship(ahriz.id, studia.id, "founded");
    s.upsertRelationship(elin.id, studia.id, "founded");

    expect(s.mergeEntities(elin.id, ahriz.id)).toBe(true);

    // loser gone, its name now resolves to the survivor
    expect(s.getEntity(elin.id)).toBeUndefined();
    expect(s.findEntityByName("Alaa El Elin")!.id).toBe(ahriz.id);
    // both observations now sit on the survivor
    expect(s.activeObservations(ahriz.id).map((o) => o.text).sort()).toEqual(["Ahriz fact.", "Elin fact."]);
    // the duplicate "founded" edge collapsed to one
    expect(s.relationshipsFor(ahriz.id).filter((r) => r.label === "founded")).toHaveLength(1);
    // survivor flagged for a page rewrite, and the merge is audited
    expect(s.getEntity(ahriz.id)!.wiki_stale).toBe(1);
    expect(s.recentAudit()[0]!.op).toBe("merge_entity");
  });

  it("rejects a self-merge or unknown id", () => {
    const s = store();
    const a = s.createEntity({ type: "person", name: "A" });
    expect(s.mergeEntities(a.id, a.id)).toBe(false);
    expect(s.mergeEntities(999, a.id)).toBe(false);
  });
});

describe("wiki backfill", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meos-backfill-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("populates wiki_pages from on-disk Markdown without an LLM", async () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const dir = path.join(tmp, "person");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${dana.slug}.md`),
      `---\nentity_id: ${dana.id}\n---\n# Dana\n\nDana leads the Orion project.\n`,
    );
    const wiki = new WikiWriter(s, new StubLlmClient(), tmp, new HashEmbedder());

    expect(s.allWikiPageVectors()).toHaveLength(0);
    expect(await wiki.backfillPages()).toBe(1);

    const pages = s.allWikiPageVectors();
    expect(pages).toHaveLength(1);
    expect(pages[0]!.body).toBe("Dana leads the Orion project.");
    // idempotent: a second run backfills nothing
    expect(await wiki.backfillPages()).toBe(0);
  });

  it("synthesises a body for an empty on-disk page and writes it back", async () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana", summary: "A designer." });
    s.insertObservation({ entityId: dana.id, text: "Dana leads Orion." });
    // an empty page on disk (frontmatter + title only) — the agentic-writer gap
    const dir = path.join(tmp, "person");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${dana.slug}.md`);
    fs.writeFileSync(file, `---\nentity_id: ${dana.id}\n---\n# Dana\n\n`);
    const wiki = new WikiWriter(s, new StubLlmClient(), tmp, new HashEmbedder());

    expect(await wiki.backfillPages()).toBe(1);

    // the retrieval index now has a real body…
    const page = s.allWikiPageVectors().find((p) => p.entity_id === dana.id)!;
    expect(page.body).toContain("Dana leads Orion.");
    // …and the empty disk file was filled with the same prose
    const onDisk = fs.readFileSync(file, "utf-8");
    expect(onDisk).toContain("Dana leads Orion.");
    expect(onDisk).toContain("A designer.");
  });

  it("omits relationships from the synthesised body (the page renders them separately)", async () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana", summary: "A designer." });
    const orion = s.createEntity({ type: "project", name: "Orion" });
    s.upsertRelationship(dana.id, orion.id, "works on");
    s.insertObservation({ entityId: dana.id, text: "Dana ships fast." });
    const wiki = new WikiWriter(s, new StubLlmClient(), tmp, new HashEmbedder());

    await wiki.backfillPages();
    const body = s.allWikiPageVectors().find((p) => p.entity_id === dana.id)!.body;
    expect(body).toContain("Dana ships fast.");
    expect(body).not.toMatch(/Connections/i);
    expect(body).not.toContain("works on");
  });

  it("refreshSyntheticPages rewrites auto-generated pages but leaves agent prose alone", async () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana", summary: "A designer." });
    const marcus = s.createEntity({ type: "person", name: "Marcus", summary: "An engineer." });
    s.insertObservation({ entityId: dana.id, text: "Dana ships fast." });
    const dir = path.join(tmp, "person");
    fs.mkdirSync(dir, { recursive: true });
    // a synthetic page with the old Connections format, and an agent page with [[links]]
    fs.writeFileSync(path.join(dir, `${dana.slug}.md`), `---\nentity_id: ${dana.id}\n---\n# Dana\n\nA designer.\n\n## Connections\n- Dana works on Orion\n`);
    fs.writeFileSync(path.join(dir, `${marcus.slug}.md`), `---\nentity_id: ${marcus.id}\n---\n# Marcus\n\nMarcus collaborates with [[Dana]].\n`);
    const wiki = new WikiWriter(s, new StubLlmClient(), tmp, new HashEmbedder());

    expect(await wiki.refreshSyntheticPages()).toBe(1); // only Dana's synthetic page

    expect(fs.readFileSync(path.join(dir, `${dana.slug}.md`), "utf-8")).not.toMatch(/Connections/i);
    // the agent-authored page (with [[links]]) is untouched
    expect(fs.readFileSync(path.join(dir, `${marcus.slug}.md`), "utf-8")).toContain("[[Dana]]");
  });
});
