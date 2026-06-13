import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { containsPII, detectSensitivity } from "../src/memory/privacy.js";

function store() {
  return new KnowledgeStore(openDatabase(":memory:"));
}

describe("PII detection", () => {
  it("classifies personal data as private, credentials as secret, prose as normal", () => {
    expect(containsPII("reach me at dana@example.com")).toBe(true);
    expect(detectSensitivity("Dana's email is dana@example.com")).toBe("private");
    expect(detectSensitivity("Dana's key is sk-ant-api03ABCDEFGHIJKLMNOPQRSTUV")).toBe("secret");
    expect(detectSensitivity("Dana leads the Orion project")).toBe("normal");
  });
});

describe("audit trail", () => {
  it("appends operations and lists them newest first", () => {
    const s = store();
    s.logAudit("supersede", "obs 1 by obs 2");
    s.logAudit("resolve_contradiction", "c1 keep_both");

    const entries = s.recentAudit();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.op).toBe("resolve_contradiction");
    expect(entries[1]!.op).toBe("supersede");
  });
});

describe("reversible supersession", () => {
  it("restores a retired observation and only acts on superseded rows", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const a = s.insertObservation({ entityId: dana.id, text: "Dana lives in Paris." });
    const b = s.insertObservation({ entityId: dana.id, text: "Dana lives in Berlin." });
    s.markSuperseded(a, b);
    expect(s.getObservation(a)!.status).toBe("superseded");

    expect(s.reverseSupersession(a)).toBe(true);
    expect(s.getObservation(a)!.status).toBe("active");
    expect(s.getObservation(a)!.superseded_by).toBeNull();
    // active rows aren't affected
    expect(s.reverseSupersession(b)).toBe(false);
  });
});
