import { describe, expect, it } from "vitest";

import { HostRunner } from "../src/HostRunner";
import type { CustomProvider } from "../src/types";

/**
 * A registered custom provider keeps its OWN name in a run's metadata.
 *
 * This is the regression the hosted-catalog widening could have caused. Once a
 * multi-segment id whose leading segment is not a provider resolves to
 * OpenRouter instead of throwing, a parse that does not know the registered
 * custom providers silently reclassifies `my-litellm/gpt-4` as the OpenRouter
 * model `my-litellm/gpt-4`. The constructor used to rely on that throw: it
 * caught it and split the id by hand, which happened to give the right answer.
 *
 * The metadata is what a run reports as its provider, so getting it wrong
 * mis-attributes every span and result for a BYOK deployment.
 */
const LITELLM: CustomProvider = {
  protocol: "openai-compatible",
  baseUrl: "https://litellm.internal/v1",
  apiKey: "sk-test",
};

function parsedMetadata(runner: HostRunner): {
  provider: string;
  model: string;
} {
  const internals = runner as unknown as {
    _parsedProvider: string;
    _parsedModel: string;
  };
  return {
    provider: internals._parsedProvider,
    model: internals._parsedModel,
  };
}

describe("HostRunner model metadata", () => {
  it("keeps a registered custom provider's own name", () => {
    const runner = new HostRunner({
      tools: {},
      model: "my-litellm/gpt-4",
      apiKey: "test-api-key",
      customProviders: { "my-litellm": LITELLM },
    });

    expect(parsedMetadata(runner)).toEqual({
      provider: "my-litellm",
      model: "gpt-4",
    });
  });

  it("reads a custom provider registered as a Map too", () => {
    const runner = new HostRunner({
      tools: {},
      model: "my-litellm/gpt-4",
      apiKey: "test-api-key",
      customProviders: new Map([["my-litellm", LITELLM]]),
    });

    expect(parsedMetadata(runner).provider).toBe("my-litellm");
  });

  it("still reports a hosted-catalog vendor path as openrouter", () => {
    // The other half of the same rule: with no custom provider by that name,
    // a vendor path IS an OpenRouter model, whole id and all.
    const runner = new HostRunner({
      tools: {},
      model: "qwen/qwen3-max",
      apiKey: "test-api-key",
    });

    expect(parsedMetadata(runner)).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3-max",
    });
  });

  it("reports a built-in provider unchanged", () => {
    const runner = new HostRunner({
      tools: {},
      model: "anthropic/claude-haiku-4.5",
      apiKey: "test-api-key",
    });

    expect(parsedMetadata(runner)).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4.5",
    });
  });
});
