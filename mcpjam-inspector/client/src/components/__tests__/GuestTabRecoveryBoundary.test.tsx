import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import {
  act,
  fireEvent,
  render,
  screen,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  isLoading: false,
  signIn: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => auth }));
vi.mock("@/hooks/use-actor-key", () => ({
  useActorKey: () => auth.user?.id ?? "guest-ui",
}));
vi.mock("@/lib/auth/auth-refusal-diagnostics", () => ({
  authRefusalDiagnostics: { update: vi.fn(), flush: vi.fn() },
}));
import { GuestTabRecoveryBoundary } from "../GuestTabRecoveryBoundary";
import { guestTabRecovery } from "@/lib/auth/guest-tab-recovery";

beforeEach(() => {
  vi.useFakeTimers();
  auth.user = null;
  useSessionRefreshStore.setState({ authConfirmed: true });
  guestTabRecovery.setGuest(null);
});
afterEach(() => {
  cleanup();
  guestTabRecovery.dispose();
  vi.useRealTimers();
});
it("unmounts even ungated subscriptions, leaves controls outside, and times out", () => {
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  function App() {
    useEffect(() => {
      subscribe();
      return unsubscribe;
    }, []);
    return <p>app data</p>;
  }
  render(
    <GuestTabRecoveryBoundary>
      <App />
    </GuestTabRecoveryBoundary>,
  );
  expect(subscribe).toHaveBeenCalledTimes(1);
  act(() =>
    guestTabRecovery.receive({
      guestId: "guest-ui",
      attempt: "ui",
      startedAt: Date.now(),
      phase: "started",
    }),
  );
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("app data")).toBeNull();
  expect(screen.getByText("Updating your session…")).toBeTruthy();
  act(() => vi.advanceTimersByTime(15_000));
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(subscribe).toHaveBeenCalledTimes(1);
  const retry = vi
    .spyOn(guestTabRecovery, "retry")
    .mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
  retry.mockRestore();
});
it("ignores notifications after switching to a WorkOS identity", () => {
  const view = render(
    <GuestTabRecoveryBoundary>
      <p>app</p>
    </GuestTabRecoveryBoundary>,
  );
  auth.user = { id: "workos-user" };
  view.rerender(
    <GuestTabRecoveryBoundary>
      <p>app</p>
    </GuestTabRecoveryBoundary>,
  );
  act(() =>
    guestTabRecovery.receive({
      guestId: "guest-ui",
      attempt: "late",
      startedAt: Date.now(),
      phase: "started",
    }),
  );
  expect(screen.getByText("app")).toBeTruthy();
});

it("waits for user setup after the guest is replaced by WorkOS", () => {
  const view = render(
    <GuestTabRecoveryBoundary>
      <p>app</p>
    </GuestTabRecoveryBoundary>,
  );
  act(() =>
    guestTabRecovery.receive({
      guestId: "guest-ui",
      attempt: "setup",
      startedAt: Date.now(),
      phase: "started",
    }),
  );
  auth.user = { id: "replacement" };
  view.rerender(
    <GuestTabRecoveryBoundary ready={false}>
      <p>app</p>
    </GuestTabRecoveryBoundary>,
  );
  expect(screen.queryByText("app")).toBeNull();
  view.rerender(
    <GuestTabRecoveryBoundary ready>
      <p>app</p>
    </GuestTabRecoveryBoundary>,
  );
  expect(screen.getByText("app")).toBeTruthy();
});
