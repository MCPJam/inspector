import { describe, it, expect, vi, beforeEach } from "vitest";
import { describeError, describeAsSlug } from "@mcpjam/sdk";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from "@sentry/node";
import {
  isOriginCaptureHandled,
  markOriginCaptureHandled,
  maybeCaptureOriginError,
} from "../error-origin-capture.js";

const captureException = vi.mocked(Sentry.captureException);

/** A normalized error pinned to a slug, so tests assert policy, not the resolver. */
function normalizedFor(slug: string) {
  return describeAsSlug(slug, new Error(`synthetic ${slug}`));
}

beforeEach(() => {
  captureException.mockClear();
});

describe("maybeCaptureOriginError capture policy", () => {
  it("captures MCPJam-origin errors", () => {
    const error = new Error("stateless tool header discovery");
    const decision = maybeCaptureOriginError(
      error,
      normalizedFor("sdk/not_yet_supported_in_stateless"),
      { source: "web.mapRuntimeError" },
    );

    expect(decision.origin).toBe("mcpjam");
    expect(decision.captured).toBe(true);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["user_config", "transport/econnrefused"],
    ["user_server", "jsonrpc/internal_error"],
  ])("never captures %s errors", (_origin, slug) => {
    const decision = maybeCaptureOriginError(new Error("x"), normalizedFor(slug), {
      source: "mcp.jsonError",
    });

    expect(decision.captured).toBe(false);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("does not capture ambiguous errors — they are measured in Axiom, not paged on", () => {
    // The whole timeout/reset/fetch-failure family lands here, and on hosted it
    // is dominated by flaky user servers. Capturing it would rebuild the noise
    // problem this helper exists to remove.
    for (const slug of [
      "transport/etimedout",
      "transport/econnreset",
      "transport/fetch_failed",
      "jsonrpc/connection_closed",
      "internal/unknown",
    ]) {
      const decision = maybeCaptureOriginError(new Error("x"), normalizedFor(slug), {
        source: "mcp.chat-v2.stream",
      });
      expect(decision.origin, slug).toBe("ambiguous");
      expect(decision.captured, slug).toBe(false);
    }
    expect(captureException).not.toHaveBeenCalled();
  });

  it("treats a missing normalized block as ambiguous rather than crashing", () => {
    const decision = maybeCaptureOriginError(new Error("x"), undefined, {
      source: "app.onError",
    });

    expect(decision.origin).toBe("ambiguous");
    expect(decision.captured).toBe(false);
  });

  it("wraps a non-Error throw so Sentry still gets an exception", () => {
    maybeCaptureOriginError(
      "just a string",
      normalizedFor("sdk/not_yet_supported_in_stateless"),
      { source: "web.mapRuntimeError" },
    );

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe("mcpjam_internal boundary", () => {
  it("promotes ambiguous to a capture", () => {
    const decision = maybeCaptureOriginError(
      new Error("something broke in our handler"),
      normalizedFor("internal/unknown"),
      { source: "mcp.chat-v2.request", boundary: "mcpjam_internal" },
    );

    expect(decision.origin).toBe("mcpjam");
    expect(decision.captured).toBe(true);
  });

  it("does NOT overrule positive evidence about a user-owned failure", () => {
    // A boundary declaration says "the hop was ours". It must not turn an
    // ECONNREFUSED against the user's own MCP server into a page.
    for (const slug of ["transport/econnrefused", "jsonrpc/internal_error"]) {
      const decision = maybeCaptureOriginError(new Error("x"), normalizedFor(slug), {
        source: "mcp.chat-v2.request",
        boundary: "mcpjam_internal",
      });
      expect(decision.captured, slug).toBe(false);
    }
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("capture dedupe", () => {
  it("captures an MCPJam error only once across repeated calls", () => {
    const error = new Error("ours");
    const normalized = normalizedFor("sdk/not_yet_supported_in_stateless");

    const first = maybeCaptureOriginError(error, normalized, {
      source: "web.mapRuntimeError",
    });
    const second = maybeCaptureOriginError(error, normalized, {
      source: "mcp.localRouteError",
    });

    expect(first.captured).toBe(true);
    expect(second.captured).toBe(false);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("stamps declined errors too, so a later logger.error cannot re-capture them", () => {
    // This is the noise half of the fix: routes log an error and then serialize
    // the same object into an envelope. If only captured errors were stamped,
    // every user-fault failure the policy just declined would be picked back up
    // by `logger.error`'s unconditional capture.
    const error = new Error("their server is down");
    maybeCaptureOriginError(error, normalizedFor("transport/econnrefused"), {
      source: "mcp.jsonError",
    });

    expect(isOriginCaptureHandled(error)).toBe(true);
  });

  it("sees a stamp through a cause chain", () => {
    const original = new Error("root");
    markOriginCaptureHandled(original);
    const wrapper = new Error("wrapped", { cause: original });

    expect(isOriginCaptureHandled(wrapper)).toBe(true);
  });

  it("sees a stamp on a memoized normalized block after the error identity changed", () => {
    const normalized = describeError(new Error("boom"));
    markOriginCaptureHandled(normalized);

    expect(isOriginCaptureHandled({ normalized })).toBe(true);
  });

  it("terminates on a cyclic cause chain", () => {
    const a: { cause?: unknown } = new Error("a");
    const b: { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;

    expect(isOriginCaptureHandled(a)).toBe(false);
  });

  it("treats unstampable values as unhandled rather than throwing", () => {
    expect(isOriginCaptureHandled(undefined)).toBe(false);
    expect(isOriginCaptureHandled("a string throw")).toBe(false);
    expect(() => markOriginCaptureHandled(Object.freeze(new Error("f")))).not.toThrow();
  });

  it("keeps the stamp non-enumerable so it never reaches a JSON body", () => {
    const error = new Error("ours") as Error & { extra?: string };
    error.extra = "kept";
    markOriginCaptureHandled(error);

    expect(Object.keys(error)).toEqual(["extra"]);
    expect(JSON.stringify({ ...error })).not.toContain("Capture");
  });
});
