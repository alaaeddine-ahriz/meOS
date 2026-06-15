import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { mergeExtraction } from "../src/knowledge/merge.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import {
  draftProfileFromContext,
  draftProfileFromKnowledge,
  editProfileWithInstruction,
} from "../src/profile/profile-assistant.js";
import {
  composeProfileContext,
  ensureProfileDocs,
  listProfileHistory,
  loadProfile,
  loadProfileContext,
  readProfileVersion,
  saveProfileSection,
  withProfile,
} from "../src/profile/profile-doc.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-profile-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("profile document", () => {
  it("scaffolds empty sections and keeps the profile private by default", () => {
    ensureProfileDocs(dir);
    expect(fs.existsSync(path.join(dir, "profile", "about-me.md"))).toBe(true);
    // Private by default: the dir-level .gitignore excludes everything.
    expect(fs.readFileSync(path.join(dir, "profile", ".gitignore"), "utf-8").trim()).toBe("*");
    expect(loadProfileContext(dir)).toBe("");
  });

  it("saves, reads back, and composes only non-empty sections", () => {
    saveProfileSection(dir, "about-me", "I build local-first AI tools.");
    saveProfileSection(dir, "focus-rules", "Prioritise my projects; ignore generic concepts.");

    const profile = loadProfile(dir);
    expect(profile["about-me"]).toContain("local-first");
    expect(profile["work-context"]).toBe("");

    const context = composeProfileContext(profile);
    expect(context).toContain("# About Me");
    expect(context).toContain("# Focus Rules");
    expect(context).not.toContain("# Work / Mission Context");
  });

  it("snapshots prior versions and restores them", () => {
    saveProfileSection(dir, "about-me", "First version.");
    saveProfileSection(dir, "about-me", "Second version.");

    const versions = listProfileHistory(dir, "about-me");
    expect(versions).toHaveLength(1);
    expect(readProfileVersion(dir, "about-me", versions[0]!.version)).toContain("First version");

    // Restoring is just saving the old content back — which snapshots the current.
    saveProfileSection(dir, "about-me", readProfileVersion(dir, "about-me", versions[0]!.version)!);
    expect(loadProfile(dir)["about-me"]).toContain("First version");
    expect(listProfileHistory(dir, "about-me")).toHaveLength(2);
  });

  it("rejects path traversal in a version id", () => {
    expect(readProfileVersion(dir, "about-me", "../../etc/passwd")).toBeNull();
  });

  it("withProfile is a no-op when the lens is empty and appends otherwise", () => {
    expect(withProfile("SYSTEM", "")).toBe("SYSTEM");
    const withLens = withProfile("SYSTEM", "# About Me\nI build tools.");
    expect(withLens).toContain("USER PROFILE (LENS)");
    expect(withLens).toContain("I build tools.");
  });
});

describe("profile assistant", () => {
  const proposal = {
    aboutMe: "I'm a founder building MeOS.",
    workContext: "Current mission: a local-first second brain.",
    keyProjects: "- MeOS — the second brain itself.",
    focusRules: "Prioritise MeOS work; ignore passing concepts.",
    summary: "Drafted the profile from the onboarding doc.",
  };

  it("drafts a reviewable proposal from uploaded documents", async () => {
    const llm = new StubLlmClient({
      onStructured: (req) => {
        expect(req.schemaName).toBe("profile_proposal");
        return proposal;
      },
    });
    const result = await draftProfileFromContext({
      llm,
      currentProfile: loadProfile(dir),
      documents: [
        { title: "Onboarding", text: "I'm building a local-first second brain called MeOS." },
      ],
    });
    expect(result.profile["key-projects"]).toContain("MeOS");
    expect(result.summary).toContain("Drafted");
  });

  it("drafts an initial profile from the compiled wiki", async () => {
    let sawKnowledge = false;
    const llm = new StubLlmClient({
      onStructured: (req) => {
        // The wiki summary should reach the model as grounding.
        if (
          req.messages.some(
            (m) => typeof m.content === "string" && m.content.includes("MeOS is a second brain"),
          )
        ) {
          sawKnowledge = true;
        }
        return proposal;
      },
    });
    const result = await draftProfileFromKnowledge({
      llm,
      currentProfile: loadProfile(dir),
      knowledge: "### MeOS (project)\nMeOS is a second brain the user is building.",
    });
    expect(sawKnowledge).toBe(true);
    expect(result.profile["key-projects"]).toContain("MeOS");
  });

  it("edits the profile from a natural-language instruction", async () => {
    const llm = new StubLlmClient({ onStructured: () => proposal });
    const result = await editProfileWithInstruction({
      llm,
      currentProfile: loadProfile(dir),
      instruction: "Add MeOS as my main project.",
    });
    expect(result.profile["about-me"]).toContain("MeOS");
  });
});

describe("relevance gate", () => {
  it("does not create new low-relevance entities, but keeps high/medium ones", async () => {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder(32);
    const sourceId = store.createSource({ type: "file", title: "Note", content: "x" });

    await mergeExtraction(
      store,
      embedder,
      {
        entities: [
          {
            name: "MeOS",
            type: "project",
            aliases: [],
            summary: "The project.",
            relevance: "high",
          },
          {
            name: "Kubernetes",
            type: "concept",
            aliases: [],
            summary: "Generic tech.",
            relevance: "low",
          },
        ],
        relationships: [],
        observations: [],
      },
      sourceId,
      "x",
    );

    const names = store.listEntities().map((e) => e.name);
    expect(names).toContain("MeOS");
    expect(names).not.toContain("Kubernetes");
  });
});
