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

const refused = () => ({
  until: Date.now() + 600_000,
  reason: "guest_access_disabled" as const,
});

describe("AuthRecoveryBoundary", () => {
  beforeEach(() => {
    state.convexAuth = { isLoading: false, isAuthenticated: false };
    state.refusal = null;
  });

  it("holds an unauthenticated visitor on the spinner while a guest may still arrive", () => {
    renderBoundary();
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.getByText("Loading")).toBeInTheDocument();
  });

  it("keeps the app unmounted once the guest is refused, and says why instead of spinning", () => {
    state.refusal = refused();
    renderBoundary();
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.queryByText("Loading")).toBeNull();
    expect(
      screen.getByText(
        "This deployment doesn't allow guest sessions. Sign in to continue.",
      ),
    ).toBeInTheDocument();
  });

  it("still shows the spinner while Convex auth is loading, refusal or not", () => {
    state.convexAuth = { isLoading: true, isAuthenticated: false };
    state.refusal = refused();
    renderBoundary();
    expect(screen.queryByTestId("guest-refused-signed-out")).toBeNull();
    expect(screen.getByText("Loading")).toBeInTheDocument();
  });

  it("renders the app once authenticated", () => {
    state.convexAuth = { isLoading: false, isAuthenticated: true };
    renderBoundary();
    expect(screen.getByTestId("app")).toBeInTheDocument();
  });
});
