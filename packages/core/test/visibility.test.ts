import { describe, expect, it } from "vitest";
import { buildContextPack } from "../src/chat/retrieval.js";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

async function setup() {
  const db = openDatabase(":memory:");
  return { store: new KnowledgeStore(db), embedder: new HashEmbedder() };
}

describe("source visibility — per-type defaults", () => {
  it("applies fully-permissive defaults to local files", async () => {
    const { store } = await setup();
    const id = store.createSource({ type: "file", title: "Notes", content: "..." });
    expect(store.sourceVisibility(id)).toEqual({
      searchable: true,
      answerable: true,
      wikiEligible: true,
      syncable: true,
      exportable: true,
      activityVisible: true,
    });
  });

  it("keeps connector sources off sync/export by default", async () => {
    const { store } = await setup();
    for (const type of ["google:contacts", "google:calendar", "google:gmail"]) {
      const id = store.createSource({ type, title: type, content: "..." });
      const v = store.sourceVisibility(id);
      // Connector data is searchable/answerable but never leaves the device.
      expect(v.searchable).toBe(true);
      expect(v.answerable).toBe(true);
      expect(v.syncable).toBe(false);
      expect(v.exportable).toBe(false);
    }
  });

  it("keeps profile-context docs out of the wiki and out of sync/export", async () => {
    const { store } = await setup();
    const id = store.createSource({ type: "profile_context", title: "Profile", content: "..." });
    const v = store.sourceVisibility(id);
    expect(v.searchable).toBe(true);
    expect(v.answerable).toBe(true);
    expect(v.wikiEligible).toBe(false);
    expect(v.syncable).toBe(false);
    expect(v.exportable).toBe(false);
  });

  it("lets a caller override the defaults at creation", async () => {
    const { store } = await setup();
    const id = store.createSource({
      type: "google:gmail",
      title: "Mail",
      content: "...",
      visibility: { exportable: true },
    });
    expect(store.sourceVisibility(id).exportable).toBe(true);
  });
});

describe("source visibility — retrieval enforcement", () => {
  it("excludes a non-searchable source from chat retrieval", async () => {
    const { store, embedder } = await setup();
    const dana = store.createEntity({ type: "person", name: "Dana" });

    // A normal source that should be retrievable...
    const open = store.createSource({ type: "text", title: "Open Notes", content: "Dana lives in Berlin." });
    const openChunks = await embedder.embed(["Dana lives in Berlin."]);
    store.addChunks(open, [{ text: "Dana lives in Berlin.", embedding: openChunks[0]! }]);
    const [obsVec] = await embedder.embed(["Dana lives in Berlin."]);
    store.insertObservation({ entityId: dana.id, text: "Dana lives in Berlin.", sourceId: open, embedding: obsVec!, confidence: 0.8 });

    // ...and a hidden source whose content must never reach retrieval.
    const secret = store.createSource({
      type: "text",
      title: "Secret Dossier",
      content: "Dana secretly lives in Reykjavik.",
      visibility: { searchable: false },
    });
    const secretChunks = await embedder.embed(["Dana secretly lives in Reykjavik."]);
    store.addChunks(secret, [{ text: "Dana secretly lives in Reykjavik.", embedding: secretChunks[0]! }]);

    const pack = await buildContextPack(store, embedder, "where does Dana live?");

    expect(pack.text).toContain("Berlin");
    expect(pack.text).not.toContain("Reykjavik");
    expect(pack.sources.map((s) => s.title)).toContain("Open Notes");
    expect(pack.sources.map((s) => s.title)).not.toContain("Secret Dossier");
  });

  it("never cites a non-answerable source even when it informs context", async () => {
    const { store, embedder } = await setup();
    const dana = store.createEntity({ type: "person", name: "Dana" });
    // Searchable (so it can shape context) but not answerable (never a citation).
    const src = store.createSource({
      type: "text",
      title: "Background",
      content: "Dana joined in 2021.",
      visibility: { answerable: false },
    });
    const [vec] = await embedder.embed(["Dana joined in 2021."]);
    store.insertObservation({ entityId: dana.id, text: "Dana joined in 2021.", sourceId: src, embedding: vec!, confidence: 0.8 });

    const pack = await buildContextPack(store, embedder, "when did Dana join?");
    expect(pack.sources.map((s) => s.title)).not.toContain("Background");
  });
});

describe("source visibility — wiki & export enforcement", () => {
  it("keeps a non-wiki-eligible source's claim out of visibleObservations (wiki input)", async () => {
    const { store } = await setup();
    const dana = store.createEntity({ type: "person", name: "Dana" });

    const fileSrc = store.createSource({ type: "file", title: "Resume", content: "..." });
    store.insertObservation({ entityId: dana.id, text: "Dana is a designer.", sourceId: fileSrc });

    const profileSrc = store.createSource({ type: "profile_context", title: "Profile", content: "..." });
    store.insertObservation({ entityId: dana.id, text: "Dana is my manager.", sourceId: profileSrc });

    const visible = store.visibleObservations(dana.id).map((o) => o.text);
    expect(visible).toContain("Dana is a designer.");
    // profile_context is wiki_eligible=false, so it must not feed the wiki page.
    expect(visible).not.toContain("Dana is my manager.");
  });

  it("keeps a non-exportable source out of the exported recent-sources list (digest)", async () => {
    const { store } = await setup();
    store.createSource({ type: "file", title: "Quarter Plan", content: "..." });
    store.createSource({ type: "google:gmail", title: "Private Email Thread", content: "..." });

    const exported = store.recentSources("0000-00-00", "export").map((s) => s.title);
    expect(exported).toContain("Quarter Plan");
    // The connector source is exportable=false — it must not appear in synced markdown.
    expect(exported).not.toContain("Private Email Thread");

    // The unscoped list still returns everything (internal use).
    const all = store.recentSources("0000-00-00").map((s) => s.title);
    expect(all).toContain("Private Email Thread");
  });

  it("excludes non-activity-visible sources from the activity feed", async () => {
    const { store } = await setup();
    const shown = store.createSource({ type: "file", title: "Visible", content: "..." });
    store.setSourceVisibility(shown, { activityVisible: true });
    const hidden = store.createSource({ type: "file", title: "Hidden", content: "..." });
    store.setSourceVisibility(hidden, { activityVisible: false });

    const feed = store.recentSources("0000-00-00", "activity").map((s) => s.title);
    expect(feed).toContain("Visible");
    expect(feed).not.toContain("Hidden");
  });
});
