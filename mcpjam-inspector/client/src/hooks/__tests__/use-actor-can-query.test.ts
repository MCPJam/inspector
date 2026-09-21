import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { isAuthenticated: false, isLoading: false },
  isUserReady: false,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => mocks.auth,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mocks.isUserReady,
}));

import { useActorCanQuery } from "../use-actor-can-query";

describe("useActorCanQuery", () => {
  beforeEach(() => {
    mocks.auth = { isAuthenticated: false, isLoading: false };
    mocks.isUserReady = false;
  });

  // The whole point of the gate: a read issued between auth landing and
  // `users:ensureUser` resolving hits a function that expects the row.
  it("blocks an authenticated actor until the database user is ready", () => {
    mocks.auth = { isAuthenticated: true, isLoading: false };

    const { result, rerender } = renderHook(() => useActorCanQuery());
    expect(result.current).toBe(false);

    mocks.isUserReady = true;
    rerender();

    expect(result.current).toBe(true);
  });

  // `isAuthenticated` reads false while Convex is still resolving, which is
  // indistinguishable from "no identity" without `isLoading`. Reading during
  // that window would fire unauthenticated for an actor about to be authed.
  it("blocks while Convex auth is unresolved, then follows readiness", () => {
    mocks.auth = { isAuthenticated: false, isLoading: true };

    const { result, rerender } = renderHook(() => useActorCanQuery());
    expect(result.current).toBe(false);

    // Auth settles as authenticated, row not written yet.
    mocks.auth = { isAuthenticated: true, isLoading: false };
    rerender();
    expect(result.current).toBe(false);

    mocks.isUserReady = true;
    rerender();
    expect(result.current).toBe(true);
  });

  // A direct guest has no Convex identity and so never gets a `users` row;
  // gating it on readiness would skip its queries for the whole session.
  it("lets an actor with no Convex identity read once auth has settled", () => {
    const { result } = renderHook(() => useActorCanQuery());

    expect(result.current).toBe(true);
  });

  it("waits for a resolving session before letting a guest read", () => {
    mocks.auth = { isAuthenticated: false, isLoading: true };

    const { result, rerender } = renderHook(() => useActorCanQuery());
    expect(result.current).toBe(false);

    mocks.auth = { isAuthenticated: false, isLoading: false };
    rerender();

    expect(result.current).toBe(true);
  });
});
