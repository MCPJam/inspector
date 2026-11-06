import { describe, expect, it } from "vitest";
import { azureDeploymentName } from "../azure-deployment";

describe("azureDeploymentName", () => {
  it.each([
    ["the explicit native id", { modelId: "azure/gpt-5.1", nativeModelId: " prod-gpt51 " }, "prod-gpt51"],
    ["a bare model id", { modelId: " prod-gpt51 " }, "prod-gpt51"],
    ["a catalog id with no native id", { modelId: "azure/gpt-5.1" }, undefined],
    ["a catalog id with a blank native id", { modelId: "azure/gpt-5.1", nativeModelId: "  " }, undefined],
    ["an empty id", { modelId: "" }, undefined],
  ])("%s", (_label, selection, expected) => {
    expect(azureDeploymentName(selection)).toBe(expected);
  });

  it("never derives a deployment by stripping the provider prefix", () => {
    expect(azureDeploymentName({ modelId: "azure/gpt-5.1-codex-mini" })).toBeUndefined();
  });
});
