import { describe, expect, it } from "vitest";
import { JobQueue } from "../src/jobs/queue.js";

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
});
