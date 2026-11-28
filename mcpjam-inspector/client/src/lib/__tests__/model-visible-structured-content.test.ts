import { describe, expect, it } from "vitest";
import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config";
import {
  getModelVisibleStructuredContent,
  parseModelVisibleStructuredContent,
  ruleForToolResultParts,
  setModelVisibleStructuredContent,
  toolResultPartsForRule,
} from "../model-visible-structured-content";

const imageFlags: ModelVisibleMcpToolResults = {
  directContent: { image: false },
  embeddedResources: { blob: { image: false } },
  linkedResources: { blob: { enabled: false, image: true } },
};

describe("setModelVisibleStructuredContent", () => {
  it.each(["fallback", "preferred", "both"] as const)(
    "sets %s and keeps the image flags",
    (rule) => {
      expect(setModelVisibleStructuredContent(imageFlags, rule)).toEqual({
        ...imageFlags,
        structuredContent: rule,
      });
    },
  );

  it("sets a rule on a client with no policy", () => {
    expect(setModelVisibleStructuredContent(undefined, "preferred")).toEqual({
      structuredContent: "preferred",
    });
  });

  it("removes only the key when set back to the default", () => {
    const next = setModelVisibleStructuredContent(
      { ...imageFlags, structuredContent: "both" },
      undefined,
    );
    expect(next).toEqual(imageFlags);
    expect(next).not.toHaveProperty("structuredContent");
  });

  it("leaves no policy when the rule was its only key", () => {
    expect(
      setModelVisibleStructuredContent(
        { structuredContent: "fallback" },
        undefined,
      ),
    ).toBeUndefined();
    expect(setModelVisibleStructuredContent(undefined, undefined)).toBe(
      undefined,
    );
  });

  it("does not change the policy it was given", () => {
    const policy: ModelVisibleMcpToolResults = {
      ...imageFlags,
      structuredContent: "both",
    };
    setModelVisibleStructuredContent(policy, undefined);
    setModelVisibleStructuredContent(policy, "fallback");
    expect(policy.structuredContent).toBe("both");
  });
});

describe("reading the rule", () => {
  it("reads a saved rule and treats anything else as the default", () => {
    expect(
      getModelVisibleStructuredContent({ structuredContent: "preferred" }),
    ).toBe("preferred");
    expect(getModelVisibleStructuredContent(imageFlags)).toBeUndefined();
    expect(getModelVisibleStructuredContent(undefined)).toBeUndefined();
    expect(parseModelVisibleStructuredContent("default")).toBeUndefined();
    expect(parseModelVisibleStructuredContent("both")).toBe("both");
  });
});

describe("tool result parts", () => {
  it.each([
    [undefined, ["content", "structuredContent", "_meta"]],
    ["fallback", ["content"]],
    ["preferred", ["structuredContent"]],
    ["both", ["content", "structuredContent"]],
  ] as const)("rule %s selects %j", (rule, parts) => {
    expect(toolResultPartsForRule(rule)).toEqual(parts);
  });

  // [current rule, part toggled, resulting rule]
  it.each([
    [undefined, "_meta", "both"],
    [undefined, "content", "preferred"],
    [undefined, "structuredContent", "fallback"],
    ["both", "_meta", undefined],
    ["both", "content", "preferred"],
    ["both", "structuredContent", "fallback"],
    ["fallback", "structuredContent", "both"],
    ["fallback", "_meta", undefined],
    ["preferred", "content", "both"],
    ["preferred", "_meta", undefined],
  ] as const)("from %s, toggling %s gives %s", (current, part, expected) => {
    const before: string[] = toolResultPartsForRule(current);
    const selected = before.includes(part)
      ? before.filter((p) => p !== part)
      : [...before, part];
    expect(ruleForToolResultParts(current, selected)).toEqual({
      rule: expected,
    });
  });

  it("keeps the rule when the last part is deselected", () => {
    expect(ruleForToolResultParts("fallback", [])).toBeNull();
    expect(ruleForToolResultParts("preferred", [])).toBeNull();
  });
});
