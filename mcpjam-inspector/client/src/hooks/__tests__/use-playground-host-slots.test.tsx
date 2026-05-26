/**
 * Contract test for `usePlaygroundHostSlots` (Phase 4 multi-host plan).
 *
 * Verifies:
 *   - 3 unconditional `useHost` calls regardless of `ids.length` (the
 *     rules-of-hooks compliance the helper was created to enforce).
 *   - Slot positions correspond to id array positions; missing ids
 *     short-circuit (null host).
 *   - Re-rendering with a changed id at a given slot index re-queries
 *     that slot. We assert this indirectly by checking that the mock
 *     receives the new id and the slot's `host` changes accordingly.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePlaygroundHostSlots } from "../use-playground-host-slots";
import type { HostDetail } from "@/hooks/useClients";

// Capture every `useHost` call so we can assert call count + arguments.
const useHostMock = vi.fn();

vi.mock("@/hooks/useClients", () => ({
  useHost: (args: { isAuthenticated: boolean; hostId: string | null }) => {
    useHostMock(args);
    if (!args.hostId) {
      return { host: null, isLoading: false };
    }
    const host: HostDetail = {
      hostId: args.hostId,
      name: `Host ${args.hostId}`,
      // The test doesn't exercise config fields; cast to satisfy the type.
      config: { id: `${args.hostId}-config` } as HostDetail["config"],
    };
    return { host, isLoading: false };
  },
}));

describe("usePlaygroundHostSlots", () => {
  it("always makes 3 useHost calls regardless of ids length", () => {
    useHostMock.mockClear();
    renderHook(() => usePlaygroundHostSlots(true, ["a"]));
    expect(useHostMock).toHaveBeenCalledTimes(3);
    expect(useHostMock).toHaveBeenNthCalledWith(1, {
      isAuthenticated: true,
      hostId: "a",
    });
    expect(useHostMock).toHaveBeenNthCalledWith(2, {
      isAuthenticated: true,
      hostId: null,
    });
    expect(useHostMock).toHaveBeenNthCalledWith(3, {
      isAuthenticated: true,
      hostId: null,
    });
  });

  it("returns hosts in slot order; trailing slots return null when no id is provided", () => {
    useHostMock.mockClear();
    const { result } = renderHook(() =>
      usePlaygroundHostSlots(true, ["a", "b"]),
    );

    expect(result.current).toHaveLength(3);
    expect(result.current[0].host?.hostId).toBe("a");
    expect(result.current[1].host?.hostId).toBe("b");
    expect(result.current[2].host).toBeNull();
  });

  it("re-queries the corresponding slot when its id changes", () => {
    useHostMock.mockClear();
    const { result, rerender } = renderHook(
      ({ ids }: { ids: (string | null | undefined)[] }) =>
        usePlaygroundHostSlots(true, ids),
      { initialProps: { ids: ["a", "b"] as (string | null | undefined)[] } },
    );

    expect(result.current[1].host?.hostId).toBe("b");

    rerender({ ids: ["a", "c"] });

    expect(result.current[1].host?.hostId).toBe("c");
    // Slot 0 is unchanged across renders.
    expect(result.current[0].host?.hostId).toBe("a");
  });

  it("treats null/undefined ids as short-circuits (null host, no error)", () => {
    useHostMock.mockClear();
    const { result } = renderHook(() =>
      usePlaygroundHostSlots(true, [null, undefined, "c"]),
    );

    expect(result.current[0].host).toBeNull();
    expect(result.current[1].host).toBeNull();
    expect(result.current[2].host?.hostId).toBe("c");
  });
});
