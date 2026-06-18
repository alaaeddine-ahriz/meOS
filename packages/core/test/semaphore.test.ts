import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/jobs/semaphore.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Semaphore", () => {
  it("rejects a non-positive permit count", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });

  it("never lets more than `permits` holders run at once", async () => {
    const sem = new Semaphore(3);
    let live = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    // Start 10 holders that each occupy a permit until we open the gate.
    const holders = Array.from({ length: 10 }, () =>
      sem.run(async () => {
        live++;
        peak = Math.max(peak, live);
        await gate;
        live--;
      }),
    );

    await tick();
    expect(live).toBe(3); // exactly the permit count is admitted; the rest queue
    release();
    await Promise.all(holders);
    expect(peak).toBe(3);
    expect(live).toBe(0);
  });

  it("hands a freed permit to the next waiter in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const started: Array<() => void> = [];

    // Each task announces its number, then parks until individually released, so
    // only the permit (not the body) decides who runs next.
    const make = (n: number) =>
      sem.run(async () => {
        order.push(n);
        await new Promise<void>((r) => started.push(r));
      });

    const tasks = [make(1), make(2), make(3)];
    for (let i = 0; i < 3; i++) {
      await tick();
      started[i]?.(); // release the currently-running task so the next is admitted
    }
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  it("releases the permit even when the task throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    // If the failed task had leaked its permit, this would deadlock and time out.
    await expect(sem.run(async () => "recovered")).resolves.toBe("recovered");
  });
});
