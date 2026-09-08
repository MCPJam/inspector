import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { NotFoundRoute } from "../not-found-route";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const A = "k5700000000000000000000000a";

function renderAt(initialEntry: string) {
  const router = createMemoryRouter(
    [{ path: "*", element: <NotFoundRoute /> }],
    { initialEntries: [initialEntry] }
  );
  render(<RouterProvider router={router} />);
  return router;
}

/**
 * These assertions wait on a real chain — effect → `navigate` → re-render —
 * and RTL's 1s default is tuned for an idle machine. CI runs four shards on a
 * contended runner, where that chain has taken longer than a second: the
 * failure showed the spinner still up and the URL not yet rewritten, i.e. the
 * right outcome that had not arrived yet. Fail slow, not flaky.
 */
const NAVIGATION_TIMEOUT = { timeout: 5_000 } as const;

describe("NotFoundRoute", () => {
  it("keeps the unknown URL rather than rewriting it", () => {
    // The catch-all used to render Connect, so a typo or a truncated link
    // looked like a successful navigation.
    const router = renderAt("/nope/not-a-route");
    expect(screen.getByTestId("route-not-found")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/nope/not-a-route");
  });

  it("goes home unscoped from an unscoped unknown URL", async () => {
    const router = renderAt("/nope/not-a-route");
    fireEvent.click(screen.getByRole("button", { name: /go home/i }));
    await waitFor(
      () => expect(router.state.location.pathname).toBe("/"),
      NAVIGATION_TIMEOUT
    );
  });

  it("goes to project home from an unknown URL inside a real project", async () => {
    // The project in the URL is valid here — only the screen is missing — so
    // the way out stays in that project rather than dumping the user at the
    // app root and re-resolving a project from storage.
    const router = renderAt(`/p/${A}/nope`);
    fireEvent.click(screen.getByRole("button", { name: /go home/i }));
    await waitFor(
      () => expect(router.state.location.pathname).toBe(`/p/${A}/home`),
      NAVIGATION_TIMEOUT
    );
  });
});
