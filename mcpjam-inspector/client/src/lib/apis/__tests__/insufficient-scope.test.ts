import { describe, it, expect } from "vitest";
import { WebApiError } from "@/lib/apis/web/base";
import {
  McpRequestError,
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

  it("returns undefined when no string field is present", () => {
    expect(parseInsufficientScopeChallenge({})).toBeUndefined();
    expect(parseInsufficientScopeChallenge({ requiredScope: 1 })).toBeUndefined();
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

  it("returns undefined when the WebApiError details carry no challenge fields", () => {
    const err = new WebApiError(500, "INTERNAL_ERROR", "boom", undefined, {
      insufficientScope: {},
    });
    expect(insufficientScopeFromError(err)).toBeUndefined();
  });

  it("returns undefined for an McpRequestError carrying an empty {} challenge", () => {
    // A truthy-but-empty challenge must re-narrow to undefined, matching the
    // hosted path — never leak a non-actionable {} to a step-up caller.
    const err = new McpRequestError("read failed", {
      insufficientScope: {},
      status: 403,
    });
    expect(insufficientScopeFromError(err)).toBeUndefined();
  });
});

describe("isActionableStepUpChallenge (SEP-2350)", () => {
  it("is actionable when a requiredScope is present", () => {
    expect(
      isActionableStepUpChallenge({ requiredScope: "read:tickets" }),
    ).toBe(true);
  });

  it("is NOT actionable for a resourceMetadataUrl-only challenge (inert in the orchestrator today — would burn the budget without widening scope)", () => {
    expect(
      isActionableStepUpChallenge({
        resourceMetadataUrl: "https://rs.example/.well-known",
      }),
    ).toBe(false);
  });

  it("is actionable when a requiredScope accompanies a resourceMetadataUrl", () => {
    expect(
      isActionableStepUpChallenge({
        requiredScope: "read:tickets",
        resourceMetadataUrl: "https://rs.example/.well-known",
      }),
    ).toBe(true);
  });

  it("is NOT actionable for an errorDescription-only challenge", () => {
    expect(
      isActionableStepUpChallenge({ errorDescription: "more scope needed" }),
    ).toBe(false);
  });

  it("is NOT actionable for a whitespace-only requiredScope (parses to zero scopes — would burn the budget without widening)", () => {
    expect(isActionableStepUpChallenge({ requiredScope: "   " })).toBe(false);
    expect(isActionableStepUpChallenge({ requiredScope: "\t\n" })).toBe(false);
  });

  it("is NOT actionable for undefined", () => {
    expect(isActionableStepUpChallenge(undefined)).toBe(false);
  });
});
