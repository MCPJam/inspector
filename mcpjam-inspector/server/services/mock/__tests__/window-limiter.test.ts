import { describe, expect, it } from "vitest";
import { WindowLimiter } from "../window-limiter.js";

describe("WindowLimiter", () => {
  it("admits up to its limit in a window, then says how long to wait", () => {
    let now = 0;
    const limiter = new WindowLimiter(3, () => now);
    expect([1, 2, 3].map(() => limiter.take("k"))).toEqual([null, null, null]);
    now = 10_000;
    expect(limiter.take("k")).toBe(50_000);
  });

  it("counts each key on its own and starts a key again when its window ends", () => {
    let now = 0;
    const limiter = new WindowLimiter(1, () => now);
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("b")).toBeNull();
    expect(limiter.take("a")).not.toBeNull();
    now = 60_000;
    expect(limiter.take("a")).toBeNull();
  });
});
