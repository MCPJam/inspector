import { describe, it, expect } from "vitest";
import { WebApiError } from "@/lib/apis/web/base";
import {
  McpRequestError,
  authChallengeFromError,
  parseAuthChallenge,
  insufficientScopeFromError,
  isActionableStepUpChallenge,
  parseInsufficientScopeChallenge,
} from "@/lib/apis/insufficient-scope";

describe("parseInsufficientScopeChallenge (SEP-2350)", () => {
  it("narrows a valid challenge payload", () => {
    expect(
      parseInsufficientScopeChallenge({
        requiredScope: "read write",
        resourceMetadataUrl: "https://rs.example/.well-known",
        errorDescription: "more scope needed",
      }),
    ).toEqual({
      requiredScope: "read write",
      resourceMetadataUrl: "https://rs.example/.well-known",
      errorDescription: "more scope needed",
    });
  });

  it("keeps a bare challenge (no scope, no pointer) as a step-up request", () => {
    // The server sends `insufficientScope` only for a real 403
    // insufficient_scope, so an empty object is a bare challenge.
    expect(parseInsufficientScopeChallenge({})).toEqual({});
    expect(parseInsufficientScopeChallenge({ requiredScope: 1 })).toEqual({});
  });

  it("returns undefined when there is no challenge object", () => {
    expect(parseInsufficientScopeChallenge(undefined)).toBeUndefined();
    expect(parseInsufficientScopeChallenge("nope")).toBeUndefined();
  });
});

describe("insufficientScopeFromError (SEP-2350)", () => {
  it("reads the challenge off an McpRequestError (local throw path)", () => {
    const err = new McpRequestError("read failed", {
      insufficientScope: { requiredScope: "read:tickets" },
      status: 403,
    });
    expect(insufficientScopeFromError(err)).toEqual({
      requiredScope: "read:tickets",
    });
  });

  it("reads the challenge off a hosted WebApiError.details", () => {
    const err = new WebApiError(403, "FORBIDDEN", "forbidden", undefined, {
      insufficientScope: {
        requiredScope: "read write admin",
        resourceMetadataUrl: "https://rs.example/.well-known",
      },
    });
    expect(insufficientScopeFromError(err)).toEqual({
      requiredScope: "read write admin",
      resourceMetadataUrl: "https://rs.example/.well-known",
      errorDescription: undefined,
    });
  });

  it("returns undefined for an ordinary error", () => {
    expect(insufficientScopeFromError(new Error("boom"))).toBeUndefined();
  });

  it("returns undefined for an McpRequestError without a challenge", () => {
    expect(
      insufficientScopeFromError(new McpRequestError("plain 500", { status: 500 })),
    ).toBeUndefined();
  });

  it("reads a bare challenge off WebApiError details", () => {
    const err = new WebApiError(403, "UPSTREAM_AUTH_FAILED", "boom", undefined, {
      insufficientScope: {},
    });
    expect(insufficientScopeFromError(err)).toEqual({});
  });

  it("reads a bare challenge off an McpRequestError", () => {
    // Same on both paths: a bare insufficient_scope is a step-up request.
    const err = new McpRequestError("read failed", {
      insufficientScope: {},
      status: 403,
    });
    expect(insufficientScopeFromError(err)).toEqual({});
  });
});

describe("isActionableStepUpChallenge (SEP-2350)", () => {
  it("is actionable when a requiredScope is present", () => {
    expect(
      isActionableStepUpChallenge({ requiredScope: "read:tickets" }),
    ).toBe(true);
  });

  it("is actionable for a resourceMetadataUrl-only challenge (discovery now consumes the PRM pointer — SEP-2350 follow-up to #3427)", () => {
    expect(
      isActionableStepUpChallenge({
        resourceMetadataUrl: "https://rs.example/.well-known",
      }),
    ).toBe(true);
  });

  it("is actionable for a whitespace-only resourceMetadataUrl (a bare challenge)", () => {
    expect(isActionableStepUpChallenge({ resourceMetadataUrl: "   " })).toBe(
      true,
    );
  });

  it("is actionable when a requiredScope accompanies a resourceMetadataUrl", () => {
    expect(
      isActionableStepUpChallenge({
        requiredScope: "read:tickets",
        resourceMetadataUrl: "https://rs.example/.well-known",
      }),
    ).toBe(true);
  });

  it("is actionable for an errorDescription-only or empty challenge (discovery chooses the scopes)", () => {
    expect(
      isActionableStepUpChallenge({ errorDescription: "more scope needed" }),
    ).toBe(true);
    expect(isActionableStepUpChallenge({})).toBe(true);
  });

  it("treats a whitespace-only requiredScope as a bare challenge", () => {
    expect(isActionableStepUpChallenge({ requiredScope: "   " })).toBe(true);
  });

  it("is NOT actionable for undefined", () => {
    expect(isActionableStepUpChallenge(undefined)).toBe(false);
  });
});

describe("authChallengeFromError (mid-session sign-in)", () => {
  const challenge = {
    source: "http_401",
    requiredScope: "orders:read",
    effectiveAuth: "discover",
    facets: {
      challengeHeader: "bearer",
      hasResourceMetadata: false,
      hasScope: true,
      hasErrorParams: false,
    },
  };

  it("reads the challenge off an McpRequestError (local throw path)", () => {
    const err = new McpRequestError("read failed", {
      authChallenge: challenge as never,
      status: 401,
    });
    expect(authChallengeFromError(err)).toEqual(challenge);
  });

  it("reads the challenge off a hosted WebApiError's details", () => {
    const err = new WebApiError(403, "UPSTREAM_AUTH_FAILED", "sign in", undefined, {
      upstreamAuthRequired: true,
      authChallenge: challenge,
    });
    expect(authChallengeFromError(err)).toEqual(challenge);
  });

  it("narrows a malformed payload away instead of trusting it", () => {
    expect(parseAuthChallenge({ source: "evil" })).toBeUndefined();
    expect(
      parseAuthChallenge({ ...challenge, effectiveAuth: "root" })
        ?.effectiveAuth,
    ).toBeUndefined();
    expect(authChallengeFromError(new Error("plain"))).toBeUndefined();
  });
});
