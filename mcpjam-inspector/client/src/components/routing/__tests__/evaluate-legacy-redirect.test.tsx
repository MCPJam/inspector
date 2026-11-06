import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { EvaluateLegacyRedirectGate } from "../evaluate-legacy-redirect";

const mocks = vi.hoisted(() => ({
  flag: undefined as boolean | undefined,
  queryResult: undefined as unknown,
  queries: [] as Array<Record<string, unknown>>,
  track: vi.fn(),
  mountedAt: [] as string[],
}));

const flagListeners = new Set<() => void>();
function setFlag(value: boolean | undefined) {
  mocks.flag = value;
  flagListeners.forEach((listener) => listener());
}

vi.mock("posthog-js/react", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    flagListeners.add(listener);
    return () => flagListeners.delete(listener);
  };
  return {
    useFeatureFlagEnabled: () =>
      useSyncExternalStore(subscribe, () => mocks.flag),
  };
});
vi.mock("convex/react", () => ({
  useQueries: (queries: Record<string, unknown>) => {
    mocks.queries.push(queries);
    return "iteration" in queries ? { iteration: mocks.queryResult } : {};
  },
}));
vi.mock("@/lib/analytics", () => ({ track: mocks.track }));

const P = "k5700000000000000000000000a";
const project = `/p/${P}`;

function Old() {
  const { pathname, search } = useLocation();
  mocks.mountedAt.push(`${pathname}${search}`);
  return <div>Old page</div>;
}

function BareOld() {
  return <div>Old page</div>;
}

function renderAt(entry: string, { strict = false } = {}) {
  const gated = {
    path: "evaluate/*",
    element: (
      <EvaluateLegacyRedirectGate>
        <Old />
      </EvaluateLegacyRedirectGate>
    ),
  };
  const router = createMemoryRouter(
    [gated, { path: "p/:projectId", children: [gated] }],
    { initialEntries: [entry] },
  );
  const provider = <RouterProvider router={router} />;
  const view = render(strict ? <StrictMode>{provider}</StrictMode> : provider);
  return { router, view };
}

function fullLocation(router: ReturnType<typeof createMemoryRouter>) {
  const { pathname, search, hash } = router.state.location;
  return `${pathname}${search}${hash}`;
}

function redirectedEvents() {
  return mocks.track.mock.calls.filter(
    ([name]) => name === "eval_nav_redirected",
  );
}

beforeEach(() => {
  mocks.flag = undefined;
  mocks.queryResult = undefined;
  mocks.queries = [];
  mocks.mountedAt = [];
  mocks.track.mockReset();
});
afterEach(cleanup);

