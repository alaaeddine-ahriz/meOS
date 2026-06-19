import { describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { extractKnowledgeMapReduce } from "../src/extract/map-reduce.js";
import type { Extraction } from "../src/extract/schema.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import {
  defaultPreferences,
  enabledEntityTypes,
  enabledObservationKinds,
  ENTITY_TYPES,
  preferencesAreUnrestricted,
  preferencesForPreset,
  preferencesVersion,
  resolvePreferences,
  withPreferences,
} from "../src/knowledge/preferences.js";
import { OBSERVATION_KINDS } from "../src/knowledge/schema-doc.js";
import { StubLlmClient } from "../src/llm/index.js";

describe("knowledge preferences (#86)", () => {
  describe("defaults", () => {
    it("default = everything enabled and unrestricted", () => {
      const prefs = defaultPreferences();
      expect(prefs.preset).toBe("default");
      for (const t of ENTITY_TYPES) expect(prefs.entityTypes[t]).toBe(true);
      for (const k of OBSERVATION_KINDS) expect(prefs.observationKinds[k]).toBe(true);
      expect(preferencesAreUnrestricted(prefs)).toBe(true);
      expect(enabledEntityTypes(prefs).size).toBe(ENTITY_TYPES.length);
      expect(enabledObservationKinds(prefs).size).toBe(OBSERVATION_KINDS.length);
    });

    it("unset/null resolves to the all-enabled default", () => {
      expect(resolvePreferences(undefined)).toEqual(defaultPreferences());
      expect(resolvePreferences(null)).toEqual(defaultPreferences());
    });

    it("the default prompt lens is a no-op (prompt unchanged)", () => {
      const prompt = "SYSTEM PROMPT";
      expect(withPreferences(prompt, defaultPreferences())).toBe(prompt);
      // The default version is the stable 'all' sentinel.
      expect(preferencesVersion(defaultPreferences())).toBe("all");
    });
  });

  describe("preset application", () => {
    it("maps each preset onto the right entity types and observation kinds", () => {
      const consultant = preferencesForPreset("consultant");
      expect(consultant.preset).toBe("consultant");
      expect([...enabledEntityTypes(consultant)].sort()).toEqual(
        ["concept", "decision", "organisation", "person", "project"].sort(),
      );
      expect(consultant.entityTypes.place).toBe(false);
      expect(consultant.observationKinds.task).toBe(true);
      expect(consultant.observationKinds.risk).toBe(true);
      expect(consultant.observationKinds.open_question).toBe(true);
      expect(consultant.observationKinds.fact).toBe(true);
      // A preset is restricted (not all-enabled).
      expect(preferencesAreUnrestricted(consultant)).toBe(false);

      const personal = preferencesForPreset("personal");
      expect(personal.entityTypes.place).toBe(true);
      expect(personal.entityTypes.concept).toBe(false);
      expect(personal.observationKinds.event).toBe(true);

      const research = preferencesForPreset("research");
      expect(research.entityTypes.concept).toBe(true);
      expect(research.entityTypes.person).toBe(true);
      expect(research.observationKinds.open_question).toBe(true);
    });

    it("the lens names enabled and de-emphasised types/kinds when restricted", () => {
      const lens = withPreferences("SYS", preferencesForPreset("research"));
      expect(lens).toContain("KNOWLEDGE FOCUS");
      expect(lens).toContain("concept");
      // place is disabled in research → appears in de-emphasise line.
      expect(lens).toMatch(/De-emphasise these entity types[^\n]*place/);
    });
  });

  describe("resolvePreferences normalisation", () => {
    it("fills missing keys as enabled and marks partials as custom", () => {
      const resolved = resolvePreferences({ entityTypes: { person: false } as never });
      expect(resolved.preset).toBe("custom");
      expect(resolved.entityTypes.person).toBe(false);
      // Every other type defaults to enabled.
      expect(resolved.entityTypes.project).toBe(true);
      for (const k of OBSERVATION_KINDS) expect(resolved.observationKinds[k]).toBe(true);
    });
  });

  describe("settings-store round trip", () => {
    let db: MeosDatabase | undefined;
    it("persists and reads back through the settings table", () => {
      db = openDatabase(":memory:");
      const store = new KnowledgeStore(db);

      // Unset == default.
      expect(store.getKnowledgePreferences()).toEqual(defaultPreferences());

      const saved = store.setKnowledgePreferences(preferencesForPreset("executive"));
      expect(saved.preset).toBe("executive");

      const read = store.getKnowledgePreferences();
      expect(read).toEqual(preferencesForPreset("executive"));
      expect(read.entityTypes.place).toBe(false);
      db.close();
    });
  });

  describe("wiki-promotion filter is reversible and non-destructive", () => {
    let db: MeosDatabase | undefined;
    it("excludes a disabled type and re-includes when re-enabled", () => {
      db = openDatabase(":memory:");
      const store = new KnowledgeStore(db);

      // A page-worthy person and a page-worthy place (active, normal, sourceless obs).
      const person = store.createEntity({ name: "Ada", type: "person", summary: "x" });
      const place = store.createEntity({ name: "Berlin", type: "place", summary: "y" });
      // Each entity needs ≥3 active, non-private facts to clear the wiki
      // page-worthiness bar (gate B); a single thin mention no longer qualifies.
      store.insertObservation({
        entityId: person.id,
        text: "Ada leads Orion.",
        kind: "fact",
        confidence: 0.8,
      });
      store.insertObservation({
        entityId: person.id,
        text: "Ada is an engineer.",
        kind: "fact",
        confidence: 0.8,
      });
      store.insertObservation({
        entityId: person.id,
        text: "Ada lives in Berlin.",
        kind: "fact",
        confidence: 0.8,
      });
      store.insertObservation({
        entityId: place.id,
        text: "Berlin is a city.",
        kind: "fact",
        confidence: 0.8,
      });
      store.insertObservation({
        entityId: place.id,
        text: "Berlin is the capital of Germany.",
        kind: "fact",
        confidence: 0.8,
      });
      store.insertObservation({
        entityId: place.id,
        text: "Berlin has about 3.7 million residents.",
        kind: "fact",
        confidence: 0.8,
      });

      // Default: both warrant pages.
      let ids = store.wikiPageEntityIds();
      expect(ids.has(person.id)).toBe(true);
      expect(ids.has(place.id)).toBe(true);

      // Disable 'place' → place is filtered from promotion, person stays.
      store.setKnowledgePreferences(preferencesForPreset("research")); // research excludes place
      ids = store.wikiPageEntityIds();
      expect(ids.has(person.id)).toBe(true);
      expect(ids.has(place.id)).toBe(false);
      expect(store.entityWarrantsWikiPage(place.id)).toBe(false);

      // The place entity + its observations are NOT deleted (non-destructive).
      expect(store.getEntity(place.id)).toBeTruthy();
      expect(store.activeObservations(place.id).length).toBe(3);

      // Re-enable everything → place reappears.
      store.setKnowledgePreferences(defaultPreferences());
      ids = store.wikiPageEntityIds();
      expect(ids.has(place.id)).toBe(true);
      expect(store.entityWarrantsWikiPage(place.id)).toBe(true);
      db.close();
    });
  });

  describe("extraction cache key changes when preferences change", () => {
    let db: MeosDatabase | undefined;

    function makeStore() {
      db = openDatabase(":memory:");
      const store = new KnowledgeStore(db);
      const sourceId = store.createSource({ type: "text", title: "Doc", content: "x" });
      const revisionId = store.createSourceRevision({ sourceId });
      return { store, revisionId };
    }

    const EMPTY: Extraction = { entities: [], relationships: [], observations: [] };

    it("a prefs change invalidates the cache; default keeps the same key", async () => {
      const { store, revisionId } = makeStore();
      const llm = new StubLlmClient({ onStructured: () => EMPTY });
      const source = { title: "Doc", text: "A short document about Ada." };
      const base = {
        store,
        sourceRevisionId: revisionId,
        modelId: "m1",
      };

      // First run (default prefs): one LLM call, then cached.
      const r1 = await extractKnowledgeMapReduce(llm, source, base);
      expect(r1.llmCalls).toBe(1);

      // Same default prefs again: served from cache (0 calls).
      const r2 = await extractKnowledgeMapReduce(llm, source, {
        ...base,
        preferences: defaultPreferences(),
      });
      expect(r2.llmCalls).toBe(0);
      expect(r2.cacheHits).toBe(1);

      // Restricted prefs: cache MISS → a fresh LLM call (key changed).
      const r3 = await extractKnowledgeMapReduce(llm, source, {
        ...base,
        preferences: preferencesForPreset("research"),
      });
      expect(r3.llmCalls).toBe(1);
      expect(r3.cacheHits).toBe(0);

      // And that restricted run is now itself cached.
      const r4 = await extractKnowledgeMapReduce(llm, source, {
        ...base,
        preferences: preferencesForPreset("research"),
      });
      expect(r4.llmCalls).toBe(0);
      db!.close();
    });
  });
});
