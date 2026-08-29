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

import { ConvexError } from "convex/values";

import {
  reportBoundaryError,
  reportCaught,
  reportPossiblyOurFailure,
} from "../error-reporting";

// A refusal is not a defect. The backend says so explicitly with
// `kind: 'forbidden'`; everything else — including a Convex error that carries
// no kind, and the `Server Error` string a production deployment substitutes
// for a plain throw — is still a defect until proven otherwise.
describe("authorization refusals", () => {
  beforeEach(() => {
    captureException.mockReset();
    posthogCaptureException.mockReset();
  });

  it("drops a forbidden ConvexError before it reaches either sink", () => {
    reportCaught(
      new ConvexError({
        kind: "forbidden",
        message: "Not a member of this organization",
      }),
      { source: "react_boundary:integrations_github_checks" },
    );

    expect(captureException).not.toHaveBeenCalled();
    expect(posthogCaptureException).not.toHaveBeenCalled();
  });

  it("drops it through the boundary entry point too", () => {
    reportBoundaryError(
      new ConvexError({ kind: "forbidden", message: "nope" }),
      { componentStack: "\n  at GithubChecksCard" },
      "integrations_github_checks",
    );

    expect(captureException).not.toHaveBeenCalled();
  });

  it("still reports a ConvexError that is not a refusal", () => {
    reportCaught(new ConvexError({ kind: "rate_limited" }), {
      source: "unit",
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(posthogCaptureException).toHaveBeenCalledTimes(1);
  });

  // The three payload shapes nearest the guard's edge. `null` is why the check
  // null-tests before reading `.kind` (`typeof null` is `"object"`), and an
  // absent or empty `kind` is the "carries no kind" case called out above.
  // Empty string earns its own case: a `kind` match rewritten as a substring
  // test would swallow it silently, since every string contains `""`.
  it("still reports a ConvexError whose payload is null", () => {
    reportCaught(new ConvexError(null), { source: "unit" });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(posthogCaptureException).toHaveBeenCalledTimes(1);
  });

  it("still reports a ConvexError that carries no kind", () => {
    reportCaught(new ConvexError({}), { source: "unit" });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(posthogCaptureException).toHaveBeenCalledTimes(1);
  });

  it("still reports a ConvexError whose kind is empty", () => {
    reportCaught(new ConvexError({ kind: "" }), { source: "unit" });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(posthogCaptureException).toHaveBeenCalledTimes(1);
  });

  it("still reports the masked production throw", () => {
    reportCaught(new Error("[CONVEX Q(a:b)] Server Error"), {
      source: "unit",
    });

    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

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

  // Sentry reads `level`; PostHog error tracking reads `$exception_level`, and
  // groups, alerts and filters on it. Sending only `level` left every report at
  // PostHog's `error` default, which silently overrode the one caller that asks
  // for something quieter.
  it("declares the level on the key PostHog actually reads", () => {
    reportCaught(new Error("server under test misbehaved"), {
      source: "oauth_debugger_step",
      level: "warning",
    });

    expect(posthogCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ $exception_level: "warning" }),
    );
  });

  it("still defaults to error when the caller names no level", () => {
    reportCaught(new Error("boom"), { source: "unit" });

    expect(posthogCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ $exception_level: "error" }),
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

  it("reports a refusal as NOT sent, even when the block claims it is ours", () => {
    // The return value is the gate callers assert on. `reportCaught` drops a
    // refusal downstream, so without its own check this would answer `true`
    // for something it never sent.
    const error = Object.assign(new ConvexError({ kind: "forbidden" }), {
      normalized: {
        slug: "internal/unknown",
        title: "Unexpected error",
        oneLine: "Something failed inside MCPJam.",
        likelyCauses: [],
        nextSteps: [],
        docsAnchor: "/troubleshooting/error-codes",
        severity: "error",
        rawMessage: "refused",
        origin: "mcpjam",
      },
    });

    expect(reportPossiblyOurFailure(error, { source: "execute_tool" })).toBe(
      false,
    );
    expect(captureException).not.toHaveBeenCalled();
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
