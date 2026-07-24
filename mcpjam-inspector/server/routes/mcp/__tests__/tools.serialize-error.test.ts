import { describe, it, expect } from "vitest";
import { InsufficientScopeError } from "@modelcontextprotocol/client";
import {
  extractInsufficientScopeChallenge,
  serializeMcpError,
} from "../tools.js";

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
