import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  convexAuth: { isLoading: false, isAuthenticated: false },
  refusal: null as null | { until: number; reason: "guest_access_disabled" },
}));

vi.mock("convex/react", () => ({ useConvexAuth: () => state.convexAuth }));
vi.mock("@/lib/guest-session", () => ({
  getGuestSessionRefusal: () => state.refusal,
  subscribeGuestSessionChanges: () => () => {},
}));
vi.mock("../session-refresh-banner", () => ({
  SessionRefreshBanner: () => null,
}));
vi.mock("../guest-session-refused-banner", () => ({
  GuestSessionRefusedBanner: () => null,
}));

import { AuthRecoveryBoundary } from "../AuthRecoveryBoundary";

function renderBoundary() {
  return render(
    <AuthRecoveryBoundary>
      <div data-testid="app">app</div>
    </AuthRecoveryBoundary>,
  );
}

describe("AuthRecoveryBoundary", () => {
  beforeEach(() => {
    state.convexAuth = { isLoading: false, isAuthenticated: false };
    state.refusal = null;
  });

  it("holds an unauthenticated visitor while a guest session may still arrive", () => {
    renderBoundary();
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("renders the app signed out once the guest session was refused", () => {
    state.refusal = {
      until: Date.now() + 600_000,
      reason: "guest_access_disabled",
    };
    renderBoundary();
    expect(screen.getByTestId("app")).toBeInTheDocument();
  });

  it("still holds while Convex auth is loading, refusal or not", () => {
    state.convexAuth = { isLoading: true, isAuthenticated: false };
    state.refusal = {
      until: Date.now() + 600_000,
      reason: "guest_access_disabled",
    };
    renderBoundary();
    expect(screen.queryByTestId("app")).toBeNull();
  });
});
