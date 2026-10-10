import { act, cleanup, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";
import type { ReactNode } from "react";
import {
  projectTransitionRecovery as recovery,
  PROJECT_TRANSITION_TTL_MS,
} from "@/lib/auth/project-transition-recovery";
import { useProjectTransitionRecovery } from "../use-project-transition-recovery";
const A = "k5700000000000000000000000a",
  B = "k5700000000000000000000000b";
const path = `/p/${A}/evals/suite/old?view=runs#case`;
type Input = Parameters<typeof useProjectTransitionRecovery>[0];
const input = (overrides: Partial<Input> = {}): Input => ({
  actor: "workos:new",
  ready: true,
  routeReady: false,
  membershipProjectIds: new Set([B]),
  fallbackProjectId: B,
  ...overrides,
});
function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
}
function mount(props = input()) {
  return renderHook(
    (args: Input) => {
      const pending = useProjectTransitionRecovery(args);
      return {
        pending,
        location: useLocation(),
        navigate: useNavigate(),
        navigationType: useNavigationType(),
      };
    },
    { initialProps: props, wrapper },
  );
}
function arm() {
  recovery.remember(path, "guest:old");
  recovery.arm(path);
}
beforeEach(() => {
  recovery.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  recovery.clear();
  vi.useRealTimers();
});
it("waits for new authentication, setup and slow memberships, then replaces with Home", () => {
  arm();
  const view = mount(input({ ready: false, membershipProjectIds: undefined }));
  expect(view.result.current.pending).toBe(true);
  expect(view.result.current.location.pathname).toContain(A);
  view.rerender(input({ actor: "guest:old" }));
  expect(view.result.current.pending).toBe(true);
  view.rerender(input({ membershipProjectIds: undefined }));
  expect(view.result.current.pending).toBe(true);
  view.rerender(input());
  expect(view.result.current.location.pathname).toBe(`/p/${B}/home`);
  expect(view.result.current.location.search).toBe("");
  expect(view.result.current.location.hash).toBe("");
  expect(view.result.current.navigationType).toBe("REPLACE");
  expect(recovery.store.getState().marker).toBeNull();
});
it("keeps an accessible old project's full URL", () => {
  arm();
  const view = mount(input({ membershipProjectIds: new Set([A, B]) }));
  expect(
    view.result.current.location.pathname +
      view.result.current.location.search +
      view.result.current.location.hash,
  ).toBe(path);
  expect(recovery.store.getState().marker).toBeNull();
});
it("keeps an ordinary inaccessible direct link unchanged", () => {
  const view = mount();
  expect(view.result.current.location.pathname).toContain(A);
  expect(view.result.current.pending).toBe(false);
});
it("discards a pending marker when the user navigates elsewhere", () => {
  arm();
  const view = mount(input({ membershipProjectIds: undefined }));
  act(() => view.result.current.navigate("/p/another/home"));
  view.rerender(input());
  expect(view.result.current.location.pathname).toBe("/p/another/home");
  expect(recovery.store.getState().marker).toBeNull();
});
it("uses the unscoped project selection route when there are no projects", () => {
  arm();
  const view = mount(
    input({ membershipProjectIds: new Set(), fallbackProjectId: null }),
  );
  expect(view.result.current.location.pathname).toBe("/");
});
it("ignores an expired marker", () => {
  vi.useFakeTimers();
  arm();
  vi.advanceTimersByTime(PROJECT_TRANSITION_TTL_MS);
  const view = mount();
  expect(view.result.current.pending).toBe(false);
  expect(view.result.current.location.pathname).toContain(A);
  expect(recovery.store.getState().marker).toBeNull();
});
it("uses the final account's memberships after an account changes during recovery", () => {
  arm();
  const view = mount(
    input({ ready: false, membershipProjectIds: new Set([B]) }),
  );
  view.rerender(
    input({
      actor: "workos:other",
      ready: false,
      membershipProjectIds: undefined,
    }),
  );
  view.rerender(
    input({ actor: "workos:other", membershipProjectIds: new Set([A]) }),
  );
  expect(view.result.current.location.pathname).toContain(A);
  expect(recovery.store.getState().marker).toBeNull();
});
it("captures an already-open route when a sibling tab changes the account", () => {
  const view = mount(
    input({
      actor: "guest:old",
      routeReady: true,
      membershipProjectIds: new Set([A]),
    }),
  );
  view.rerender(input({ ready: false }));
  expect(view.result.current.pending).toBe(true);
  view.rerender(input());
  expect(view.result.current.location.pathname).toBe(`/p/${B}/home`);
});
