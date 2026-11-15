import { describe, expect, it } from "vitest";
import { ViewActionQueue } from "../action-queue.js";

describe("view action queue", () => {
  it("keeps concurrent actions serialized through completion", async () => {
    const queue = new ViewActionQueue();
    const events: string[] = [];
    let finish: () => void = () => {
      throw new Error("not started");
    };
    let began: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const first = queue.run(async () => {
      events.push("A");
      began();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      events.push("A done");
    });
    await started;
    const second = queue.run(async () => {
      events.push("B");
    });
    expect(events).toEqual(["A"]);
    finish();
    await Promise.all([first, second]);
    expect(events).toEqual(["A", "A done", "B"]);
  });
  it("cancels queued work without letting its successor pass the active action", async () => {
    const queue = new ViewActionQueue();
    let finish: () => void = () => {};
    const first = queue.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const controller = new AbortController();
    let started = false;
    const cancelled = queue.run(
      async () => {
        throw new Error("must not run");
      },
      { signal: controller.signal },
    );
    controller.abort(new Error("cancelled"));
    await expect(cancelled).rejects.toThrow("cancelled");
    const last = queue.run(async () => {
      started = true;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    finish();
    await Promise.all([first, last]);
    expect(started).toBe(true);
  });
  it("invalidates active and queued work on replacement", async () => {
    const queue = new ViewActionQueue();
    const active = queue.run(() => new Promise<void>(() => {}));
    const queued = queue.run(async () => {
      throw new Error("must not run");
    });
    await Promise.resolve();
    queue.invalidate();
    await expect(active).rejects.toThrow("replaced");
    await expect(queued).rejects.toThrow("replaced");
  });
});
