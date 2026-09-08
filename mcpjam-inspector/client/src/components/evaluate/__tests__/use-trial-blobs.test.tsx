import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  clearTrialBlobCache,
  useTrialBlobs,
} from "../case-scorecard/use-trial-blobs";
import type { EvalIteration } from "@/components/evals/types";

const action = vi.fn();
vi.mock("convex/react", () => ({
  useAction: () => (args: { iterationId: string }) => action(args),
}));

const iteration = (id: string, n: number): EvalIteration =>
  ({
    _id: id,
    iterationNumber: n,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    createdBy: "u",
    createdAt: 1,
    updatedAt: 2,
    blob: "b",
  }) as EvalIteration;

beforeEach(() => {
  action.mockReset();
  action.mockImplementation(async ({ iterationId }) => ({ id: iterationId }));
  clearTrialBlobCache();
});

describe("useTrialBlobs", () => {
  it("reads every eligible trial and reports each result", async () => {
    const { result } = renderHook(() =>
      useTrialBlobs({
        iterations: [iteration("a", 1), iteration("b", 2)],
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.reads.get("a")).toMatchObject({ state: "ok" });
    expect(result.current.reads.get("b")).toMatchObject({ state: "ok" });
  });

  it("caps the number of reads and says how many it skipped", async () => {
    const many = Array.from({ length: 8 }, (_, i) => iteration(`i${i}`, i + 1));
    const { result } = renderHook(() =>
      useTrialBlobs({ iterations: many, enabled: true }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(action).toHaveBeenCalledTimes(5);
    expect(result.current.capped).toBe(3);
    expect(result.current.reads.get("i7")).toEqual({ state: "skipped" });
  });

  it("does not let one failure lose the others", async () => {
    action.mockImplementation(async ({ iterationId }) => {
      if (iterationId === "b") throw new Error("nope");
      return { id: iterationId };
    });
    const { result } = renderHook(() =>
      useTrialBlobs({
        iterations: [iteration("a", 1), iteration("b", 2)],
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.reads.get("a")).toMatchObject({ state: "ok" });
    expect(result.current.reads.get("b")).toMatchObject({
      state: "failed",
      error: "nope",
    });
  });

  it("skips a trial with no trace to resolve", async () => {
    const bare = { ...iteration("a", 1), blob: undefined } as EvalIteration;
    const { result } = renderHook(() =>
      useTrialBlobs({ iterations: [bare], enabled: true }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(action).not.toHaveBeenCalled();
  });

  it("serves a second mount from the cache", async () => {
    const iterations = [iteration("a", 1)];
    const first = renderHook(() =>
      useTrialBlobs({ iterations, enabled: true }),
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();
    const second = renderHook(() =>
      useTrialBlobs({ iterations, enabled: true }),
    );
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    // A terminal iteration's blob never changes, so the second open is free.
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure instead of caching it", async () => {
    action.mockImplementationOnce(async () => {
      throw new Error("first");
    });
    const iterations = [iteration("a", 1)];
    const first = renderHook(() =>
      useTrialBlobs({ iterations, enabled: true }),
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();
    const second = renderHook(() =>
      useTrialBlobs({ iterations, enabled: true }),
    );
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.reads.get("a")).toMatchObject({ state: "ok" });
  });

  it("never refetches the trial the page already loaded", async () => {
    const { result } = renderHook(() =>
      useTrialBlobs({
        iterations: [iteration("a", 1)],
        seed: { iterationId: "a", blob: { seeded: true } as never },
        enabled: true,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(action).not.toHaveBeenCalled();
    expect(result.current.reads.get("a")).toMatchObject({
      state: "ok",
      blob: { seeded: true },
    });
  });

  it("reads nothing while disabled", async () => {
    renderHook(() =>
      useTrialBlobs({ iterations: [iteration("a", 1)], enabled: false }),
    );
    expect(action).not.toHaveBeenCalled();
  });
});
