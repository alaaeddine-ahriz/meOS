import { describe, expect, it, vi } from "vitest";
import { MeosEvents } from "../src/events.js";

describe("MeosEvents", () => {
  it("delivers a typed payload to every subscriber", async () => {
    const bus = new MeosEvents();
    const seen: number[] = [];
    bus.on("onContradiction", ({ contradictionId }) => void seen.push(contradictionId));
    bus.on("onContradiction", ({ entityId }) => void seen.push(entityId));

    await bus.emit("onContradiction", { contradictionId: 7, entityId: 3 });

    expect(seen.sort()).toEqual([3, 7]);
  });

  it("isolates a throwing handler so the others still run", async () => {
    const onError = vi.fn();
    const bus = new MeosEvents(onError);
    const ran = vi.fn();
    bus.on("onSchedule", () => {
      throw new Error("boom");
    });
    bus.on("onSchedule", ran);

    await bus.emit("onSchedule", { reason: "manual" });

    expect(ran).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("stops delivering after unsubscribe", async () => {
    const bus = new MeosEvents();
    const handler = vi.fn();
    const off = bus.on("onSessionEnd", handler);
    off();

    await bus.emit("onSessionEnd", { conversationId: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it("awaits async handlers before resolving emit", async () => {
    const bus = new MeosEvents();
    let done = false;
    bus.on("onNewSource", async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });

    await bus.emit("onNewSource", { sourceId: 1, merge: { affectedEntityIds: [], staleEntityIds: [], newObservationIds: [], reinforcedObservationIds: [] } });

    expect(done).toBe(true);
  });
});
