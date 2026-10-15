import { invalidateSwarmSponsorshipAllowance } from "@/lib/swarm-sponsorship-allowance-store";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchPreviewMock = vi.fn();
vi.mock("@/lib/swarm-api", () => ({
  fetchSwarmFundingPreview: (...args: unknown[]) => fetchPreviewMock(...args),
}));

let appState: unknown = null;
vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => appState,
}));

import { useSwarmSponsorshipAllowance } from "../use-swarm-sponsorship-allowance";

const withProject = () => ({
  activeProjectId: "local-1",
  projects: { "local-1": { sharedProjectId: "convex-1" } },
});

beforeEach(() => {
  fetchPreviewMock.mockReset();
  appState = withProject();
});

describe("useSwarmSponsorshipAllowance", () => {
  it("reads the allowance through the active project with nothing to preview", async () => {
    fetchPreviewMock.mockResolvedValue({
      supported: true,
      remaining: 412,
      granted: 500,
      runs: [],
    });
    const { result } = renderHook(() => useSwarmSponsorshipAllowance());
    await waitFor(() =>
      expect(result.current).toEqual({ remaining: 412, granted: 500 }),
    );
    expect(fetchPreviewMock.mock.calls[0]![0]).toBe("convex-1");
    expect(fetchPreviewMock.mock.calls[0]![1]).toEqual([]);
  });

  it.each([
    ["unsupported", { supported: false, remaining: 0, granted: 0, runs: [] }],
    ["no grant", { supported: true, remaining: 0, granted: 0, runs: [] }],
  ])("shows nothing when sponsorship is %s", async (_name, preview) => {
    fetchPreviewMock.mockResolvedValue(preview);
    const { result } = renderHook(() => useSwarmSponsorshipAllowance());
    await waitFor(() => expect(fetchPreviewMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("shows nothing when the read fails", async () => {
    fetchPreviewMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useSwarmSponsorshipAllowance());
    await waitFor(() => expect(fetchPreviewMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("asks nothing without an active shared project, or when disabled", () => {
    appState = { activeProjectId: "local-1", projects: { "local-1": {} } };
    renderHook(() => useSwarmSponsorshipAllowance());
    appState = withProject();
    renderHook(() => useSwarmSponsorshipAllowance(false));
    appState = null;
    renderHook(() => useSwarmSponsorshipAllowance());
    expect(fetchPreviewMock).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("shares the read and refreshes every mounted surface when a launch invalidates the allowance", async () => {
  fetchPreviewMock.mockResolvedValueOnce({
    supported: true,
    remaining: 500,
    granted: 500,
    runs: [],
  });
  const sidebar = renderHook(() => useSwarmSponsorshipAllowance());
  const billing = renderHook(() => useSwarmSponsorshipAllowance());
  await waitFor(() => expect(billing.result.current?.remaining).toBe(500));
  expect(fetchPreviewMock).toHaveBeenCalledTimes(1);
  fetchPreviewMock.mockResolvedValue({
    supported: true,
    remaining: 485,
    granted: 500,
    runs: [],
  });
  act(() => invalidateSwarmSponsorshipAllowance());
  await waitFor(() => expect(sidebar.result.current?.remaining).toBe(485));
  expect(billing.result.current?.remaining).toBe(485);
  expect(fetchPreviewMock).toHaveBeenCalledTimes(2);
});
it("refreshes refunds periodically and cancels its timer after the last reader leaves", async () => {
  vi.useFakeTimers();
  fetchPreviewMock.mockResolvedValue({
    supported: true,
    remaining: 485,
    granted: 500,
    runs: [],
  });
  const view = renderHook(() => useSwarmSponsorshipAllowance());
  await act(async () => {});
  expect(view.result.current?.remaining).toBe(485);
  fetchPreviewMock.mockResolvedValue({
    supported: true,
    remaining: 490,
    granted: 500,
    runs: [],
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(view.result.current?.remaining).toBe(490);
  view.unmount();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetchPreviewMock).toHaveBeenCalledTimes(2);
});

it("ignores a stale in-flight read after launch invalidation", async () => {
  let resolveOld!: (value: unknown) => void;
  fetchPreviewMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const view = renderHook(() => useSwarmSponsorshipAllowance());
  fetchPreviewMock.mockResolvedValue({
    supported: true,
    remaining: 485,
    granted: 500,
    runs: [],
  });
  act(() => invalidateSwarmSponsorshipAllowance());
  await waitFor(() => expect(view.result.current?.remaining).toBe(485));
  await act(async () => {
    resolveOld({ supported: true, remaining: 500, granted: 500, runs: [] });
  });
  expect(view.result.current?.remaining).toBe(485);
});
