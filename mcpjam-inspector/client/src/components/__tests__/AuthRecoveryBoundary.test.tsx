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
  GuestSessionRefusedBanner: () => <div data-testid="guest-refused-banner" />,
}));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: vi.fn() }));
vi.mock("@/lib/PosthogUtils", () => ({ detectPlatform: () => "web" }));
vi.mock("@/hooks/use-inspector-auth", () => ({
  useInspectorAuth: () => ({ user: { id: "user_1" }, signIn: vi.fn() }),
}));

import { AuthRecoveryBoundary } from "../AuthRecoveryBoundary";
import {
  resetStartupStatusForTests,
  useStartupStore,
} from "@/lib/startup-status";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

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
    resetStartupStatusForTests();
    useSessionRefreshStore.setState({
      status: "idle",
      kind: null,
      queriesPaused: false,
    });
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
    expect(screen.queryByTestId("startup-recovery-card")).toBeNull();
    expect(screen.getByText("Loading")).toBeInTheDocument();
  });

  it("renders the app once authenticated", () => {
    state.convexAuth = { isLoading: false, isAuthenticated: true };
    renderBoundary();
    expect(screen.getByTestId("app")).toBeInTheDocument();
  });

  it("replaces the spinner with the recovery card once startup escalates", () => {
    useSessionRefreshStore.setState({ status: "failed", kind: "transient" });
    useStartupStore.setState({ escalated: true });
    renderBoundary();
    expect(screen.queryByTestId("app")).toBeNull();
    expect(screen.queryByText("Loading")).toBeNull();
    expect(screen.getByTestId("startup-recovery-card")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in again" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reload app" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy diagnostics" }),
    ).toBeInTheDocument();
  });

  it("keeps the card up with a busy Retry while a retry runs", () => {
    useSessionRefreshStore.setState({ status: "retrying", kind: "transient" });
    useStartupStore.setState({ escalated: true });
    renderBoundary();
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
  });

  it("offers Sign in once, on the card, when an escalated startup covers a guest refusal", () => {
    state.refusal = refused();
    useSessionRefreshStore.setState({ queriesPaused: true });
    useStartupStore.setState({ escalated: true });
    renderBoundary();
    expect(screen.getByTestId("startup-recovery-card")).toBeInTheDocument();
    expect(screen.queryByTestId("guest-refused-banner")).toBeNull();
  });

  it("keeps the refusal banner while startup has not escalated", () => {
    state.refusal = refused();
    useSessionRefreshStore.setState({ queriesPaused: true });
    renderBoundary();
    expect(screen.getByTestId("guest-refused-banner")).toBeInTheDocument();
  });
});
