import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { setAppRouter } from "../../../../router-ref";
import {
  evalNavArrivalOf,
  navigateEvalNav,
  openEvalNavPage,
  useEvalNavBack,
  useEvalNavPageViewed,
} from "../eval-nav-link";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track }));

function RunPage({ enabled = true }: { enabled?: boolean }) {
  useEvalNavPageViewed("suite-run", enabled);
  const back = useEvalNavBack({
    label: "suite",
    route: { type: "suite-overview", suiteId: "s1" },
  });
  return (
    <button type="button" onClick={back.go}>
      {back.label}
    </button>
  );
}

function mount(initial: string, enabled = true) {
  const router = createMemoryRouter(
    [
      { path: "/evaluate/runs", element: <p>Runs tab</p> },
      { path: "/evaluate/suite/:suite", element: <p>Suite page</p> },
      {
        path: "/evaluate/suite/:suite/runs/:run",
        element: <RunPage enabled={enabled} />,
      },
    ],
    { initialEntries: [initial] },
  );
  setAppRouter(router);
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  setAppRouter(null);
  track.mockClear();
});

describe("eval nav links", () => {
  it("opens a page that goes Back to where the link was followed from", async () => {
    const router = mount("/evaluate/runs");
    await act(async () => {
      openEvalNavPage(
        { type: "run-detail", suiteId: "s1", runId: "r1" },
        "runs",
      );
    });
    expect(router.state.location.pathname).toBe("/evaluate/suite/s1/runs/r1");
    expect(track).toHaveBeenCalledWith("eval_nav_page_viewed", {
      page: "suite-run",
      arrived_via: "link",
      location: "evaluate",
    });

    await act(async () => {
      screen.getByRole("button", { name: "Back to runs" }).click();
    });
    expect(router.state.location.pathname).toBe("/evaluate/runs");
  });

  it("falls back to the parent page when opened directly", async () => {
    const router = mount("/evaluate/suite/s1/runs/r1");
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("eval_nav_page_viewed", {
      page: "suite-run",
      arrived_via: "direct",
      location: "evaluate",
    });
    await act(async () => {
      screen.getByRole("button", { name: "Back to suite" }).click();
    });
    expect(router.state.location.pathname).toBe("/evaluate/suite/s1");
  });

  it("counts no page view with the flag off", () => {
    mount("/evaluate/suite/s1/runs/r1", false);
    expect(track).not.toHaveBeenCalled();
  });

  it("tags a crumb, and counts a history move as back", async () => {
    const router = mount("/evaluate/runs");
    await act(async () => {
      navigateEvalNav(
        { type: "run-detail", suiteId: "s1", runId: "r1" },
        { via: "crumb" },
      );
    });
    await act(async () => {
      void router.navigate("/evaluate/runs");
    });
    await act(async () => {
      void router.navigate(-1);
    });
    expect(track.mock.calls.map(([, props]) => props.arrived_via)).toEqual([
      "crumb",
      "back",
    ]);
  });
});

describe("evalNavArrivalOf", () => {
  it("reads history moves first, then the navigation's tag", () => {
    expect(evalNavArrivalOf(null, "POP", false)).toBe("direct");
    expect(evalNavArrivalOf({ evalNavArrival: "link" }, "POP", true)).toBe(
      "back",
    );
    expect(
      evalNavArrivalOf({ evalNavArrival: "redirect" }, "REPLACE", false),
    ).toBe("redirect");
    expect(evalNavArrivalOf({ evalNavArrival: "bogus" }, "PUSH", true)).toBe(
      "link",
    );
    expect(evalNavArrivalOf(null, "PUSH", true)).toBe("link");
  });
});
