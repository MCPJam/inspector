import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

const { reportCaught, signInMock, track, captureAppSignInReturnPath } =
  vi.hoisted(() => ({
    reportCaught: vi.fn(),
    signInMock: vi.fn(),
    track: vi.fn(),
    captureAppSignInReturnPath: vi.fn(),
  }));
// Only the reporting module is stubbed. `isAuthorizationRefusal` lives in its
// own module and is left REAL on purpose: the whole point of BB-250 is that the
// screen and the error sinks agree about what counts as a refusal, and a stub
// here would let them drift and still pass.
vi.mock("@/lib/error-reporting", () => ({
  reportCaught,
  reportBoundaryError: vi.fn(),
}));

// Mutable so each test can pick the viewer: signed in, signed out, or still
// resolving. Same shape as `login-initiation-route.test.tsx`.
let authState: { user: unknown; isLoading: boolean } = {
  user: { id: "user_1" },
  isLoading: false,
};
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ ...authState, signIn: signInMock }),
}));

// Analytics goes through lib/analytics.ts#track (the ratchet forbids raw
// posthog.capture in components); mock it to assert the surface tag.
vi.mock("@/lib/analytics", () => ({ track }));
vi.mock("@/lib/app-signin-return-path", () => ({
  captureAppSignInReturnPath,
}));
vi.mock("@/lib/permalink-signin-return", () => ({
  permalinkSignInOptions: () => ({ state: "permalink" }),
}));

import { ConvexError } from "convex/values";
import { RouteErrorScreen } from "../RouteErrorScreen";

