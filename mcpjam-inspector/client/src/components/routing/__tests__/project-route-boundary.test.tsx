import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AppRouteReactContext } from "@/lib/app-route-context";
import { ProjectRouteBoundary } from "../project-route-boundary";
import type { ProjectRouteState } from "@/lib/project-route-state";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const A = "k5700000000000000000000000a";

function renderBoundary(projectRouteState: ProjectRouteState | undefined) {
  const router = createMemoryRouter(
    [
      {
        path: "/p/:projectId",
        element: (
          <AppRouteReactContext.Provider value={{ projectRouteState }}>
            <ProjectRouteBoundary />
          </AppRouteReactContext.Provider>
        ),
        children: [
          {
            index: true,
            element: <div data-testid="project-screen">servers</div>,
          },
        ],
      },
    ],
    { initialEntries: [`/p/${A}`] }
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

describe("ProjectRouteBoundary", () => {
  it("renders the project screen only once the project is ready", () => {
    renderBoundary({ status: "ready", projectId: A });
    expect(screen.getByTestId("project-screen")).toBeInTheDocument();
  });

  it("renders nothing project-owned while resolving", () => {
    // Rendering the screen here would show one project's data under another
    // project's address for as long as the switch takes.
    renderBoundary({ status: "resolving", requestedProjectId: A });
    expect(screen.queryByTestId("project-screen")).toBeNull();
  });

  it("shows one generic message for an unavailable project", () => {
    // Deleted, never existed, and not yours are deliberately the same
    // message: distinguishing them would leak which project ids are real.
    renderBoundary({ status: "inaccessible", requestedProjectId: A });
    expect(
      screen.getByTestId("project-route-inaccessible")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("project-screen")).toBeNull();
  });

  it("keeps the requested URL instead of redirecting to another project", () => {
    // Silently bouncing to a default project is how a user ends up acting on
    // data they never asked for — and it breaks "reload after being granted
    // access".
    const router = renderBoundary({
      status: "inaccessible",
      requestedProjectId: A,
    });
    expect(router.state.location.pathname).toBe(`/p/${A}`);
  });

  it("offers a way out that does not lead back into the same project", async () => {
    // The escape hatch inherits the current project under the ordinary
    // navigation rules, which would send the user from `/p/<bad>` straight
    // back to `/p/<bad>/home`. It navigates unscoped for exactly that reason.
    const router = renderBoundary({
      status: "inaccessible",
      requestedProjectId: A,
    });
    fireEvent.click(screen.getByRole("button", { name: /projects/i }));
    await waitFor(
      () => expect(router.state.location.pathname).toBe("/"),
      NAVIGATION_TIMEOUT
    );
  });

  it("holds back the screen when no coordinator state has arrived yet", () => {
    renderBoundary(undefined);
    expect(screen.queryByTestId("project-screen")).toBeNull();
  });
});
