import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useSessionMap } from "../useSessionMap";
const mocks = vi.hoisted(() => ({ version: 1, query: vi.fn() }));
const client = { query: mocks.query };
vi.mock("convex/react", () => ({
  useConvex: () => client,
  useQuery: () => ({ version: mocks.version, nodeCount: 1, updatedAt: 1 }),
}));
beforeEach(() => {
  vi.useFakeTimers();
  mocks.version = 1;
  mocks.query.mockReset();
});
afterEach(() => vi.useRealTimers());
const scope = { kind: "swarm" as const, projectId: "p", journeyRunIds: ["r"] };
test("debounces version changes and includes the exact wave scope", async () => {
  mocks.query.mockResolvedValue({ version: 2, nodes: [] });
  const { result, rerender } = renderHook(() => useSessionMap({ scope }));
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  mocks.version = 2;
  rerender();
  await act(async () => {
    vi.advanceTimersByTime(1999);
  });
  expect(mocks.query).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(mocks.query).toHaveBeenCalledWith("chatSessions:getSessionMapNodes", {
    projectId: "p",
    journeyRunIds: ["r"],
    version: 2,
  });
  expect(result.current.snapshot?.version).toBe(2);
});
test("failed refresh preserves the last successful map and retry fetches again", async () => {
  const snapshot = { version: 1, nodes: [{ sessionId: "s" }] };
  mocks.query
    .mockResolvedValueOnce(snapshot)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ...snapshot, version: 2 });
  const { result, rerender } = renderHook(() => useSessionMap({ scope }));
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  mocks.version = 2;
  rerender();
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(result.current.snapshot).toBe(snapshot);
  expect(result.current.snapshotError).toBe("offline");
  act(() => result.current.retry());
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(result.current.snapshot?.version).toBe(2);
  expect(result.current.snapshotError).toBeNull();
});
test("late response from a prior scope cannot replace the current graph", async () => {
  let resolveOld!: (value: unknown) => void;
  mocks.query
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce({ version: 1, nodes: [{ sessionId: "new" }] });
  const { result, rerender } = renderHook(
    ({ projectId }) => useSessionMap({ scope: { kind: "swarm", projectId } }),
    { initialProps: { projectId: "old" } },
  );
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  rerender({ projectId: "new" });
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  await act(async () => {
    resolveOld({ version: 1, nodes: [{ sessionId: "old" }] });
  });
  expect(result.current.snapshot?.nodes[0].sessionId).toBe("new");
});
