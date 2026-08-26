import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AppRouteReactContext } from "@/lib/app-route-context";
import { LegacyProjectRouteNormalizer } from "../legacy-project-route-normalizer";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const A = "k5700000000000000000000000a";
const B = "k5700000000000000000000000b";

function renderAt(initialEntry: string, context: Record<string, unknown>) {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <AppRouteReactContext.Provider value={context}>
            <LegacyProjectRouteNormalizer>
              <div data-testid="legacy-screen">servers</div>
            </LegacyProjectRouteNormalizer>
          </AppRouteReactContext.Provider>
        ),
      },
    ],
    { initialEntries: [initialEntry] }
  );
  render(<RouterProvider router={router} />);
  return { router };
}

const resolved = {
  activeProjectId: A,
  isAuthenticated: true,
  isAuthLoading: false,
  isLoadingRemoteProjects: false,
};

function currentPath(router: ReturnType<typeof createMemoryRouter>): string {
  const { pathname, search, hash } = router.state.location;
  return `${pathname}${search}${hash}`;
}

describe("LegacyProjectRouteNormalizer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rewrites an unscoped path onto the viewer's project", async () => {
    const { router } = renderAt("/servers", resolved);
    await waitFor(() => expect(currentPath(router)).toBe(`/p/${A}/servers`));
  });

  it("prefers the link's ?project= over the viewer's persisted default", async () => {
    // The parameter is the whole reason the old link was minted that way: the
    // sender chose the project, so it beats whatever the reader was parked on.
    const { router } = renderAt(
      `/evals/suite/X?project=${B}&view=runs#case`,
      resolved
    );
    await waitFor(() =>
      expect(currentPath(router)).toBe(`/p/${B}/evals/suite/X?view=runs#case`)
    );
  });

  it("never renders the destination screen before the project is known", () => {
    // The regression this component exists to prevent: the screen used to
    // render immediately, against whatever project the viewer was on.
    renderAt("/servers", {
      activeProjectId: null,
      isAuthenticated: true,
      isAuthLoading: false,
      isLoadingRemoteProjects: true,
    });
    expect(screen.queryByTestId("legacy-screen")).toBeNull();
  });

  it("renders unscoped when there is no project at all", async () => {
    // First run, a local inspector with no Convex, a signed-out visitor.
    // Onboarding must not be held behind a project that will never resolve.
    renderAt("/servers", {
      activeProjectId: null,
      isAuthenticated: false,
      isAuthLoading: false,
      isLoadingRemoteProjects: false,
    });
    await waitFor(() =>
      expect(screen.getByTestId("legacy-screen")).toBeInTheDocument()
    );
  });

  it("treats the local placeholder as no project", async () => {
    renderAt("/servers", { ...resolved, activeProjectId: "none" });
    await waitFor(() =>
      expect(screen.getByTestId("legacy-screen")).toBeInTheDocument()
    );
  });

  it("strips a malformed ?project= instead of letting it linger", async () => {
    // Left in place it would keep suppressing first-run onboarding while the
    // app waits for a project that cannot resolve.
    const { router } = renderAt("/servers?project=oops&keep=1", {
      activeProjectId: null,
      isAuthenticated: false,
      isAuthLoading: false,
      isLoadingRemoteProjects: false,
    });
    await waitFor(() => expect(currentPath(router)).toBe("/servers?keep=1"));
    expect(screen.getByTestId("legacy-screen")).toBeInTheDocument();
  });

  it("normalizes once and does not loop", async () => {
    const { router } = renderAt("/servers?a=1#b", resolved);
    await waitFor(() =>
      expect(currentPath(router)).toBe(`/p/${A}/servers?a=1#b`)
    );
    const settled = currentPath(router);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(currentPath(router)).toBe(settled);
  });
});
