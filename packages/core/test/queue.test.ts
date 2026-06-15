import { describe, expect, it } from "vitest";
import { JobPriority, JobQueue } from "../src/jobs/queue.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("JobQueue", () => {
  it("runs at most `concurrency` jobs at once", async () => {
    const queue = new JobQueue(2);
    let running = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];

    for (let i = 0; i < 5; i++) {
      queue.push(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => resolvers.push(resolve));
        running--;
      });
    }

    await tick();
    expect(running).toBe(2);
    while (resolvers.length > 0) {
      resolvers.shift()!();
      await tick();
    }
    await queue.onIdle();
    expect(peak).toBe(2);
    expect(queue.pending).toBe(0);
  });

  it("keeps going after a job fails and still reaches idle", async () => {
    const queue = new JobQueue(1);
    const ran: number[] = [];
    queue.push(async () => {
      throw new Error("boom");
    });
    queue.push(async () => {
      ran.push(2);
    });
    await queue.onIdle();
    expect(ran).toEqual([2]);
  });

  it("onIdle resolves immediately when nothing is queued", async () => {
    await new JobQueue().onIdle();
  });

  it("runs exclusive jobs alone", async () => {
    const queue = new JobQueue(3);
    let running = 0;
    const overlapsDuringExclusive: number[] = [];
    const job = (exclusive = false) =>
      queue.push(
        async () => {
          running++;
          if (exclusive) overlapsDuringExclusive.push(running);
          await tick();
          running--;
        },
        { exclusive },
      );

    job();
    job();
    job(true);
    job();
    job();
    await queue.onIdle();
    // The exclusive job saw only itself running.
    expect(overlapsDuringExclusive).toEqual([1]);
  });

  it("drains higher-priority work first, strictly FIFO within a class (#18)", async () => {
    // Concurrency 1 so the drain order is exactly the dequeue order.
    const queue = new JobQueue(1);
    const order: string[] = [];
    const run = (label: string, priority: number) =>
      queue.push(
        async () => {
          order.push(label);
          await tick();
        },
        { priority },
      );

    // Enqueue out of priority order: a low-priority bulk import arrives first,
    // then a high-priority user note, then more bulk and a mid connector sync.
    run("bulk-1", JobPriority.NIGHTLY);
    run("bulk-2", JobPriority.NIGHTLY);
    run("user-note", JobPriority.USER);
    run("watch-1", JobPriority.WATCH);
    run("connector", JobPriority.CONNECTOR);
    run("user-note-2", JobPriority.USER);

    await queue.onIdle();
    // The first job had already started (it was alone when pushed); everything
    // queued behind it drains by (priority desc, FIFO within a class).
    expect(order).toEqual(["bulk-1", "user-note", "user-note-2", "watch-1", "connector", "bulk-2"]);
  });

  it("a user note jumps ahead of an already-queued bulk import (#18)", async () => {
    const queue = new JobQueue(1);
    const order: string[] = [];
    const block = () => new Promise<void>((resolve) => resolvers.push(resolve));
    const resolvers: Array<() => void> = [];

    // First job holds the single slot so the rest queue behind it deterministically.
    queue.push(async () => {
      order.push("gate");
      await block();
    });
    queue.push(
      async () => {
        order.push("bulk");
      },
      { priority: JobPriority.NIGHTLY },
    );
    queue.push(
      async () => {
        order.push("note");
      },
      { priority: JobPriority.USER },
    );

    await tick();
    resolvers.shift()!(); // release the gate
    await queue.onIdle();
    // The note, though enqueued last, drains before the earlier bulk job.
    expect(order).toEqual(["gate", "note", "bulk"]);
  });
});
