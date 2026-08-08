import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because both vi.mock factories are lifted above these
// declarations.
const { captureException, posthogCaptureException } = vi.hoisted(() => ({
  captureException: vi.fn(),
  posthogCaptureException: vi.fn(),
}));

vi.mock("@sentry/react", () => ({ captureException }));
vi.mock("posthog-js", () => ({
  default: { captureException: posthogCaptureException },
}));

import { reportBoundaryError, reportCaught } from "../error-reporting";

describe("reportCaught", () => {
  beforeEach(() => {
    captureException.mockReset();
    posthogCaptureException.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it("sends the error to both sinks exactly once", () => {
    const error = new Error("boom");
    reportCaught(error, { source: "unit" });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ level: "error", tags: { source: "unit" } }),
    );
    expect(posthogCaptureException).toHaveBeenCalledTimes(1);
    expect(posthogCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ source: "unit" }),
    );
  });

  it("normalizes non-Error throws into an Error", () => {
    reportCaught("just a string", { source: "unit" });
    const [captured] = captureException.mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("just a string");
  });

  it("carries level and extra through", () => {
    reportCaught(new Error("x"), {
      source: "unit",
      level: "warning",
      extra: { step: 3 },
    });
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: "warning", extra: { step: 3 } }),
    );
  });

  it("never throws when a sink is broken", () => {
    captureException.mockImplementation(() => {
      throw new Error("sentry is down");
    });
    posthogCaptureException.mockImplementation(() => {
      throw new Error("posthog is blocked");
    });

    expect(() =>
      reportCaught(new Error("x"), { source: "unit" }),
    ).not.toThrow();
  });
});

describe("reportBoundaryError", () => {
  beforeEach(() => {
    captureException.mockReset();
    posthogCaptureException.mockReset();
  });

  it("namespaces the source by boundary name and keeps the component stack", () => {
    reportBoundaryError(
      new Error("render blew up"),
      {
        componentStack: "\n  at Billing\n  at App",
      },
      "org_billing",
    );

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { source: "react_boundary:org_billing" },
        extra: expect.objectContaining({
          componentStack: "\n  at Billing\n  at App",
          boundary: "org_billing",
        }),
      }),
    );
  });

  it("falls back to an unnamed source for boundaries with no name", () => {
    reportBoundaryError(new Error("x"), { componentStack: null });
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { source: "react_boundary" } }),
    );
  });
});