describe("EvaluateLegacyRedirectGate, flag on", () => {
  beforeEach(() => {
    mocks.flag = true;
  });

  it("row 19 replaces with the test run page, keeping project and hash", async () => {
    const { router } = renderAt(
      `${project}/evaluate/suite/S/runs/R?case=C#trace`,
    );
    await waitFor(() =>
      expect(fullLocation(router)).toBe(
        `${project}/evaluate/suite/S/runs/R/cases/C#trace`,
      ),
    );
    expect(router.state.historyAction).toBe("REPLACE");
    expect(router.state.location.state).toEqual({
      evalNav: { via: "redirect" },
    });
    expect(redirectedEvents()).toEqual([
      [
        "eval_nav_redirected",
        {
          from_kind: "run-detail",
          to_kind: "test-run",
          matched: true,
          project_id: P,
          location: "evaluate_tab",
        },
      ],
    ]);
    router.dispose();
  });

  it("never mounts today's page for a redirect", async () => {
    const { router } = renderAt(`${project}/evaluate/suite/S/edit`);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `${project}/evaluate/suite/S/settings`,
      ),
    );
    // The target is a keep behind the same gate, so the page mounts only there.
    expect(mocks.mountedAt).not.toContain(`${project}/evaluate/suite/S/edit`);
    expect(mocks.mountedAt).toContain(`${project}/evaluate/suite/S/settings`);
    router.dispose();
  });

  it("works without a project prefix", async () => {
    const { router } = renderAt("/evaluate/suite/S/test/C/edit?checks=1");
    await waitFor(() =>
      expect(fullLocation(router)).toBe(
        "/evaluate/suite/S/settings/cases/C/evaluators",
      ),
    );
    expect(redirectedEvents()[0][1]).toMatchObject({ project_id: null });
    router.dispose();
  });

  it("row 8 carries Back to the case evaluators page in router state", async () => {
    const { router } = renderAt(
      `${project}/evaluate/suite/S/edit?fromCaseChecks=C`,
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `${project}/evaluate/suite/S/settings/evaluators`,
      ),
    );
    expect(router.state.location.state).toEqual({
      evalNav: {
        via: "redirect",
        from: {
          path: "/evaluate/suite/S/settings/cases/C/evaluators",
          place: "test case evaluators",
        },
      },
    });
    router.dispose();
  });

  it("row 26 renders today's page and fires one unmatched event", async () => {
    const { router } = renderAt(`${project}/evaluate/foo`);
    expect(screen.getByText("Old page")).toBeTruthy();
    await waitFor(() => expect(redirectedEvents()).toHaveLength(1));
    expect(redirectedEvents()[0][1]).toEqual({
      from_kind: "unknown",
      to_kind: null,
      matched: false,
      project_id: P,
      location: "evaluate_tab",
    });
    expect(fullLocation(router)).toBe(`${project}/evaluate/foo`);
    router.dispose();
  });

  it("does not fire twice on re-render or under StrictMode", async () => {
    const { router } = renderAt(`${project}/evaluate/foo`, { strict: true });
    await waitFor(() => expect(redirectedEvents()).toHaveLength(1));
    act(() => setFlag(true));
    act(() => setFlag(false));
    act(() => setFlag(true));
    expect(redirectedEvents()).toHaveLength(1);
    router.dispose();
  });

  it("fires one matched event under StrictMode", async () => {
    const { router } = renderAt(`${project}/evaluate/suite/S/edit`, {
      strict: true,
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `${project}/evaluate/suite/S/settings`,
      ),
    );
    expect(redirectedEvents()).toHaveLength(1);
    router.dispose();
  });

  it("keeps a new address without navigating or firing", () => {
    const { router } = renderAt(`${project}/evaluate/suite/S/settings`);
    expect(screen.getByText("Old page")).toBeTruthy();
    expect(router.state.historyAction).toBe("POP");
    expect(redirectedEvents()).toHaveLength(0);
    router.dispose();
  });

  it("skips the iteration query for non-lookup addresses", () => {
    const { router } = renderAt(`${project}/evaluate/suite/S/runs/R`);
    expect(mocks.queries.every((queries) => !("iteration" in queries))).toBe(
      true,
    );
    router.dispose();
  });

  describe("iteration lookup (row 21)", () => {
    const entry = `${project}/evaluate/suite/S/runs/R?iteration=I`;

    it("renders nothing while the lookup loads", () => {
      const { router } = renderAt(entry);
      expect(screen.queryByText("Old page")).toBeNull();
      expect(fullLocation(router)).toBe(entry);
      expect(redirectedEvents()).toHaveLength(0);
      expect(mocks.queries.some((queries) => "iteration" in queries)).toBe(
        true,
      );
      router.dispose();
    });

    it("lands on the iteration page once the lookup resolves", async () => {
      mocks.queryResult = { suiteRunId: "R", testCaseId: "C" };
      const { router } = renderAt(entry);
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(
          `${project}/evaluate/suite/S/runs/R/cases/C/iter/I`,
        ),
      );
      expect(redirectedEvents()[0][1]).toMatchObject({
        from_kind: "run-detail",
        to_kind: "iteration",
        matched: true,
      });
      router.dispose();
    });

    it.each([
      ["null", null],
      ["an Error", new Error("not allowed")],
    ])("falls back to the suite run for %s", async (_name, result) => {
      mocks.queryResult = result;
      const { router } = renderAt(entry);
      await waitFor(() =>
        expect(fullLocation(router)).toBe(`${project}/evaluate/suite/S/runs/R`),
      );
      expect(router.state.historyAction).toBe("REPLACE");
      expect(redirectedEvents()[0][1]).toMatchObject({ to_kind: "run-detail" });
      router.dispose();
    });
  });
});

describe("EvaluateLegacyRedirectGate, flag off or loading", () => {
  it("does nothing with the flag off", () => {
    mocks.flag = false;
    const entry = `${project}/evaluate/suite/S/runs/R?case=C`;
    const { router } = renderAt(entry);
    expect(screen.getByText("Old page")).toBeTruthy();
    expect(fullLocation(router)).toBe(entry);
    expect(mocks.track).not.toHaveBeenCalled();
    router.dispose();
  });

  it("does not fire for unmatched addresses with the flag off", () => {
    mocks.flag = false;
    const { router } = renderAt(`${project}/evaluate/foo`);
    expect(screen.getByText("Old page")).toBeTruthy();
    expect(mocks.track).not.toHaveBeenCalled();
    router.dispose();
  });

  it("holds while the flag loads, then redirects when it turns on", async () => {
    const entry = `${project}/evaluate/suite/S/runs/R?case=C`;
    const { router } = renderAt(entry);
    expect(screen.queryByText("Old page")).toBeNull();
    expect(fullLocation(router)).toBe(entry);
    expect(mocks.track).not.toHaveBeenCalled();
    act(() => setFlag(true));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `${project}/evaluate/suite/S/runs/R/cases/C`,
      ),
    );
    router.dispose();
  });

  it("renders keep addresses at once while the flag loads", () => {
    const { router } = renderAt(`${project}/evaluate`);
    expect(screen.getByText("Old page")).toBeTruthy();
    router.dispose();
  });
});

describe("EvaluateLegacyRedirectGate without a Router", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("navigates through window.history with the redirect state", async () => {
    mocks.flag = true;
    window.history.replaceState(
      {},
      "",
      `${project}/evaluate/suite/S/runs/R?case=C#trace`,
    );
    render(
      <EvaluateLegacyRedirectGate>
        <BareOld />
      </EvaluateLegacyRedirectGate>,
    );
    await waitFor(() =>
      expect(
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      ).toBe(`${project}/evaluate/suite/S/runs/R/cases/C#trace`),
    );
    expect(window.history.state).toEqual({ evalNav: { via: "redirect" } });
  });
});
