import { describe, it, expect } from "vitest";
import { InsufficientScopeError } from "@modelcontextprotocol/client";
import {
  extractInsufficientScopeChallenge,
  jsonError,
  serializeMcpError,
} from "../tools.js";

/** A minimal Hono-`c`-like stub that captures the `c.json(body, status)` call. */
function captureJson() {
  const calls: Array<{ body: unknown; status?: number }> = [];
  return {
    c: {
      json: (body: unknown, status?: number) => {
        calls.push({ body, status });
        return { body, status };
      },
    },
    calls,
  };
}

describe("extractInsufficientScopeChallenge (SEP-2350)", () => {
  it("extracts the challenge from a top-level InsufficientScopeError", () => {
    const err = new InsufficientScopeError({
      requiredScope: "read write admin",
      resourceMetadataUrl: "https://rs.example/.well-known/oauth-protected-resource",
      errorDescription: "additional scope required",
    });
    expect(extractInsufficientScopeChallenge(err)).toEqual({
      requiredScope: "read write admin",
      resourceMetadataUrl:
        "https://rs.example/.well-known/oauth-protected-resource",
      errorDescription: "additional scope required",
    });
  });

  it("walks the cause chain to find a wrapped InsufficientScopeError", () => {
    const inner = new InsufficientScopeError({ requiredScope: "read:tickets" });
    const outer = new Error("tool call failed");
    (outer as any).cause = inner;
    expect(extractInsufficientScopeChallenge(outer)).toEqual({
      requiredScope: "read:tickets",
      resourceMetadataUrl: undefined,
      errorDescription: undefined,
    });
  });

  it("returns undefined for a plain error (no challenge)", () => {
    expect(
      extractInsufficientScopeChallenge(new Error("boom")),
    ).toBeUndefined();
  });

  it("returns undefined when a name match carries no challenge fields", () => {
    const err = new Error("insufficient scope");
    err.name = "InsufficientScopeError";
    expect(extractInsufficientScopeChallenge(err)).toBeUndefined();
  });

  it("tolerates a self-referential cause chain", () => {
    const err = new Error("loop") as any;
    err.cause = err;
    expect(extractInsufficientScopeChallenge(err)).toBeUndefined();
  });

  it("does NOT treat an unrelated error carrying a requiredScope field as a challenge", () => {
    // A non-InsufficientScope error that happens to expose a `requiredScope`
    // string must not be duck-typed into an OAuth step-up challenge — that
    // would trigger a spurious client re-authorization.
    const err = new Error("some tool needs a scope") as any;
    err.requiredScope = "read:everything";
    err.resourceMetadataUrl = "https://rs.example/.well-known";
    expect(extractInsufficientScopeChallenge(err)).toBeUndefined();
  });

  it("does not treat a wrapped non-InsufficientScope requiredScope-bearer as a challenge", () => {
    const inner = new Error("nested") as any;
    inner.requiredScope = "admin";
    const outer = new Error("outer");
    (outer as any).cause = inner;
    expect(extractInsufficientScopeChallenge(outer)).toBeUndefined();
  });
});

describe("serializeMcpError", () => {
  it("attaches insufficientScope for a 403 insufficient_scope error", () => {
    const err = new InsufficientScopeError({
      requiredScope: "read write",
      resourceMetadataUrl: "https://rs.example/.well-known",
    });
    const serialized = serializeMcpError(err) as Record<string, unknown>;
    expect(serialized.insufficientScope).toEqual({
      requiredScope: "read write",
      resourceMetadataUrl: "https://rs.example/.well-known",
      errorDescription: undefined,
    });
    expect(serialized.name).toBe("InsufficientScopeError");
  });

  it("omits insufficientScope for an ordinary error", () => {
    const serialized = serializeMcpError(new Error("nope")) as Record<
      string,
      unknown
    >;
    expect(serialized.insufficientScope).toBeUndefined();
    expect(serialized.message).toBe("nope");
  });
});

describe("jsonError (SEP-2350 challenge status)", () => {
  it("returns HTTP 403 for an insufficient_scope challenge that carries no status", () => {
    // `InsufficientScopeError` has no numeric `status`, so without the challenge
    // override it would serialize with the generic 500 fallback.
    const err = new InsufficientScopeError({ requiredScope: "read write" });
    expect((err as any).status).toBeUndefined();

    const { c, calls } = captureJson();
    jsonError(c, err, 500);

    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe(403);
    const body = calls[0].body as Record<string, any>;
    expect(body.mcpError.insufficientScope).toEqual({
      requiredScope: "read write",
      resourceMetadataUrl: undefined,
      errorDescription: undefined,
    });
  });

  it("honors an explicit numeric status even when a challenge is present", () => {
    const err = new InsufficientScopeError({ requiredScope: "admin" });
    (err as any).status = 401;

    const { c, calls } = captureJson();
    jsonError(c, err, 500);

    expect(calls[0].status).toBe(401);
  });

  it("falls back to the provided status for an ordinary error", () => {
    const { c, calls } = captureJson();
    jsonError(c, new Error("boom"), 500);

    expect(calls[0].status).toBe(500);
  });
});
