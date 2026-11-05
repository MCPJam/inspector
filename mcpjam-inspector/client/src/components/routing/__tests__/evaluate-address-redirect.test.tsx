import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";

const flag = vi.hoisted(() => ({ value: true as boolean | undefined }));
const query = vi.hoisted(() => vi.fn());
const trackEvalNav = vi.hoisted(() => vi.fn());

vi.mock("@/components/evaluate/nav/use-evaluate-nav-enabled", () => ({
  useEvaluateNavEnabled: () => flag.value,
}));
vi.mock("convex/react", () => ({ useConvex: () => ({ query }) }));
vi.mock(
  "@/components/evaluate/nav/eval-nav-events",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    trackEvalNav,
  }),
);

import { EVAL_NAV_ARRIVAL_STATE_KEY } from "@/components/evaluate/nav/eval-nav-events";
import { NAV_FLAG_WAIT_MS as FLAG_WAIT_MS } from "@/components/evaluate/nav/use-settled-evaluate-nav-flag";
import { EvaluateAddressRedirect } from "../evaluate-address-redirect";

const project = "/p/k5700000000000000000000000a";

function open(entry: string) {
  const page = (
    <EvaluateAddressRedirect>
      <div>Evaluate page</div>
    </EvaluateAddressRedirect>
  );
  const routes = [{ path: "evaluate/*", element: page }];
  const router = createMemoryRouter(
    [...routes, { path: "p/:projectId", children: routes }],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  const href = () => {
    const { pathname, search, hash } = router.state.location;
    return `${pathname}${search}${hash}`;
  };
  return { router, href };
}

beforeEach(() => {
  flag.value = true;
  query.mockReset();
  trackEvalNav.mockReset();
});
afterEach(cleanup);

describe("EvaluateAddressRedirect", () => {
  it("moves an old address to its new page with the flag on", async () => {
    const { router, href } = open(
      `${project}/evaluate/suite/S/runs/R?case=C#trace`,
    );
    await waitFor(() =>
      expect(href()).toBe(`${project}/evaluate/suite/S/runs/R/cases/C#trace`),
    );
    expect(router.state.historyAction).toBe("REPLACE");
    expect(router.state.location.state).toEqual({
      [EVAL_NAV_ARRIVAL_STATE_KEY]: "redirect",
    });
    expect(trackEvalNav).toHaveBeenCalledTimes(1);
    expect(trackEvalNav).toHaveBeenCalledWith("eval_nav_redirected", {
      from_kind: "run-case",
      to_kind: "test-run",
      matched: true,
    });
    await screen.findByText("Evaluate page");
    router.dispose();
  });

  it("moves a new address to today's page with the flag off", async () => {
    flag.value = false;
    const { router, href } = open(
      "/evaluate/suite/S/settings/cases/C/evaluators",
    );
    await waitFor(() =>
      expect(href()).toBe("/evaluate/suite/S/test/C/edit?checks=1"),
    );
    expect(router.state.location.state).toEqual({
      evalNavArrival: "redirect",
    });
    expect(trackEvalNav).toHaveBeenCalledWith("eval_nav_redirected", {
      from_kind: "case-evaluators",
      to_kind: "test-edit",
      matched: true,
    });
    router.dispose();
  });

  it("finds the case of an iteration link that does not name one", async () => {
    query.mockResolvedValue({ _id: "I", testCaseId: "C", suiteRunId: "R" });
    const { router, href } = open(
      "/evaluate/suite/S/runs/R?iteration=I&project=P",
    );
    expect(screen.queryByText("Evaluate page")).toBeNull();
    await waitFor(() =>
      expect(href()).toBe("/evaluate/suite/S/runs/R/cases/C/iter/I?project=P"),
    );
    expect(query).toHaveBeenCalledWith("testSuites:getTestIteration", {
      iterationId: "I",
    });
    expect(trackEvalNav).toHaveBeenCalledWith("eval_nav_redirected", {
      from_kind: "run-iteration-no-case",
      to_kind: "iteration",
      matched: true,
    });
    router.dispose();
  });

  it("keeps today's address and reports it when the iteration cannot be read", async () => {
    query.mockRejectedValue(new Error("Iteration not found or unauthorized"));
    const { router, href } = open("/evaluate/suite/S/runs/R?iteration=I");
    await screen.findByText("Evaluate page");
    expect(href()).toBe("/evaluate/suite/S/runs/R?iteration=I");
    expect(router.state.location.state).toBeNull();
    expect(trackEvalNav).toHaveBeenCalledWith("eval_nav_redirected", {
      from_kind: "run-iteration-no-case",
      to_kind: "run-detail",
      matched: false,
    });
    router.dispose();
  });

  it("renders addresses that need no rewrite without waiting for the flag", async () => {
    flag.value = undefined;
    const { router } = open("/evaluate/suite/S/runs/R");
    await screen.findByText("Evaluate page");
    expect(trackEvalNav).not.toHaveBeenCalled();
    router.dispose();
  });

  it("waits for the flag on an address it may rewrite, then reads a missing flag as off", async () => {
    vi.useFakeTimers();
    try {
      flag.value = undefined;
      const { router, href } = open("/evaluate/suite/S/settings");
      expect(screen.queryByText("Evaluate page")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(FLAG_WAIT_MS);
      });
      expect(href()).toBe("/evaluate/suite/S/edit");
      router.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
