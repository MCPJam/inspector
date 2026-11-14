import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalSuiteRunListItem } from "../types";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("convex/react", () => ({
  // Loaded, no quality row yet: the state in which the hook auto-requests.
  useQuery: () => ({ status: undefined }),
  useMutation: (name: string) =>
    name === "runGroupQuality:requestRunGroupQuality"
      ? mocks.request
      : mocks.cancel,
}));

import { useRunGroupQuality } from "../use-run-group-quality";

function run(
  index: number,
  status: EvalSuiteRunListItem["status"],
): EvalSuiteRunListItem {
  return {
    _id: `run-${index}`,
    suiteId: "suite-1",
    createdBy: "user",
    runNumber: index + 1,
    configRevision: "rev",
    configSnapshot: {},
    status,
    result: "pending",
    createdAt: Date.now(),
  };
}

function renderGroup(statuses: EvalSuiteRunListItem["status"][]) {
  return renderHook(() =>
    useRunGroupQuality({
      suiteId: "suite-1",
      runGroupId: "group-1",
      runs: statuses.map((status, index) => run(index, status)),
    }),
  );
}

describe("useRunGroupQuality", () => {
  beforeEach(() => {
    mocks.request.mockReset().mockResolvedValue(undefined);
    mocks.cancel.mockReset();
  });

  it("treats a timed-out host run as finished and requests the comparison", () => {
    const { result } = renderGroup(["completed", "timed_out"]);

    expect(result.current.allRunsTerminal).toBe(true);
    expect(result.current.canRequest).toBe(true);
    expect(mocks.request).toHaveBeenCalledWith({
      suiteId: "suite-1",
      runGroupId: "group-1",
      force: false,
    });
  });

  it.each(["running", "grading"] as const)(
    "waits while a host run is %s",
    (status) => {
      const { result } = renderGroup(["completed", status]);

      expect(result.current.allRunsTerminal).toBe(false);
      expect(result.current.canRequest).toBe(false);
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );
});
