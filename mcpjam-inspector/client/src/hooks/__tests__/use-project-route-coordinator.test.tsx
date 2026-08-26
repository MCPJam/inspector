import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import { useProjectRouteCoordinator } from "../use-project-route-coordinator";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const A = "k5700000000000000000000000a";
const B = "k5700000000000000000000000b";

function wrapperFor(initialPath: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
    );
  };
}

type Input = Parameters<typeof useProjectRouteCoordinator>[0];

function inputFor(overrides: Partial<Input> = {}): Input {
  return {
    isAuthenticated: true,
    isAuthLoading: false,
    isLoadingRemoteProjects: false,
    projects: { [A]: {}, [B]: {} },
    allProjects: [
      { _id: A, organizationId: "org_a" },
      { _id: B, organizationId: "org_a" },
    ],
    activeProjectId: A,
    activeOrganizationId: "org_a",
    setActiveOrganizationId: vi.fn(),
    switchProject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Same reason as the routing component tests: these wait on effect → switch →
 * re-render chains, and RTL's 1s default is an idle-machine assumption that a
 * contended CI shard does not honor.
 */
const RESOLUTION_TIMEOUT = { timeout: 5_000 } as const;

describe("useProjectRouteCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The history-driving test below leaves the window on a scoped path. Reset
    // it so isolation does not depend on every later test supplying a router.
    window.history.replaceState({}, "", "/");
  });

  it("is unscoped on a route with no project segment", () => {
    const { result } = renderHook(
      () => useProjectRouteCoordinator(inputFor()),
      {
        wrapper: wrapperFor("/settings"),
      }
    );
    expect(result.current).toEqual({ status: "unscoped" });
  });

  it("is ready when the URL already names the active project", () => {
    const { result } = renderHook(
      () => useProjectRouteCoordinator(inputFor()),
      {
        wrapper: wrapperFor(`/p/${A}/servers`),
      }
    );
    expect(result.current).toEqual({ status: "ready", projectId: A });
  });

  it("switches the active project to match the URL", async () => {
    const switchProject = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(
      () => useProjectRouteCoordinator(inputFor({ switchProject })),
      { wrapper: wrapperFor(`/p/${B}/servers`) }
    );
    expect(result.current.status).toBe("resolving");
    await waitFor(
      () => expect(switchProject).toHaveBeenCalledWith(B),
      RESOLUTION_TIMEOUT
    );
  });

  it("fires one switch per requested project, not one per render", async () => {
    // The resolver returns a fresh effect object every render. An effect
    // keyed on that identity would re-fire the switch on every commit.
    const switchProject = vi.fn().mockResolvedValue(undefined);
    const input = inputFor({ switchProject });
    const { rerender } = renderHook(() => useProjectRouteCoordinator(input), {
      wrapper: wrapperFor(`/p/${B}/servers`),
    });
    rerender();
    rerender();
    await waitFor(
      () => expect(switchProject).toHaveBeenCalledTimes(1),
      RESOLUTION_TIMEOUT
    );
  });

  it("does not re-fire when the switch callback's identity changes", async () => {
    // `handleSwitchProject` is a useCallback over the live server map, so its
    // identity churns. As an effect dependency it would re-run the switch on
    // every commit and spend the attempt budget while nothing about the route
    // had changed — leaving a perfectly good project URL reported as
    // unavailable.
    const calls: string[] = [];
    const { rerender, result } = renderHook(
      () =>
        useProjectRouteCoordinator(
          inputFor({
            // A brand new function every render.
            switchProject: async (id: string) => {
              calls.push(id);
            },
          })
        ),
      { wrapper: wrapperFor(`/p/${B}/servers`) }
    );
    for (let i = 0; i < 5; i += 1) rerender();
    await waitFor(() => expect(calls).toEqual([B]), RESOLUTION_TIMEOUT);
    expect(result.current.status).toBe("resolving");
  });

  it("switches organization first for a cross-organization URL", async () => {
    const setActiveOrganizationId = vi.fn();
    const switchProject = vi.fn().mockResolvedValue(undefined);
    renderHook(
      () =>
        useProjectRouteCoordinator(
          inputFor({
            projects: { [A]: {} },
            allProjects: [
              { _id: A, organizationId: "org_a" },
              { _id: B, organizationId: "org_b" },
            ],
            setActiveOrganizationId,
            switchProject,
          })
        ),
      { wrapper: wrapperFor(`/p/${B}/servers`) }
    );
    await waitFor(
      () => expect(setActiveOrganizationId).toHaveBeenCalledWith("org_b"),
      RESOLUTION_TIMEOUT
    );
    // The project switch waits for the organization-filtered list to catch up.
    expect(switchProject).not.toHaveBeenCalled();
  });

  it("reports one generic inaccessible state and never switches", async () => {
    const switchProject = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(
      () =>
        useProjectRouteCoordinator(
          inputFor({
            projects: { [A]: {} },
            allProjects: [{ _id: A, organizationId: "org_a" }],
            switchProject,
          })
        ),
      { wrapper: wrapperFor(`/p/${B}/servers`) }
    );
    expect(result.current).toEqual({
      status: "inaccessible",
      requestedProjectId: B,
    });
    expect(switchProject).not.toHaveBeenCalled();
  });

  it("answers a malformed project id without waiting", () => {
    const { result } = renderHook(
      () => useProjectRouteCoordinator(inputFor({ isAuthLoading: true })),
      { wrapper: wrapperFor("/p/none/servers") }
    );
    expect(result.current).toEqual({
      status: "inaccessible",
      requestedProjectId: "none",
    });
  });

  it("reconciles continuously — an A → B navigation without a remount", async () => {
    // Back/Forward and in-app navigation both change the requested project
    // in place. The predecessor ran once per mount and would have missed both.
    const switchProject = vi.fn().mockResolvedValue(undefined);
    let path = `/p/${A}/servers`;
    const { result, rerender } = renderHook(
      ({ pathname }: { pathname: string }) => {
        // A fresh MemoryRouter per path would remount; instead drive the
        // window location the hook falls back to when no router is present.
        window.history.replaceState({}, "", pathname);
        return useProjectRouteCoordinator(inputFor({ switchProject }));
      },
      { initialProps: { pathname: path } }
    );
    expect(result.current).toEqual({ status: "ready", projectId: A });

    path = `/p/${B}/servers`;
    act(() => {
      window.history.pushState({}, "", path);
      // What Back/Forward does. The no-router fallback listens for exactly
      // this, which is why a location change is observed without a remount.
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    rerender({ pathname: path });
    await waitFor(
      () => expect(switchProject).toHaveBeenCalledWith(B),
      RESOLUTION_TIMEOUT
    );
    expect(result.current.status).toBe("resolving");
  });

  it("keeps two tabs on two different projects", async () => {
    // Each hook instance reads its OWN location. Nothing ambient — no
    // persisted "last project", no module-level active id — is allowed to
    // make one tab's project decide the other's.
    const tabA = renderHook(
      () => useProjectRouteCoordinator(inputFor({ activeProjectId: A })),
      { wrapper: wrapperFor(`/p/${A}/servers`) }
    );
    const switchProject = vi.fn().mockResolvedValue(undefined);
    const tabB = renderHook(
      () =>
        useProjectRouteCoordinator(
          inputFor({ activeProjectId: B, switchProject })
        ),
      { wrapper: wrapperFor(`/p/${B}/evals`) }
    );

    expect(tabA.result.current).toEqual({ status: "ready", projectId: A });
    expect(tabB.result.current).toEqual({ status: "ready", projectId: B });
    expect(switchProject).not.toHaveBeenCalled();

    tabA.rerender();
    tabB.rerender();
    expect(tabA.result.current).toEqual({ status: "ready", projectId: A });
    expect(tabB.result.current).toEqual({ status: "ready", projectId: B });
  });

  it("does not surface a rejected switch as a crash", async () => {
    const switchProject = vi.fn().mockRejectedValue(new Error("nope"));
    const { result } = renderHook(
      () => useProjectRouteCoordinator(inputFor({ switchProject })),
      { wrapper: wrapperFor(`/p/${B}/servers`) }
    );
    await waitFor(
      () => expect(switchProject).toHaveBeenCalled(),
      RESOLUTION_TIMEOUT
    );
    expect(result.current.status).toBe("resolving");
  });

  it("retries a switch that rejected for a transient reason", async () => {
    // A switch disconnects the current project's servers first, and that can
    // fail. Swallowing the rejection left the effect keyed on the same "switch
    // to B", so it never ran again: an accessible project spun until the
    // resolve budget expired and then reported itself unavailable.
    const switchProject = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(undefined);
    renderHook(() => useProjectRouteCoordinator(inputFor({ switchProject })), {
      wrapper: wrapperFor(`/p/${B}/servers`),
    });
    await waitFor(
      () => expect(switchProject).toHaveBeenCalledTimes(2),
      RESOLUTION_TIMEOUT
    );
  });

  it("gives up on a switch that keeps rejecting, rather than spinning", async () => {
    // The retry above is bounded by the attempt cap, so a persistent failure
    // reaches the same generic unavailable state a missing project does —
    // without waiting out the 15s resolve budget first.
    const switchProject = vi.fn().mockRejectedValue(new Error("persistent"));
    const { result } = renderHook(
      () => useProjectRouteCoordinator(inputFor({ switchProject })),
      { wrapper: wrapperFor(`/p/${B}/servers`) }
    );
    await waitFor(
      () =>
        expect(result.current).toEqual({
          status: "inaccessible",
          requestedProjectId: B,
        }),
      RESOLUTION_TIMEOUT
    );
    // Bounded: the cap, not an unbounded retry loop.
    expect(switchProject.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
