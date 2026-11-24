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

  it("asks for nothing when the climb has no rounds", () => {
    mockChangesBetween.mockClear();
    renderHook(() => useRoundChanges("proj_1", makeClimb()));
    expect(mockChangesBetween).not.toHaveBeenCalled();
  });
});
