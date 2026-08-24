import { describe, expect, it } from "vitest";
import {
  classifyToolSafety,
  decideToolPolicy,
  type EvalSuiteFileToolPolicy,
} from "../index.js";

const policy = (overrides: Partial<EvalSuiteFileToolPolicy> = {}) => ({
  mode: "default" as const,
  ...overrides,
});

describe("tool policy precedence", () => {
  it("deny beats allow", () => {
    expect(
      decideToolPolicy({
        toolName: "write",
        annotations: { destructiveHint: true },
        policy: policy({ allow: ["write"], deny: ["write"] }),
      })
    ).toMatchObject({
      allowed: false,
      reason: "denyList",
      classification: "destructive",
    });
  });

  it("denies destructive tools by default without an allowlist", () => {
    expect(
      decideToolPolicy({
        toolName: "write",
        annotations: { destructiveHint: true },
        policy: policy(),
      })
    ).toMatchObject({ allowed: false, reason: "destructiveDefaultDeny" });
  });

  it("allows a destructive tool explicitly listed in allow", () => {
    expect(
      decideToolPolicy({
        toolName: "write",
        annotations: { destructiveHint: true },
        policy: policy({ allow: ["write"] }),
      })
    ).toMatchObject({ allowed: true, reason: "allowList" });
  });

  it("blocks unclassified tools in readOnly mode", () => {
    expect(
      decideToolPolicy({
        toolName: "unknown",
        policy: policy({ mode: "readOnly" }),
      })
    ).toMatchObject({
      allowed: false,
      reason: "readOnlyModeUnclassified",
      classification: "unknown",
    });
  });

  it("allows explicitly read-only tools in readOnly mode", () => {
    expect(
      decideToolPolicy({
        toolName: "read",
        annotations: { readOnlyHint: true },
        policy: policy({ mode: "readOnly" }),
      })
    ).toMatchObject({
      allowed: true,
      reason: "readOnlyModeClassified",
      classification: "readOnly",
    });
  });

  it("treats contradictory annotations as unknown", () => {
    const annotations = { readOnlyHint: true, destructiveHint: true };
    expect(classifyToolSafety(annotations)).toBe("unknown");
    expect(
      decideToolPolicy({
        toolName: "contradictory",
        annotations,
        policy: policy({ mode: "readOnly" }),
      })
    ).toMatchObject({ allowed: false, reason: "destructiveDefaultDeny" });
    expect(
      decideToolPolicy({
        toolName: "contradictory",
        annotations,
        policy: policy(),
      })
    ).toMatchObject({
      allowed: false,
      reason: "destructiveDefaultDeny",
      classification: "unknown",
    });
  });

  it("allows unknown annotations in default mode", () => {
    expect(
      decideToolPolicy({
        toolName: "unknown",
        policy: policy(),
      })
    ).toMatchObject({ allowed: true, reason: "modeDefault" });
  });

  it.each([
    undefined,
    { readOnlyHint: "true" },
    { destructiveHint: 1 },
    { readOnlyHint: null, destructiveHint: false },
    { readOnlyHint: false, destructiveHint: false },
  ])("treats garbage annotation values as unknown: %j", (annotations) => {
    expect(classifyToolSafety(annotations)).toBe("unknown");
  });
});
