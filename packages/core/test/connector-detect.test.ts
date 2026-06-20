import { describe, expect, it } from "vitest";
import { connectorLinkLabels, detectConnectorLinks } from "../src/connectors/detect.js";

describe("detectConnectorLinks", () => {
  it("detects Gmail and Calendar from a natural-language instruction", () => {
    const text =
      "Every hour, look through my Gmail for messages that need a reply and check my Calendar for anything coming up.";
    const links = detectConnectorLinks(text);
    const keys = links.map((l) => `${l.provider}:${l.kind}`);
    expect(keys).toContain("google:gmail");
    expect(keys).toContain("google:calendar");
    expect(keys).not.toContain("google:tasks");
    expect(keys).not.toContain("google:contacts");
  });

  it("matches curated aliases like 'inbox' and 'meetings'", () => {
    const links = detectConnectorLinks("Scan my inbox and summarise today's meetings.");
    const keys = links.map((l) => `${l.provider}:${l.kind}`);
    expect(keys).toContain("google:gmail");
    expect(keys).toContain("google:calendar");
  });

  it("is whole-word: 'mail' inside 'email' counts once, not as a bare hit", () => {
    const links = detectConnectorLinks("Triage my email.");
    const gmail = links.find((l) => l.kind === "gmail");
    expect(gmail).toBeDefined();
    // The match sample is the actual word found, lower/exact-cased as in the text.
    expect(gmail?.matches.map((m) => m.toLowerCase())).toContain("email");
  });

  it("does not link Google Tasks from a bare 'task' (stopword)", () => {
    const links = detectConnectorLinks("Do this task and report back.");
    expect(links.map((l) => l.kind)).not.toContain("tasks");
  });

  it("links Google Tasks from an explicit phrase", () => {
    const links = detectConnectorLinks("Check my to-do list and close anything done.");
    expect(links.map((l) => l.kind)).toContain("tasks");
  });

  it("returns nothing for text with no connector references", () => {
    expect(detectConnectorLinks("Refactor the parser and run the build.")).toEqual([]);
    expect(detectConnectorLinks("   ")).toEqual([]);
  });

  it("resolves links to human labels and drops unknown ones", () => {
    const labels = connectorLinkLabels([
      { provider: "google", kind: "gmail" },
      { provider: "google", kind: "calendar" },
      { provider: "nope", kind: "ghost" },
    ]);
    expect(labels.map((l) => l.label)).toEqual(["Gmail", "Calendar"]);
    expect(labels[0]?.connector).toBe("Google");
  });
});
