import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubLlmClient } from "../src/llm/stub.js";
import {
  draftProfileFromContext,
  draftProfileFromKnowledge,
  editProfileWithInstruction,
} from "../src/profile/profile-assistant.js";
import type { Profile } from "../src/profile/profile-doc.js";
import { makeAgentClient } from "./fixtures/index.js";

/**
 * CONTRACT (offline, ungated) — the profile assistant (`proposeProfile`,
 * `completeStructured`, schema `profile_proposal`, assistant group) returns a
 * correct proposal through the routed client on BOTH backends. All THREE entry
 * points (draft-from-context, draft-from-knowledge, edit-with-instruction) funnel
 * through `proposeProfile`, so the agent backend is exercised through each of them.
 * A throwing fallback means a pass = the agent produced schema-valid JSON.
 */

const emptyProfile: Profile = {
  "about-me": "",
  "work-context": "",
  "key-projects": "",
  "focus-rules": "",
};

const proposal = {
  aboutMe: "I build MeOS, a local-first second brain.",
  workContext: "Solo founder focused on personal knowledge tooling.",
  keyProjects: "- MeOS — the second brain itself.",
  focusRules: "Prioritise MeOS work; ignore passing concepts.",
  summary: "Drafted the profile from the provided context.",
};

function assertProposal(result: { profile: Profile; summary: string }): void {
  expect(result.profile["key-projects"]).toContain("MeOS");
  expect(result.profile["about-me"]).toContain("MeOS");
  expect(result.summary.length).toBeGreaterThan(0);
}

describe("profile assistant — backend parity (contract)", () => {
  it("api backend: drafts a proposal through a conforming structured client", async () => {
    const api = new StubLlmClient({
      onStructured: (request) => {
        expect(request.schemaName).toBe("profile_proposal");
        return proposal;
      },
    });

    const result = await draftProfileFromContext({
      llm: api,
      currentProfile: emptyProfile,
      documents: [{ title: "Onboarding", text: "I'm building a local-first second brain, MeOS." }],
    });

    assertProposal(result);
  });

  describe("agent backend (CodingAgentLlmClient, no CLI)", () => {
    let scratchDir: string;
    beforeEach(() => {
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-parity-agent-"));
    });
    afterEach(() => {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    // All three entry points share proposeProfile → completeStructured; the scripted
    // agent returns the proposal as raw JSON for the profile_proposal schema.
    const agentFor = () => makeAgentClient(scratchDir, () => JSON.stringify(proposal));

    it("draft-from-context through the real completeStructured path (no fallback)", async () => {
      const result = await draftProfileFromContext({
        llm: agentFor(),
        currentProfile: emptyProfile,
        documents: [
          { title: "Onboarding", text: "I'm building MeOS, a local-first second brain." },
        ],
      });
      assertProposal(result);
    });

    it("draft-from-knowledge through the real completeStructured path (no fallback)", async () => {
      const result = await draftProfileFromKnowledge({
        llm: agentFor(),
        currentProfile: emptyProfile,
        knowledge: "### MeOS (project)\nMeOS is a second brain the user is building.",
      });
      assertProposal(result);
    });

    it("edit-with-instruction through the real completeStructured path (no fallback)", async () => {
      const result = await editProfileWithInstruction({
        llm: agentFor(),
        currentProfile: emptyProfile,
        instruction: "Add MeOS as my main project.",
      });
      assertProposal(result);
    });
  });
});
