import { afterEach, describe, expect, it, vi } from "vitest";
import { startEarly, takeEarly } from "../early-start.js";

describe("startEarly / takeEarly", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the work at once and hands its value to the awaiting step", async () => {
    const run = vi.fn(async () => "box");
    const started = startEarly(run);
    expect(run).toHaveBeenCalledTimes(1);
    await expect(takeEarly(started)).resolves.toBe("box");
  });

  it("rethrows the original error only where the result is taken", async () => {
    const refusal = new Error("This conversation cannot continue");
    const started = startEarly(async () => {
      throw refusal;
    });
    await Promise.resolve();
    await expect(takeEarly(started)).rejects.toBe(refusal);
  });

  it("captures a synchronous throw instead of throwing at start", async () => {
    const refusal = new Error("bad input");
    const started = startEarly(() => {
      throw refusal;
    });
    await expect(takeEarly(started)).rejects.toBe(refusal);
  });

  it("never reports an unhandled rejection when the turn fails before taking it", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      startEarly(async () => {
        throw new Error("abandoned");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