function renderRouteThrowing(thrown: unknown) {
  function Route(): React.ReactElement {
    throw thrown;
  }
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <Route />,
        errorElement: <RouteErrorScreen />,
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

function renderCrashingRoute() {
  return renderRouteThrowing(new Error("route exploded"));
}

/**
 * What `requireProjectRole` raises once it reaches the browser: Convex
 * reconstructs the `ConvexError` on the client from its `data` payload.
 */
function membershipRefusal() {
  return new ConvexError({
    kind: "forbidden",
    message: "Not a member of this project",
  });
}

describe("RouteErrorScreen", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reportCaught.mockReset();
    signInMock.mockReset();
    track.mockReset();
    captureAppSignInReturnPath.mockReset();
    // Default viewer is SIGNED IN, so the existing membership-refusal tests
    // keep describing the member case.
    authState = { user: { id: "user_1" }, isLoading: false };
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => consoleError.mockRestore());

  it("renders instead of a blank page when a route throws", async () => {
    renderCrashingRoute();

    expect(await screen.findByTestId("route-error-screen")).toBeInTheDocument();
    expect(screen.getByText("route exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go home" })).toBeInTheDocument();
  });

  it("reports the route error exactly once", async () => {
    renderCrashingRoute();
    await screen.findByTestId("route-error-screen");

    expect(reportCaught).toHaveBeenCalledTimes(1);
    expect(reportCaught).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "route_error_element" }),
    );
  });

  describe("membership refusals (BB-250)", () => {
    it("renders the access-denied screen, not the crash screen", async () => {
      renderRouteThrowing(membershipRefusal());

      expect(
        await screen.findByTestId("route-access-denied-screen"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("route-error-screen"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("You don't have access to this"),
      ).toBeInTheDocument();
    });

    it("never shows the raw refusal or a stack trace to the user", async () => {
      renderRouteThrowing(membershipRefusal());
      await screen.findByTestId("route-access-denied-screen");

      // The literal backend prose and the serialized payload both stay off
      // screen. This is the screenshot on the ticket: a file path and a line
      // number rendered as user-facing copy.
      expect(
        screen.queryByText(/Not a member of this project/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/authorization\.ts/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Server Error/)).not.toBeInTheDocument();
    });

    it("does not confirm that the resource exists", async () => {
      renderRouteThrowing(membershipRefusal());
      await screen.findByTestId("route-access-denied-screen");

      // The backend gives ONE opaque answer for "missing" and "not yours" so a
      // probe cannot enumerate ids. Copy that asserted the thing exists would
      // hand that oracle back, so the disjunction is load-bearing.
      expect(screen.getByText(/or it no longer exists/i)).toBeInTheDocument();
    });

    it("offers no Reload, since the answer will not change", async () => {
      renderRouteThrowing(membershipRefusal());
      await screen.findByTestId("route-access-denied-screen");

      expect(
        screen.queryByRole("button", { name: "Reload" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Go home" }),
      ).toBeInTheDocument();
    });

    it("does not report the refusal to the error sinks", async () => {
      renderRouteThrowing(membershipRefusal());
      await screen.findByTestId("route-access-denied-screen");

      expect(reportCaught).not.toHaveBeenCalled();
    });

    it("offers sign-in, not an invite, to a SIGNED-OUT visitor", async () => {
      // `requireUserActor` already raises `kind: 'forbidden'` for a guest on
      // `main` today, so an unauthenticated visitor lands on this screen with
      // or without the backend PR. Telling them to ask for an invite is wrong
      // advice: they may already be a member and one sign-in away.
      authState = { user: null, isLoading: false };
      renderRouteThrowing(
        new ConvexError({
          kind: "forbidden",
          message: "Authenticated user required",
        }),
      );

      expect(
        await screen.findByTestId("route-signin-required-screen"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("route-access-denied-screen"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/ask them to invite you/i),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Sign in" }),
      ).toBeInTheDocument();
    });

    it("routes a signed-out visitor through the normal return-path sign-in", async () => {
      authState = { user: null, isLoading: false };
      renderRouteThrowing(membershipRefusal());
      await screen.findByTestId("route-signin-required-screen");

      screen.getByRole("button", { name: "Sign in" }).click();

      // The copy promises they come straight back here, so the return path has
      // to be captured before the redirect — same wiring as the header control.
      expect(captureAppSignInReturnPath).toHaveBeenCalled();
      expect(signInMock).toHaveBeenCalledWith({ state: "permalink" });
      expect(track).toHaveBeenCalledWith("login_button_clicked", {
        location: "route_error_refusal",
      });
    });

    it("says nothing about the resource to a signed-out visitor either", async () => {
      // The split must not leak what the opaque membership copy protects.
      authState = { user: null, isLoading: false };
      renderRouteThrowing(membershipRefusal());
      await screen.findByTestId("route-signin-required-screen");

      expect(
        screen.queryByText(/Not a member of this project/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/project/i)).not.toBeInTheDocument();
    });

    it("keeps the member copy while auth is still resolving", async () => {
      // AuthKit reports no user mid-resolution. Showing a signed-in member a
      // sign-in button is the worse of the two wrong answers, so `isLoading`
      // counts as "not yet signed out".
      authState = { user: null, isLoading: true };
      renderRouteThrowing(membershipRefusal());

      expect(
        await screen.findByTestId("route-access-denied-screen"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("route-signin-required-screen"),
      ).not.toBeInTheDocument();
    });

    it("does not report the guest refusal either", async () => {
      authState = { user: null, isLoading: false };
      renderRouteThrowing(
        new ConvexError({
          kind: "forbidden",
          message: "Authenticated user required",
        }),
      );
      await screen.findByTestId("route-signin-required-screen");

      expect(reportCaught).not.toHaveBeenCalled();
    });

    it("still crashes loudly for a ConvexError that is NOT a refusal", async () => {
      // The gate is narrow on purpose: an untagged `ConvexError` is a fault and
      // must keep paging. A fix that quieted every `ConvexError` would hide
      // real bugs behind a friendly screen.
      renderRouteThrowing(new ConvexError({ message: "genuinely broken" }));

      expect(
        await screen.findByTestId("route-error-screen"),
      ).toBeInTheDocument();
      expect(reportCaught).toHaveBeenCalledTimes(1);
    });
  });
});
