import { describe, expect, it } from "vitest";
import { GOAL_COMPLETION_DEFAULTS } from "../judge-defaults";

describe("managed judge defaults", () => {
  it("reports the DeepSeek model used by the backend without enabling automatic grading", () => {
    expect(GOAL_COMPLETION_DEFAULTS).toEqual({
      enabled: true,
      judgeModel: "deepseek/deepseek-v4.1-flash",
      threshold: 0.7,
      autoRun: false,
      role: "advisory",
    });
  });
});
