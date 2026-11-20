import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AppRouteReactContext } from "@/lib/app-route-context";
import { ProjectRouteBoundary } from "../project-route-boundary";
import type { ProjectRouteState } from "@/lib/project-route-state";
import { readAppSignInReturnPath } from "@/lib/app-signin-return-path";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const authState = vi.hoisted(() => ({
  user: null as { id: string } | null,
  isLoading: false,
  signIn: vi.fn(),
}));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => authState }));
const dbUser = vi.hoisted(() => ({ ready: true }));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => dbUser.ready,
}));

const requestAccess = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({ useMutation: () => requestAccess }));

const A = "k5700000000000000000000000a";

function renderBoundary(projectRouteState: ProjectRouteState | undefined, projectTransitionPending = false) {
  const router = createMemoryRouter(
    [
      {
        path: "/p/:projectId",
        element: (
          <AppRouteReactContext.Provider value={{ projectRouteState, projectTransitionPending }}>
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
    { initialEntries: [`/p/${A}`] },
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
  beforeEach(() => {
    authState.user = null;
    authState.isLoading = false;
    authState.signIn.mockReset();
    dbUser.ready = true;
    requestAccess.mockReset();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

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

  it("shows the MCPJam spinner instead of an unavailable page during sign-in recovery", () => {
    renderBoundary({status: "inaccessible", requestedProjectId: A, reason: "not-a-member"}, true);
    expect(screen.queryByTestId("project-route-inaccessible")).toBeNull();
    expect(screen.queryByTestId("project-screen")).toBeNull();
    expect(screen.getByRole("img", { name: "MCPJam" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows one generic message for an unavailable project", () => {
    // Deleted, never existed, and not yours are deliberately the same
    // message: distinguishing them would leak which project ids are real.
    renderBoundary({
      status: "inaccessible",
      requestedProjectId: A,
      reason: "not-a-member",
    });
    expect(
      screen.getByTestId("project-route-inaccessible"),
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
      reason: "not-a-member",
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
      reason: "not-a-member",
    });
    fireEvent.click(screen.getByRole("button", { name: /projects/i }));
    await waitFor(
      () => expect(router.state.location.pathname).toBe("/"),
      NAVIGATION_TIMEOUT,
    );
  });

  it("holds back the screen when no coordinator state has arrived yet", () => {
    renderBoundary(undefined);
    expect(screen.queryByTestId("project-screen")).toBeNull();
  });

  describe("asking for access", () => {
    const inaccessible = (reason: "malformed" | "not-a-member" | "timed-out") =>
      ({ status: "inaccessible", requestedProjectId: A, reason }) as const;

    it("offers guests a sign-in that returns to the same project URL", () => {
      // The browser router keeps window.location in step; the memory router
      // used here does not.
      window.history.replaceState({}, "", `/p/${A}/evals`);
      renderBoundary(inaccessible("timed-out"));
      fireEvent.click(
        screen.getByRole("button", { name: "Sign in to ask for access" }),
      );
      expect(authState.signIn).toHaveBeenCalledTimes(1);
      expect(readAppSignInReturnPath()).toBe(`/p/${A}/evals`);
      expect(screen.queryByRole("button", { name: "Ask for access" })).toBeNull();
    });

    it("sends one request for a signed-in user and then shows it as sent", async () => {
      authState.user = { id: "user_1" };
      requestAccess.mockResolvedValue({ status: "sent" });
      renderBoundary(inaccessible("not-a-member"));
      fireEvent.click(screen.getByRole("button", { name: "Ask for access" }));
      expect(requestAccess).toHaveBeenCalledWith({ projectId: A });
      const sent = await screen.findByRole("button", { name: "Request sent" });
      expect(sent).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Go to your projects" }),
      ).toBeEnabled();
    });

    it("shows a request from the last 24 hours as sent after a reload", () => {
      authState.user = { id: "user_1" };
      localStorage.setItem(
        "mcpjam-project-access-requests",
        JSON.stringify({ [`user_1:${A}`]: Date.now() - 60_000 }),
      );
      renderBoundary(inaccessible("not-a-member"));
      expect(screen.getByRole("button", { name: "Request sent" })).toBeDisabled();
    });

    it("offers a new request once the 24 hour window has passed", () => {
      authState.user = { id: "user_1" };
      localStorage.setItem(
        "mcpjam-project-access-requests",
        JSON.stringify({ [`user_1:${A}`]: Date.now() - 25 * 60 * 60 * 1000 }),
      );
      renderBoundary(inaccessible("not-a-member"));
      expect(screen.getByRole("button", { name: "Ask for access" })).toBeEnabled();
    });

    it("waits for the account to finish setting up before asking", () => {
      // A colleague who just signed up from the link has a WorkOS user before
      // the Convex user row exists; a request then would fail.
      authState.user = { id: "user_1" };
      dbUser.ready = false;
      renderBoundary(inaccessible("not-a-member"));
      const button = screen.getByRole("button", { name: "Ask for access" });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(requestAccess).not.toHaveBeenCalled();
    });

    it("offers a new request when the window ends while the screen is open", () => {
      vi.useFakeTimers();
      try {
        authState.user = { id: "user_1" };
        localStorage.setItem(
          "mcpjam-project-access-requests",
          JSON.stringify({
            [`user_1:${A}`]: Date.now() - (24 * 60 * 60 * 1000 - 60_000),
          }),
        );
        renderBoundary(inaccessible("not-a-member"));
        expect(
          screen.getByRole("button", { name: "Request sent" }),
        ).toBeDisabled();
        act(() => {
          vi.advanceTimersByTime(60_001);
        });
        expect(
          screen.getByRole("button", { name: "Ask for access" }),
        ).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("looks the same whatever the reason the project did not resolve", () => {
      // Deleted, unknown and malformed ids must not be told apart here.
      authState.user = { id: "user_1" };
      const snapshots = (["malformed", "not-a-member", "timed-out"] as const).map(
        (reason) => {
          renderBoundary(inaccessible(reason));
          const html = screen.getByTestId("project-route-inaccessible").outerHTML;
          cleanup();
          return html;
        },
      );
      expect(new Set(snapshots).size).toBe(1);
    });
  });
});
