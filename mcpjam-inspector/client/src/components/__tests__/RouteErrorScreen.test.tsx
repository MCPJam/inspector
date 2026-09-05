import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

const { reportCaught } = vi.hoisted(() => ({ reportCaught: vi.fn() }));
vi.mock("@/lib/error-reporting", () => ({
  reportCaught,
  reportBoundaryError: vi.fn(),
}));

import { RouteErrorScreen } from "../RouteErrorScreen";

function renderCrashingRoute(message = "route exploded") {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <ThrowingRoute message={message} />,
        errorElement: <RouteErrorScreen />,
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

function ThrowingRoute({ message }: { message: string }): React.ReactElement {
  throw new Error(message);
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

  it("reloads once and explains itself when a lazy chunk is gone", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    window.sessionStorage.clear();

    renderCrashingRoute(
      "Failed to fetch dynamically imported module: https://staging.mcpjam.com/assets/highlighted-body-OFNGDK62-BtUjfQ3T.js",
    );
    await screen.findByTestId("route-error-screen");

    expect(reload).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/MCPJam was updated while this tab was open/),
    ).toBeInTheDocument();
    expect(reportCaught).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "stale_chunk", level: "warning" }),
    );
  });
});
