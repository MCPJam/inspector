import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskOwnerId } from "../use-task-owner-id";

const state = vi.hoisted(() => ({
  authenticated: true,
  canQuery: true,
  user: { _id: "convex-guest" } as { _id: string } | null,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: state.authenticated }),
  useQuery: (_ref: unknown, args: unknown) =>
    args === "skip" ? undefined : state.user,
}));
vi.mock("../use-actor-can-query", () => ({
  useActorCanQuery: () => state.canQuery,
}));

describe("Task owner identity", () => {
  beforeEach(() => {
    state.authenticated = true;
    state.canQuery = true;
    state.user = { _id: "convex-guest" };
  });
  it("uses the identity Convex resolved across guest and member transitions", () => {
    const { result, rerender } = renderHook(useTaskOwnerId);
    expect(result.current).toBe("convex-guest");
    state.user = { _id: "convex-member" };
    rerender();
    expect(result.current).toBe("convex-member");
  });
  it("supplies no owner while the current actor cannot query", () => {
    state.canQuery = false;
    const { result, rerender } = renderHook(useTaskOwnerId);
    expect(result.current).toBeUndefined();
    state.canQuery = true;
    state.authenticated = false;
    rerender();
    expect(result.current).toBeUndefined();
  });
});
