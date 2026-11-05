import { act, render, renderHook, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalRoute } from "@/lib/eval-route-types";

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("../create-suite-navigation", () => ({
  navigatePlaygroundEvalsRoute: mocks.navigate,
}));

import { useEvaluateLandingNav } from "../evaluate-landing-nav";
import { HOW_SUITES_WORK_SEEN_KEY } from "../how-suites-work/how-suites-work-model";

type Props = {
  enabled: boolean | undefined;
  addressRoute: EvalRoute;
  suiteCount: number | null;
};

const list: EvalRoute = { type: "list" };
const runs: EvalRoute = { type: "evaluate-runs" };

function setup(initial: Partial<Props> = {}) {
  return renderHook((props: Props) => useEvaluateLandingNav(props), {
    initialProps: {
      enabled: true,
      addressRoute: list,
      suiteCount: 2,
      ...initial,
    },
  });
}

const pageViews = () =>
  mocks.track.mock.calls.filter(([name]) => name === "eval_nav_page_viewed");

beforeEach(() => {
  localStorage.clear();
  mocks.track.mockClear();
  mocks.navigate.mockClear();
});

afterEach(() => localStorage.clear());

describe("useEvaluateLandingNav", () => {
  it("is off while the flag is off or loading", () => {
    expect(setup({ enabled: false }).result.current).toBeNull();
    expect(setup({ enabled: undefined }).result.current).toBeNull();
    expect(mocks.track).not.toHaveBeenCalled();
    expect(localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY)).toBeNull();
  });

  it("maps /evaluate to Suites and /evaluate/runs to Runs, and switches by address", () => {
    const { result, rerender } = setup();
    expect(result.current?.header.landingView).toBe("suites");
    act(() => result.current?.header.onLandingViewChange?.("runs"));
    expect(mocks.navigate).toHaveBeenCalledWith({ type: "evaluate-runs" });
    rerender({ enabled: true, addressRoute: runs, suiteCount: 2 });
    expect(result.current?.header.landingView).toBe("runs");
    act(() => result.current?.header.onLandingViewChange?.("suites"));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ type: "list" });
  });

  it("gives other pages no landing header props", () => {
    const { result } = setup({
      addressRoute: { type: "suite-overview", suiteId: "s1" },
    });
    expect(result.current?.header).toEqual({});
    expect(pageViews()).toHaveLength(0);
  });

  it("records a page view per tab with how it was reached", async () => {
    function Landing() {
      const { pathname } = useLocation();
      useEvaluateLandingNav({
        enabled: true,
        addressRoute: pathname.endsWith("/runs") ? runs : list,
        suiteCount: 2,
      });
      return null;
    }
    const router = createMemoryRouter(
      [{ path: "/evaluate/*", element: <Landing /> }],
      { initialEntries: ["/evaluate"] },
    );
    render(<RouterProvider router={router} />);
    expect(pageViews()[0]?.[1]).toEqual({
      page: "suites",
      arrived_via: "direct",
      location: "evaluate",
    });
    await act(() => router.navigate("/evaluate/runs"));
    expect(pageViews()[1]?.[1]).toMatchObject({
      page: "runs",
      arrived_via: "link",
    });
    await act(() => router.navigate(-1));
    expect(pageViews()[2]?.[1]).toMatchObject({
      page: "suites",
      arrived_via: "back",
    });
  });

  it("opens the tutorial on the first visit, even with no suites, and only once", () => {
    const first = setup({ suiteCount: 0 });
    render(<>{first.result.current?.tutorial}</>);
    expect(screen.getByTestId("how-suites-work")).toBeTruthy();
    expect(mocks.track).toHaveBeenCalledWith("eval_tutorial_shown", {
      location: "evaluate",
      trigger: "first_visit",
      step: 1,
    });
    first.unmount();

    const again = setup();
    render(<>{again.result.current?.tutorial}</>);
    const shown = mocks.track.mock.calls.filter(
      ([name]) => name === "eval_tutorial_shown",
    );
    expect(shown).toHaveLength(1);
  });

  it("opens it from the menu every time", () => {
    localStorage.setItem(HOW_SUITES_WORK_SEEN_KEY, "1");
    const { result } = setup();
    act(() => result.current?.header.onOpenTutorial?.());
    render(<>{result.current?.tutorial}</>);
    expect(mocks.track).toHaveBeenCalledWith("eval_tutorial_shown", {
      location: "evaluate",
      trigger: "menu",
      step: 1,
    });
  });

  it("opens it when the first suite appears, if no visit opened it", () => {
    const { result, rerender } = setup({
      addressRoute: { type: "create" },
      suiteCount: null,
    });
    rerender({
      enabled: true,
      addressRoute: { type: "create" },
      suiteCount: 0,
    });
    rerender({
      enabled: true,
      addressRoute: { type: "suite-overview", suiteId: "s1" },
      suiteCount: 1,
    });
    render(<>{result.current?.tutorial}</>);
    expect(mocks.track).toHaveBeenCalledWith("eval_tutorial_shown", {
      location: "evaluate",
      trigger: "first_suite",
      step: 1,
    });
  });
});
