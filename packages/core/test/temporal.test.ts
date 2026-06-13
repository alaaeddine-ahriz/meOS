import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import {
  ageInDays,
  DEFAULT_STALE_AFTER_DAYS,
  formatAge,
  isStale,
  isUpcoming,
  staleAfterDays,
  temporalTag,
  type TemporalClaim,
} from "../src/memory/temporal.js";

const NOW = new Date("2026-06-13T00:00:00Z");

/** Build a TemporalClaim with sensible defaults for the field under test. */
function claim(over: Partial<TemporalClaim>): TemporalClaim {
  return {
    kind: "fact",
    valid_from: null,
    valid_until: null,
    created_at: "2026-06-13T00:00:00Z",
    last_confirmed_at: "2026-06-13T00:00:00Z",
    ...over,
  };
}

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

describe("temporal policy", () => {
  it("uses a kind-aware freshness horizon", () => {
    expect(staleAfterDays("task")).toBeLessThan(staleAfterDays("fact"));
    expect(staleAfterDays("fact")).toBeLessThan(staleAfterDays("decision"));
    expect(staleAfterDays("unknown-kind")).toBe(DEFAULT_STALE_AFTER_DAYS);
    expect(staleAfterDays(undefined)).toBe(DEFAULT_STALE_AFTER_DAYS);
  });

  it("flags a claim stale only past its own kind's horizon", () => {
    // 60 days: a task is long stale, a decision is still fresh.
    const aged = { last_confirmed_at: daysAgo(60) };
    expect(isStale(claim({ kind: "task", ...aged }), NOW)).toBe(true);
    expect(isStale(claim({ kind: "decision", ...aged }), NOW)).toBe(false);
  });

  it("never marks an upcoming claim stale", () => {
    const upcoming = claim({
      kind: "task",
      valid_from: "2026-12-01",
      last_confirmed_at: daysAgo(400),
    });
    expect(isUpcoming(upcoming, NOW)).toBe(true);
    expect(isStale(upcoming, NOW)).toBe(false);
  });

  it("renders a date, a staleness marker, an upcoming marker, and a validity bound", () => {
    expect(temporalTag(claim({ created_at: "2026-06-01T00:00:00Z" }), NOW)).toBe("2026-06-01");

    const stale = temporalTag(
      claim({ kind: "task", created_at: daysAgo(200), last_confirmed_at: daysAgo(200) }),
      NOW,
    );
    expect(stale).toMatch(/stale/);

    expect(temporalTag(claim({ kind: "event", valid_from: "2026-09-01" }), NOW)).toBe(
      "from 2026-09-01 · upcoming",
    );

    expect(temporalTag(claim({ valid_from: "2026-01-01", valid_until: "2026-12-31" }), NOW)).toBe(
      "2026-01-01 · until 2026-12-31",
    );
  });

  it("formats age compactly", () => {
    expect(formatAge(0.2)).toBe("today");
    expect(formatAge(9)).toBe("9d");
    expect(formatAge(35)).toBe("5w");
    expect(formatAge(180)).toBe("6mo");
    expect(formatAge(800)).toBe("2.2y");
  });

  it("ageInDays is non-negative and zero for bad dates", () => {
    expect(ageInDays(daysAgo(10), NOW)).toBeCloseTo(10, 5);
    expect(ageInDays("not-a-date", NOW)).toBe(0);
  });
});

describe("kind-aware confidence decay", () => {
  it("decays a stale task but spares a same-age decision", () => {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const entity = store.createEntity({ type: "project", name: "Orion" });

    const task = store.insertObservation({
      entityId: entity.id,
      text: "Ship the beta this sprint.",
      kind: "task",
      confidence: 0.8,
    });
    const decision = store.insertObservation({
      entityId: entity.id,
      text: "Standardise on Postgres.",
      kind: "decision",
      confidence: 0.8,
    });
    // Both unconfirmed for 60 days: past the task horizon, well inside the decision one.
    db.prepare("UPDATE observations SET last_confirmed_at = datetime('now', '-60 days')").run();

    const decayed = store.decayStaleConfidenceByKind(
      { task: 21, decision: 365 },
      DEFAULT_STALE_AFTER_DAYS,
      0.1,
    );

    expect(decayed).toBe(1);
    expect(store.getObservation(task)!.confidence).toBeCloseTo(0.7, 5);
    expect(store.getObservation(decision)!.confidence).toBeCloseTo(0.8, 5);
    db.close();
  });
});
