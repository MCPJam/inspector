import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { conformanceDeadlineFields, deadlineFetch, runWithinConformanceDeadline } from "../conformance-deadline";

afterEach(() => vi.useRealTimers());
describe("conformance deadline", () => {
  it.each([1, 300, undefined])("accepts %s seconds", (runTimeoutSeconds) => {
    expect(z.object(conformanceDeadlineFields).safeParse({ runTimeoutSeconds }).success).toBe(true);
  });
  it.each([0, 301, -1, 1.5, "30"])("rejects %s seconds", (runTimeoutSeconds) => {
    expect(z.object(conformanceDeadlineFields).safeParse({ runTimeoutSeconds }).success).toBe(false);
  });
  it("uses the remaining shared budget and aborts outbound work", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = runWithinConformanceDeadline({ runTimeoutSeconds: 300, remainingRunTimeoutMs: 500 }, async (current) => {
      signal = current;
      return new Promise(() => {});
    });
    const rejected = expect(result).rejects.toThrow("Run timed out after 300 seconds");
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("counts server config resolution against the run budget", async () => {
    vi.useFakeTimers();
    const work = vi.fn();
    await expect(runWithinConformanceDeadline({ runTimeoutSeconds: 1, requestStartedAt: Date.now() - 1001 }, work)).rejects.toThrow("Run timed out");
    expect(work).not.toHaveBeenCalled();
  });
  it("clears the deadline after early completion", async () => {
    vi.useFakeTimers();
    await expect(runWithinConformanceDeadline({ runTimeoutSeconds: 1 }, async () => "done")).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects new probes after cancellation", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>();
    const guarded = deadlineFetch(fetchFn, controller.signal);
    controller.abort();
    expect(() => guarded("https://example.com")).toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
