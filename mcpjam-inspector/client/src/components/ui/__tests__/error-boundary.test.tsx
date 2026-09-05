import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// `vi.hoisted` because the vi.mock factory is lifted above this declaration.
// The arrow-wrapper form also works, but every other suite here uses hoisted —
// keep one idiom.
const { reportBoundaryError, reportCaught } = vi.hoisted(() => ({
  reportBoundaryError: vi.fn(),
  reportCaught: vi.fn(),
}));
vi.mock("@/lib/error-reporting", () => ({
  reportBoundaryError,
  reportCaught,
}));

import { ErrorBoundary } from "../error-boundary";

function Boom({
  shouldThrow,
  message = "kaboom",
}: {
  shouldThrow: boolean;
  message?: string;
}): React.ReactElement {
  if (shouldThrow) throw new Error(message);
  return <div>recovered</div>;
}

describe("ErrorBoundary", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reportBoundaryError.mockReset();
    reportCaught.mockReset();
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

  it("does NOT report an error its boundary declared expected", () => {
    // UVH-IN5. A dark-shipped query throws on a page users open repeatedly,
    // so an unconditional report turns a documented, intended state into one
    // Sentry issue and one PostHog event per visit.
    render(
      <ErrorBoundary
        name="expected_boundary"
        fallback={null}
        isExpectedError={(error) => error.message === "kaboom"}
      >
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    expect(reportBoundaryError).not.toHaveBeenCalled();
  });

  it("still reports an error the SAME boundary did not expect", () => {
    // The predicate is the whole point: a boundary that suppressed everything
    // would swallow the real bug it exists to surface.
    render(
      <ErrorBoundary
        name="expected_boundary"
        fallback={null}
        isExpectedError={(error) => error.message === "something else"}
      >
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
  });

  it("still calls onError for an expected error — telemetry only is suppressed", () => {
    // The probe that motivated this uses `onError` to close its rail. Losing
    // that alongside the reporting would trade a noisy alarm for a stuck UI.
    const onError = vi.fn();
    render(
      <ErrorBoundary
        fallback={null}
        isExpectedError={() => true}
        onError={onError}
      >
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    expect(reportBoundaryError).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports normally when the predicate itself throws", () => {
    // Fail loud, not silent: a broken predicate must not become a way to lose
    // errors, which is the one outcome worse than the noise this suppresses.
    render(
      <ErrorBoundary
        fallback={null}
        isExpectedError={() => {
          throw new Error("predicate is broken");
        }}
      >
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
    expect((reportBoundaryError.mock.calls[0][0] as Error).message).toBe(
      "kaboom",
    );
  });

  it("reloads once for a chunk the deploy no longer serves, instead of blaming the subtree", () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    window.sessionStorage.clear();

    render(
      <ErrorBoundary name="lazy_boundary">
        <Boom
          shouldThrow
          message="Failed to fetch dynamically imported module: /assets/highlighted-body-OFNGDK62-BtUjfQ3T.js"
        />
      </ErrorBoundary>,
    );

    expect(reload).toHaveBeenCalledTimes(1);
    expect(reportBoundaryError).not.toHaveBeenCalled();
    expect(reportCaught).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "stale_chunk", level: "warning" }),
    );
    expect(
      screen.getByText(/MCPJam was updated while this tab was open/),
    ).toBeInTheDocument();
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
