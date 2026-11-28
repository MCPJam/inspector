import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { pollUntil } from "../page-driver";

describe("pollUntil", () => {
  it("leaves no abort listener on the caller's signal once the wait ends", async () => {
    const controller = new AbortController();
    let polls = 0;
    await pollUntil(async () => ++polls >= 4, {
      timeoutMs: 5_000,
      intervalMs: 1,
      signal: controller.signal,
      what: "the fourth poll",
    });
    expect(polls).toBe(4);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("still cuts a sleep short when the signal aborts", async () => {
    const controller = new AbortController();
    let polls = 0;
    const waiting = pollUntil(
      async () => {
        polls += 1;
        return false;
      },
      {
        timeoutMs: 60_000,
        intervalMs: 60_000,
        signal: controller.signal,
        what: "nothing",
      },
    );
    // A macrotask later, the first poll has failed and the sleep has begun.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(polls).toBe(1);
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
