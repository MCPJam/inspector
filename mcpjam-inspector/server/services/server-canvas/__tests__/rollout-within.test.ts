import { afterEach, describe, expect, it, vi } from "vitest";
import { rolloutWithin } from "../rollout-within.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("rolloutWithin", () => {
  it("takes an answer that comes in time, and reads a late or failed one as off", async () => {
    vi.useFakeTimers();
    await expect(rolloutWithin(Promise.resolve(true), 100)).resolves.toBe(true);
    await expect(
      rolloutWithin(Promise.reject(new Error("posthog down")), 100),
    ).resolves.toBe(false);
    const late = rolloutWithin(new Promise<boolean>(() => undefined), 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(late).resolves.toBe(false);
  });
});
