import { expect, it } from "vitest";
import {
  generationPreset,
  toGenerationOptions,
  loadGenerateConfig,
  saveGenerateConfig,
  DEFAULT_GENERATE_CONFIG,
} from "../eval-generation-config";

it.each(["quick", "comprehensive"] as const)(
  "sends the %s preset without a fixed case mix",
  (testSet) => {
    const config = generationPreset(testSet, "read-only");
    saveGenerateConfig("range-suite", config);
    expect(toGenerationOptions(loadGenerateConfig("range-suite"))).toEqual({
      testSet,
      toolCoverage: "read-only",
      varyUserStyles: false,
    });
    localStorage.clear();
  },
);
it("preserves legacy explicit bucket counts", () => {
  expect(toGenerationOptions(DEFAULT_GENERATE_CONFIG)).toMatchObject({
    caseMix: { simple: 2, multiTool: 2, multiTurn: 1, complex: 1, negative: 2 },
  });
});
