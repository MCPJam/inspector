import { describe, expect, it } from "vitest";

import { resolveModelSelection } from "../model-selection";

// #5472: the same id as a hosted row and as a "Your providers → OpenRouter"
// row, hosted first — the order `composeAvailableModels` produces.
const hostedSonnet = {
  id: "anthropic/claude-sonnet-5",
  provider: "anthropic",
  hosted: true,
};
const openRouterSonnet = {
  id: "anthropic/claude-sonnet-5",
  provider: "openrouter",
  hosted: false,
};
const models = [hostedSonnet, openRouterSonnet];

describe("resolveModelSelection", () => {
  it("returns the OpenRouter row when that is the provider it was picked under", () => {
    // The reported bug: an id-only lookup returned the hosted row here, and
    // the turn went to MCPJam credits instead of the user's OpenRouter key.
    expect(
      resolveModelSelection(models, "anthropic/claude-sonnet-5", {
        modelId: "anthropic/claude-sonnet-5",
        provider: "openrouter",
      }),
    ).toBe(openRouterSonnet);
  });

  it("returns the hosted row when THAT is the one picked", () => {
    // The fix must not simply prefer own-provider rows: picking the hosted
    // twin has to keep billing to MCPJam.
    expect(
      resolveModelSelection(models, "anthropic/claude-sonnet-5", {
        modelId: "anthropic/claude-sonnet-5",
        provider: "anthropic",
      }),
    ).toBe(hostedSonnet);
  });

  it("keeps the first match when there is no hint — the prior behaviour", () => {
    // Every selection persisted before the hint existed resolves exactly as
    // it did.
    expect(
      resolveModelSelection(models, "anthropic/claude-sonnet-5", null),
    ).toBe(hostedSonnet);
  });

  it("ignores a hint that qualifies a different id", () => {
    // The lead id has writers that do not record a hint; one left behind by
    // an earlier pick must not steer a later, different id.
    expect(
      resolveModelSelection(models, "anthropic/claude-sonnet-5", {
        modelId: "openai/gpt-5",
        provider: "openrouter",
      }),
    ).toBe(hostedSonnet);
  });

  it("falls back to the id when the hinted provider is no longer available", () => {
    // e.g. the OpenRouter key was removed since the pick.
    expect(
      resolveModelSelection([hostedSonnet], "anthropic/claude-sonnet-5", {
        modelId: "anthropic/claude-sonnet-5",
        provider: "openrouter",
      }),
    ).toBe(hostedSonnet);
  });

  it("does not let a hint resurrect a row the caller ruled out", () => {
    const disabledOpenRouter = { ...openRouterSonnet, disabled: true };
    expect(
      resolveModelSelection(
        [hostedSonnet, disabledOpenRouter],
        "anthropic/claude-sonnet-5",
        { modelId: "anthropic/claude-sonnet-5", provider: "openrouter" },
        (model) => !("disabled" in model && model.disabled),
      ),
    ).toBe(hostedSonnet);
  });

  it("returns null for a missing id or one that matches nothing", () => {
    expect(resolveModelSelection(models, null, null)).toBeNull();
    expect(resolveModelSelection(models, "", null)).toBeNull();
    expect(resolveModelSelection(models, "openai/gpt-5", null)).toBeNull();
  });
});
