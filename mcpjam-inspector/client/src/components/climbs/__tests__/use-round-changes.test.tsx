import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const mockChangesBetween = vi.fn();
vi.mock("@/lib/apis/climbs-api", () => ({
  mockChangesBetween: (...args: unknown[]) => mockChangesBetween(...args),
}));

import { useRoundChanges } from "../use-round-changes";
import { makeClimb, makeRound } from "./fixtures";

describe("useRoundChanges", () => {
  it("reads each round against the best before it, and records one that cannot be read", async () => {
    mockChangesBetween.mockImplementation(async ({ version }: { version: number }) => {
      if (version === 3) throw new Error("gone");
      return [{ summary: `v${version}` }];
    });
    const climb = makeClimb({
      rounds: [
        makeRound({ number: 1, serverVersion: "2" }),
        makeRound({ number: 2, serverVersion: "3", standing: "reverted" }),
        makeRound({ number: 3, serverVersion: "4" }),
      ],
    });
    const { result } = renderHook(() => useRoundChanges("proj_1", climb));
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(3));
    expect(result.current[1]).toEqual([{ summary: "v2" }]);
    expect(result.current[2]).toBeNull();
    expect(result.current[3]).toEqual([{ summary: "v4" }]);
    expect(mockChangesBetween).toHaveBeenCalledWith({
      projectId: "proj_1",
      mockId: "mock_1",
      version: 4,
      sinceVersion: 2,
    });
  });

  it("records a round that ran a saved server as a code round, and reads nothing for it", async () => {
    mockChangesBetween.mockReset();
    mockChangesBetween.mockImplementation(async ({ version }: { version: number }) => [{ summary: `v${version}` }]);
    const climb = makeClimb({
      rounds: [makeRound({ number: 1, serverId: "srv_branch", serverVersion: undefined }), makeRound({ number: 2, serverVersion: "3", standing: "reverted" })],
    });
    const servers = { real: [{ id: "srv_branch", name: "Echo (fast branch)" }], loading: false };
    const { result } = renderHook(() => useRoundChanges("proj_1", climb, servers));
    expect(result.current[1]).toEqual({ code: { serverId: "srv_branch", serverName: "Echo (fast branch)" } });
    await waitFor(() => expect(result.current[2]).toEqual([{ summary: "v3" }]));
    expect(mockChangesBetween).toHaveBeenCalledTimes(1);
  });

  it("reads nothing while the project's servers are still loading", () => {
    mockChangesBetween.mockClear();
    const climb = makeClimb({ rounds: [makeRound({ number: 1, serverVersion: "3" })] });
    renderHook(() => useRoundChanges("proj_1", climb, { real: [], loading: true }));
    expect(mockChangesBetween).not.toHaveBeenCalled();
  });

  it("asks for nothing when the climb has no rounds", () => {
    mockChangesBetween.mockClear();
    renderHook(() => useRoundChanges("proj_1", makeClimb()));
    expect(mockChangesBetween).not.toHaveBeenCalled();
  });
});
