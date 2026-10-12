import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEvalInsightsEnvelope } from "../use-eval-insights-envelope";

const mocks = vi.hoisted(() => ({ query: vi.fn(), action: vi.fn() }));
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mocks.query(...args),
  useAction: () => mocks.action,
}));
const envelope = { findings: [] };
beforeEach(() => {
  mocks.query.mockReset().mockReturnValue({ _id: "run-1", version: 1 });
  mocks.action.mockReset().mockResolvedValue(envelope);
});

describe("file-backed eval insights", () => {
  it("waits for metadata and refreshes the action when subscribed metadata changes", async () => {
    const { result, rerender } = renderHook(() =>
      useEvalInsightsEnvelope("run-1"),
    );
    await waitFor(() => expect(result.current).toEqual(envelope));
    expect(mocks.action).toHaveBeenCalledWith({ suiteRunId: "run-1" });
    mocks.query.mockReturnValue({ _id: "run-1", version: 2 });
    mocks.action.mockResolvedValue({ findings: [{ title: "new" }] });
    rerender();
    await waitFor(() =>
      expect(result.current).toEqual({ findings: [{ title: "new" }] }),
    );
  });
  it("skips absent ids and unknown metadata", () => {
    const { result } = renderHook(() => useEvalInsightsEnvelope(null));
    expect(result.current).toBeUndefined();
    expect(mocks.action).not.toHaveBeenCalled();
    mocks.query.mockReturnValue(undefined);
    renderHook(() => useEvalInsightsEnvelope("run-1"));
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("ignores a completed read after switching runs", async () => {
    let resolve: (value: unknown) => void = () => {
      throw new Error("Missing read");
    };
    mocks.action.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result, rerender } = renderHook(
      ({ id }) => useEvalInsightsEnvelope(id),
      { initialProps: { id: "run-1" } },
    );
    mocks.query.mockReturnValue({ _id: "run-2" });
    mocks.action.mockResolvedValue({ findings: [{ title: "run-2" }] });
    rerender({ id: "run-2" });
    await waitFor(() =>
      expect(result.current).toEqual({ findings: [{ title: "run-2" }] }),
    );
    await act(async () => {
      resolve(envelope);
    });
    expect(result.current).toEqual({ findings: [{ title: "run-2" }] });
  });
});
