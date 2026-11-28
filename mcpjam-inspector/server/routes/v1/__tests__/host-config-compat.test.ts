import { describe, expect, it } from "vitest";
import { withoutModelVisibleStructuredContent } from "../host-config-compat.js";

describe("withoutModelVisibleStructuredContent", () => {
  it("removes only the client rule", () => {
    expect(
      withoutModelVisibleStructuredContent({
        modelId: "m",
        modelVisibleMcpToolResults: {
          directContent: { image: false },
          structuredContent: "preferred",
        },
      }),
    ).toEqual({
      modelId: "m",
      modelVisibleMcpToolResults: { directContent: { image: false } },
    });
  });

  it("drops a policy that held only the rule, as a released SDK would never have seen it", () => {
    expect(
      withoutModelVisibleStructuredContent({
        modelId: "m",
        modelVisibleMcpToolResults: { structuredContent: "fallback" },
      }),
    ).toEqual({ modelId: "m" });
  });

  it("returns a config without the rule unchanged", () => {
    const config = { modelId: "m", modelVisibleMcpToolResults: {} };
    expect(withoutModelVisibleStructuredContent(config)).toBe(config);
  });
});
