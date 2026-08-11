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

// Default the surface ON so the existing assertions exercise the full
// fan-out; the gated cases re-mock below.
vi.mock("../PosthogUtils", () => ({
  isErrorCaptureSurface: () => true,
  isCredentialBearingPath: () => false,
}));

import {
  reportBoundaryError,
  reportCaught,
  reportPossiblyOurFailure,
} from "../error-reporting";

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

  it("reports to Sentry but NOT PostHog on a non-capture surface", async () => {
    // `capture_exceptions: false` only disables posthog-js's automatic
    // window.onerror handler — an explicit captureException still sends. A
    // self-hosted npx/Docker install must not ship caught errors.
    vi.resetModules();
    vi.doMock("../PosthogUtils", () => ({
      isErrorCaptureSurface: () => false,
      isCredentialBearingPath: () => false,
    }));
    const mod = await import("../error-reporting");

    mod.reportCaught(new Error("boom"), { source: "unit" });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(posthogCaptureException).not.toHaveBeenCalled();
    vi.doUnmock("../PosthogUtils");
  });

  it("does not send to PostHog from a credential-bearing path", async () => {
    vi.resetModules();
    vi.doMock("../PosthogUtils", () => ({
      isErrorCaptureSurface: () => true,
      isCredentialBearingPath: () => true,
    }));
    const mod = await import("../error-reporting");

    mod.reportCaught(new Error("boom"), { source: "unit" });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(posthogCaptureException).not.toHaveBeenCalled();
    vi.doUnmock("../PosthogUtils");
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

  it("never throws when the surface gate itself throws", async () => {
    // This runs inside componentDidCatch, where throwing would escape the
    // boundary that just caught something. Fail closed: no PostHog send.
    vi.resetModules();
    vi.doMock("../PosthogUtils", () => ({
      isErrorCaptureSurface: () => {
        throw new Error("config module was mocked away");
      },
      isCredentialBearingPath: () => false,
    }));
    const mod = await import("../error-reporting");

    expect(() =>
      mod.reportCaught(new Error("x"), { source: "unit" }),
    ).not.toThrow();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(posthogCaptureException).not.toHaveBeenCalled();
    vi.doUnmock("../PosthogUtils");
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

describe("reportPossiblyOurFailure — server-attached normalization", () => {
  it("honors a normalized block the server attached to the error", () => {
    // A hosted route classifies the real failure with the error object in
    // hand. By the time it lands here it is a `WebApiError` whose message is
    // an HTTP status line, and `describeError` does not look at `.normalized`
    // — so re-describing the wrapper resolves `ambiguous` and the strict gate
    // drops a failure the server called ours outright.
    const error = Object.assign(new Error("HTTP 500"), {
      normalized: {
        slug: "internal/unknown",
        title: "Unexpected error",
        oneLine: "Something failed inside MCPJam.",
        likelyCauses: [],
        nextSteps: [],
        docsAnchor: "/troubleshooting/error-codes",
        severity: "error",
        rawMessage: "bundler crashed",
        origin: "mcpjam",
      },
    });

    expect(
      reportPossiblyOurFailure(error, { source: "execute_tool" }),
    ).toBe(true);
  });

  it("ignores a PARTIAL attached block, even one claiming to be ours", () => {
    // The dangerous shape is not a garbage one — it is a half-formed block
    // carrying `origin: "mcpjam"`, which would page on the strength of one
    // proxy-controlled string and then read `undefined` for everything else.
    const error = Object.assign(new Error("HTTP 500"), {
      normalized: { slug: "internal/unknown", origin: "mcpjam" },
    });

    expect(
      reportPossiblyOurFailure(error, { source: "execute_tool" }),
    ).toBe(false);
  });

  it("falls back to describeError when the normalized getter throws", () => {
    // Reporting runs on a path that is already handling a failure; a hostile
    // getter must not suppress an otherwise classifiable one.
    const error = new Error("HTTP 500");
    Object.defineProperty(error, "normalized", {
      get() {
        throw new Error("trap");
      },
    });

    expect(() =>
      reportPossiblyOurFailure(error, { source: "execute_tool" }),
    ).not.toThrow();
  });
});
