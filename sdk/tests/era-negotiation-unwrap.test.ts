import { describe, expect, it } from "vitest";
import {
  isUnauthorized401,
  isAuthError,
  unwrapEraNegotiationCause,
  classifyNegotiationFailureClass,
} from "../src/mcp-client-manager/errors.js";

/**
 * Activation-checklist invariant: "OAuth 401 wrapped in an era-negotiation
 * error is correctly UNWRAPPED."
 *
 * When AUTO activation probes an OAuth-gated server, the upstream client
 * raises `SdkError(EraNegotiationFailed)` (code `"ERA_NEGOTIATION_FAILED"`)
 * carrying the real `UnauthorizedError` at `error.data.cause`. 401 recovery
 * must see through that wrapper so an unconfigured connect to a protected
 * server triggers OAuth instead of surfacing an opaque negotiation failure.
 */

class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Minimal stand-in for the upstream `SdkError(EraNegotiationFailed)` shape. */
function eraNegotiationFailed(cause: unknown): Error {
  const err = new Error("era negotiation failed") as Error & {
    code: string;
    data: unknown;
  };
  err.name = "SdkError";
  err.code = "ERA_NEGOTIATION_FAILED";
  err.data = { cause };
  return err;
}

describe("unwrapEraNegotiationCause", () => {
  it("returns the wrapped cause from error.data.cause", () => {
    const inner = new UnauthorizedError();
    expect(unwrapEraNegotiationCause(eraNegotiationFailed(inner))).toBe(inner);
  });

  it("falls back to error.cause when data.cause is absent", () => {
    const inner = new UnauthorizedError();
    const wrapper = new Error("negotiation") as Error & { code: string };
    wrapper.code = "ERA_NEGOTIATION_FAILED";
    (wrapper as Error).cause = inner;
    expect(unwrapEraNegotiationCause(wrapper)).toBe(inner);
  });

  it("is identity for a non-wrapper error (byte-identical passthrough)", () => {
    const plain = new UnauthorizedError();
    expect(unwrapEraNegotiationCause(plain)).toBe(plain);
    const status = { status: 500 };
    expect(unwrapEraNegotiationCause(status)).toBe(status);
  });

  it("does not loop on a self-referential wrapper", () => {
    const wrapper = new Error("loop") as Error & { code: string };
    wrapper.code = "ERA_NEGOTIATION_FAILED";
    (wrapper as Error).cause = wrapper;
    expect(() => unwrapEraNegotiationCause(wrapper)).not.toThrow();
  });
});

describe("classifyNegotiationFailureClass always returns a string", () => {
  it("prefers a string error name", () => {
    expect(classifyNegotiationFailureClass(new UnauthorizedError())).toBe(
      "UnauthorizedError"
    );
  });

  it("normalizes a NUMERIC transport code to a string (401/403)", () => {
    // Transport errors expose `code` as a runtime number; the public
    // `failureClass?: string` contract must never receive a number.
    const numericCode = classifyNegotiationFailureClass({ code: 401 });
    expect(numericCode).toBe("401");
    expect(typeof numericCode).toBe("string");
    expect(typeof classifyNegotiationFailureClass({ code: 403 })).toBe(
      "string"
    );
  });

  it("passes through a string code and a string cause", () => {
    expect(classifyNegotiationFailureClass({ code: "ETIMEDOUT" })).toBe(
      "ETIMEDOUT"
    );
    expect(classifyNegotiationFailureClass("boom")).toBe("boom");
  });

  it("falls back to 'unknown' for a codeless/nameless cause", () => {
    expect(classifyNegotiationFailureClass(undefined)).toBe("unknown");
    expect(classifyNegotiationFailureClass({})).toBe("unknown");
    expect(classifyNegotiationFailureClass(42)).toBe("unknown");
  });
});

describe("isUnauthorized401 sees through the era-negotiation wrapper", () => {
  it("detects a wrapped UnauthorizedError", () => {
    expect(isUnauthorized401(eraNegotiationFailed(new UnauthorizedError()))).toBe(
      true
    );
  });

  it("detects a wrapped HTTP-401 status error", () => {
    expect(isUnauthorized401(eraNegotiationFailed({ status: 401 }))).toBe(true);
  });

  it("does NOT treat a wrapped non-401 (e.g. 500) as unauthorized", () => {
    expect(isUnauthorized401(eraNegotiationFailed({ status: 500 }))).toBe(false);
  });

  it("is unchanged for a bare UnauthorizedError (no wrapper)", () => {
    expect(isUnauthorized401(new UnauthorizedError())).toBe(true);
  });
});

describe("isAuthError sees through the era-negotiation wrapper", () => {
  it("classifies a wrapped 403 transport error as an auth error", () => {
    const transportError = new Error("forbidden") as Error & { code: number };
    transportError.code = 403;
    const out = isAuthError(eraNegotiationFailed(transportError));
    expect(out.isAuth).toBe(true);
    expect(out.statusCode).toBe(403);
  });
});
