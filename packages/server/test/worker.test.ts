import { JobQueue } from "@meos/core";
import { runtime } from "@meos/contracts";
import { Cron } from "croner";
import { describe, expect, it } from "vitest";
import { WorkerRegistry } from "../src/runtime/worker.js";
import { QueueWorker, SchedulerWorker } from "../src/runtime/workers.js";

describe("QueueWorker.health() (no server boot)", () => {
  it("reports idle with queue depth, then running while a job is in flight", async () => {
    const queue = new JobQueue(1);
    const worker = new QueueWorker("ingest", queue, "ingestion pipeline");

    // Idle queue: valid contract shape, idle status, depth in the detail.
    const idle = runtime.WorkerHealthSchema.parse(worker.health());
    expect(idle.name).toBe("ingest");
    expect(idle.status).toBe("idle");
    expect(idle.detail).toContain("0 processing");

    // Push a job that blocks until we release it, so we can observe `running`.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    queue.push(async () => {
      await gate;
    });

    const running = runtime.WorkerHealthSchema.parse(worker.health());
    expect(running.status).toBe("running");
    expect(running.detail).toContain("1 processing");

    release();
    await queue.onIdle();
    expect(worker.health().status).toBe("idle");
  });
});

describe("SchedulerWorker.health() (no server boot)", () => {
  it("reports idle with a next-run time, then stopped after stop()", () => {
    // A cron far in the future — created scheduled, never actually fires here.
    const cron = new Cron("0 0 * * *");
    const worker = new SchedulerWorker(cron);

    const health = runtime.WorkerHealthSchema.parse(worker.health());
    expect(health.name).toBe("scheduler");
    expect(health.status).toBe("idle");
    expect(health.detail).toContain("next run");

    worker.stop();
    expect(worker.health().status).toBe("stopped");
  });
});

describe("WorkerRegistry", () => {
  it("starts in registration order and stops in reverse", async () => {
    const order: string[] = [];
    const make = (name: string) => ({
      name,
      start: () => void order.push(`start:${name}`),
      stop: () => void order.push(`stop:${name}`),
      health: () => ({ name, status: "idle" as const, lastError: null, lastRunAt: null }),
    });

    const registry = new WorkerRegistry();
    registry.register(make("a"), make("b"), make("c"));
    await registry.startAll();
    await registry.stopAll();

    expect(order).toEqual([
      "start:a",
      "start:b",
      "start:c",
      "stop:c",
      "stop:b",
      "stop:a",
    ]);
    expect(registry.health().map((h) => h.name)).toEqual(["a", "b", "c"]);
  });
});
