import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { useProjectClientInitialization } from "../use-project-client-initialization";

const mocks = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: mocks.report }));

function renderInit(
  run: () => Promise<unknown>,
  onSuccess?: (result: unknown) => void,
) {
  return renderHook(() =>
    useProjectClientInitialization({
      projectId: "p1",
      intent: "default",
      needed: true,
      run,
      onSuccess,
    }),
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useProjectClientInitialization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports an onSuccess that throws instead of leaving it unhandled", async () => {
    // Node raises `unhandledRejection` from a real tick, which fake timers hold.
    vi.useRealTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const thrown = new Error("could not save the selection");
    try {
      renderInit(
        () => Promise.resolve({ hostId: "h1" }),
        () => {
          throw thrown;
        },
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(mocks.report).toHaveBeenCalledWith(thrown, expect.any(Object));
    expect(unhandled).not.toHaveBeenCalled();
  });

  it.each([
    ["an infinite retryAfterMs", Infinity, 1_000],
    ["a NaN retryAfterMs", NaN, 1_000],
    ["a retryAfterMs past the timer range", 1e12, 60_000],
  ])("waits a bounded delay for %s", async (_case, retryAfterMs, delayMs) => {
    const run = vi
      .fn()
      .mockRejectedValue(
        new ConvexError({ code: "rate_limited", retryAfterMs }),
      );
    renderInit(run);
    await advance(0);
    expect(run).toHaveBeenCalledTimes(1);

    await advance(delayMs - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
