import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { EvaluateLegacyRedirect as Redirect } from "../evaluate-legacy-redirect";

/** Fresh module per test: whether the first load is over is module state. */
let EvaluateLegacyRedirect: typeof Redirect;
beforeEach(async () => {
  vi.resetModules();
  ({ EvaluateLegacyRedirect } = await import("../evaluate-legacy-redirect"));
});

const flag = vi.hoisted(() => ({ value: undefined as boolean | undefined }));
const track = vi.hoisted(() => vi.fn());
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => flag.value,
  usePostHog: () => undefined,
  useActiveFeatureFlags: () => undefined,
}));
vi.mock("@/lib/analytics", () => ({ track }));

const project = "/p/k5700000000000000000000000a";

function renderAt(url: string) {
  const routes = [
    {
      path: "evaluate/*",
      element: (
        <EvaluateLegacyRedirect>
          <p>page</p>
        </EvaluateLegacyRedirect>
      ),
    },
  ];
  const router = createMemoryRouter(
    [...routes, { path: "p/:projectId", children: routes }],
    { initialEntries: [url] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  cleanup();
  flag.value = undefined;
  track.mockClear();
});

describe("EvaluateLegacyRedirect", () => {
  it.each(["", project])(
    "sends an old link to the new page with the flag on (%s)",
    async (scope) => {
      flag.value = true;
      const router = renderAt(`${scope}/evaluate/suite/s_1/runs/r_1?case=c_1`);
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(
          `${scope}/evaluate/suite/s_1/runs/r_1/cases/c_1`,
        ),
      );
      expect(router.state.historyAction).toBe("REPLACE");
      expect(router.state.location.state).toEqual({
        evalNavArrival: "redirect",
      });
      expect(track).toHaveBeenCalledWith("eval_nav_redirected", {
        location: "evaluate_nav",
        from_kind: "run-case",
        to_kind: "test-run",
        matched: true,
      });
      router.dispose();
    },
  );

  it("sends a new link to today's page with the flag off", async () => {
    flag.value = false;
    const router = renderAt(`${project}/evaluate/suite/s_1/settings/cases/c_1`);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `${project}/evaluate/suite/s_1/test/c_1/edit`,
      ),
    );
    expect(track).toHaveBeenCalledWith("eval_nav_redirected", {
      location: "evaluate_nav",
      from_kind: "case-settings",
      to_kind: "test-edit",
      matched: true,
    });
    router.dispose();
  });

  it("renders nothing until the flag loads", () => {
    const router = renderAt("/evaluate/suite/s_1/edit");
    expect(screen.queryByText("page")).toBeNull();
    expect(track).not.toHaveBeenCalled();
    router.dispose();
  });

  it("renders the page and records an address no row matches", () => {
    flag.value = true;
    const router = renderAt("/evaluate/suite/s_1/history");
    expect(screen.getByText("page")).toBeTruthy();
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("eval_nav_redirected", {
      location: "evaluate_nav",
      from_kind: "evaluate/suite/:id/:id",
      to_kind: "list",
      matched: false,
    });
    router.dispose();
  });

  it("renders the page untouched when nothing moves", () => {
    flag.value = true;
    const router = renderAt("/evaluate/suite/s_1/runs/r_1");
    expect(screen.getByText("page")).toBeTruthy();
    expect(track).not.toHaveBeenCalled();
    router.dispose();
  });

  it("redirects an in-app link without recording it once the first load is over", async () => {
    flag.value = true;
    const router = renderAt("/evaluate/suite/s_1");
    await act(() => router.navigate("/evaluate/suite/s_1/edit"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/evaluate/suite/s_1/settings",
      ),
    );
    await act(() =>
      router.navigate("/evaluate/suite/s_1/history", { replace: true }),
    );
    expect(screen.getByText("page")).toBeTruthy();
    expect(track).not.toHaveBeenCalled();
    router.dispose();
  });
});
