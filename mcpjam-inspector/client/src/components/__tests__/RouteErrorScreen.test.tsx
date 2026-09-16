import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

const { reportCaught } = vi.hoisted(() => ({ reportCaught: vi.fn() }));
// Only the reporting module is stubbed. `isAuthorizationRefusal` lives in its
// own module and is left REAL on purpose: the whole point of BB-250 is that the
// screen and the error sinks agree about what counts as a refusal, and a stub
// here would let them drift and still pass.
vi.mock("@/lib/error-reporting", () => ({
  reportCaught,
  reportBoundaryError: vi.fn(),
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
