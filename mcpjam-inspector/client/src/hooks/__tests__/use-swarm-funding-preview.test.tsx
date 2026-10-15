import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchPreviewMock = vi.fn();
vi.mock("@/lib/swarm-api", () => ({
  fetchSwarmFundingPreview: (...args: unknown[]) => fetchPreviewMock(...args),
}));

import { useSwarmFundingPreview } from "../use-swarm-funding-preview";

const PREVIEW = { supported: true, remaining: 3, granted: 500, runs: [] };

beforeEach(() => {
  fetchPreviewMock.mockReset().mockResolvedValue(PREVIEW);
});

describe("useSwarmFundingPreview", () => {
  it("fetches nothing without a project or runs", () => {
    const { result, rerender } = renderHook(
      (props: {
        projectId: string | null;
        runs: { journeyRefId: string }[] | null;
      }) => useSwarmFundingPreview(props),
      { initialProps: { projectId: null, runs: [{ journeyRefId: "j" }] } },
    );
    expect(result.current.status).toBe("idle");
    rerender({ projectId: "p", runs: [] });
    expect(result.current.status).toBe("idle");
    rerender({ projectId: "p", runs: null });
    expect(fetchPreviewMock).not.toHaveBeenCalled();
  });

  it("previews a plan and re-reads it on a refresh key", async () => {
    const runs = [{ journeyRefId: "j1", sessionsPerTarget: 2 }];
    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: number }) =>
        useSwarmFundingPreview({ projectId: "p", runs, refreshKey }),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchPreviewMock.mock.calls[0]![0]).toBe("p");
    expect(fetchPreviewMock.mock.calls[0]![1]).toEqual(runs);

    rerender({ refreshKey: 1 });
    await waitFor(() => expect(fetchPreviewMock).toHaveBeenCalledTimes(2));
  });

  it("reads a failed preview as an error, never as a split", async () => {
    fetchPreviewMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() =>
      useSwarmFundingPreview({ projectId: "p", runs: [{ journeyRefId: "j" }] }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("does not let a slower answer to an older plan paint over a newer one", async () => {
    let releaseOld!: (value: unknown) => void;
    fetchPreviewMock
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseOld = resolve)),
      )
      .mockResolvedValueOnce({ ...PREVIEW, remaining: 42 });
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useSwarmFundingPreview({
          projectId: "p",
          runs: [{ journeyRefId: id }],
        }),
      { initialProps: { id: "old" } },
    );
    rerender({ id: "new" });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    releaseOld({ ...PREVIEW, remaining: 1 });
    await Promise.resolve();
    expect(
      result.current.status === "ready" && result.current.preview.remaining,
    ).toBe(42);
  });
});
