import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const reportBoundaryError = vi.fn();
vi.mock("@/lib/error-reporting", () => ({
  reportBoundaryError: (...args: unknown[]) => reportBoundaryError(...args),
  reportCaught: vi.fn(),
}));

import { ErrorBoundary } from "../error-boundary";

function Boom({ shouldThrow }: { shouldThrow: boolean }): React.ReactElement {
  if (shouldThrow) throw new Error("kaboom");
  return <div>recovered</div>;
}

describe("ErrorBoundary", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reportBoundaryError.mockReset();
    // React logs caught boundary errors; silence it so the suite output stays
    // readable without hiding real failures.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => consoleError.mockRestore());

  it("reports the caught error once, with the component stack and boundary name", () => {
    render(
      <ErrorBoundary name="unit_boundary">
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
    const [error, info, name] = reportBoundaryError.mock.calls[0];
    expect((error as Error).message).toBe("kaboom");
    expect(typeof (info as { componentStack: string }).componentStack).toBe(
      "string",
    );
    expect(name).toBe("unit_boundary");
  });

  it("reports even when the fallback renders nothing", () => {
    const { container } = render(
      <ErrorBoundary fallback={null}>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    expect(container).toBeEmptyDOMElement();
    // The whole point of the change: a silent UI is not a silent telemetry.
    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
  });

  it("still calls a caller-supplied onError alongside reporting", () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
  });

  it("renders a function fallback with error + reset, and reset clears the boundary", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [shouldThrow, setShouldThrow] = React.useState(true);
      return (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <div>
              <span>caught: {error?.message}</span>
              <button
                onClick={() => {
                  setShouldThrow(false);
                  reset();
                }}
              >
                retry
              </button>
            </div>
          )}
        >
          <Boom shouldThrow={shouldThrow} />
        </ErrorBoundary>
      );
    }

    render(<Harness />);
    expect(screen.getByText(/caught: kaboom/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "retry" }));
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });

  it("renders the default UI and does not report when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("recovered")).toBeInTheDocument();
    expect(reportBoundaryError).not.toHaveBeenCalled();
  });
});
