import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/error-reporting", () => ({
  reportBoundaryError: vi.fn(),
  reportCaught: vi.fn(),
}));

import { ErrorBoundary } from "@/components/ui/error-boundary";

/**
 * Smoke test for the burned-down `fallback={null}` sites: the point of the
 * change is that a thrown child leaves the user with *something* to read
 * instead of an unexplained gap. This asserts the shape those call sites now
 * use rather than re-mounting the full billing tree (which needs Convex).
 */
describe("quiet-but-visible boundary fallbacks", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  function Boom(): React.ReactElement {
    throw new Error("query not deployed");
  }

  it("renders the muted top-up notice instead of nothing", () => {
    render(
      <ErrorBoundary
        name="credit_balance_topup_button"
        fallback={
          <span className="self-center text-xs text-muted-foreground">
            Top up unavailable
          </span>
        }
      >
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Top up unavailable")).toBeInTheDocument();
  });

  it("renders a retryable ErrorCard for the billing panels", async () => {
    const { ErrorCard } = await import("@/components/ui/error-card");
    const onRetry = vi.fn();

    render(
      <ErrorBoundary
        name="org_billing_credit_balance"
        fallback={({ error }) => <ErrorCard error={error} onRetry={onRetry} />}
      >
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
