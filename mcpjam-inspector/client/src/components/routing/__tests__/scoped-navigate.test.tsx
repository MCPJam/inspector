import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ScopedNavigate } from "../scoped-navigate";

const P = "k5700000000000000000000000a";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

function renderInRouter(state?: unknown) {
  const router = createMemoryRouter(
    [
      {
        path: "p/:projectId/from",
        element: <ScopedNavigate to="/evaluate" replace state={state} />,
      },
      { path: "p/:projectId/evaluate", element: <div>Target</div> },
    ],
    { initialEntries: [`/p/${P}/from`] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("ScopedNavigate state", () => {
  it("puts state on the target entry inside a router", async () => {
    const router = renderInRouter({ evalNav: { via: "redirect" } });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/p/${P}/evaluate`),
    );
    expect(router.state.location.state).toEqual({
      evalNav: { via: "redirect" },
    });
    router.dispose();
  });

  it("keeps today's behaviour without state", async () => {
    const router = renderInRouter();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/p/${P}/evaluate`),
    );
    expect(router.state.location.state).toBeNull();
    expect(router.state.historyAction).toBe("REPLACE");
    router.dispose();
  });

  it("writes state through the history fallback without a router", async () => {
    window.history.replaceState({}, "", `/p/${P}/from`);
    render(
      <ScopedNavigate
        to="/evaluate"
        replace
        state={{ evalNav: { via: "redirect" } }}
      />,
    );
    await waitFor(() =>
      expect(window.location.pathname).toBe(`/p/${P}/evaluate`),
    );
    expect(window.history.state).toEqual({ evalNav: { via: "redirect" } });
  });
});
