import { describe, expect, it } from "vitest";

import { reasoningProviderOptions } from "../reasoning-provider-options";

/**
 * Providers only return reasoning on its own channel when the request asks for
 * it. Nothing asked, so DeepSeek-R1 came back with its scratch work wrapped in
 * `<think>` tags inside the text channel and the Playground rendered it as the
 * answer. See BB-136.
 */
describe("reasoningProviderOptions", () => {
  it("enables Anthropic extended thinking", () => {
    expect(reasoningProviderOptions("anthropic")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
    });
  });

  it("asks OpenRouter for a separate reasoning channel", () => {
    expect(reasoningProviderOptions("openrouter")).toEqual({
      openrouter: { reasoning: { enabled: true, effort: "medium" } },
    });
  });

  it("returns nothing for a provider with no reasoning knob", () => {
    expect(reasoningProviderOptions("openai")).toEqual({});
    expect(reasoningProviderOptions("google")).toEqual({});
  });

  it("returns nothing when the provider is unknown or absent", () => {
    expect(reasoningProviderOptions(undefined)).toEqual({});
    expect(reasoningProviderOptions("")).toEqual({});
  });

  it("matches the provider case-insensitively", () => {
    expect(reasoningProviderOptions("Anthropic")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
    });
  });

  it("returns a fresh object each call so callers can spread it safely", () => {
    const first = reasoningProviderOptions("anthropic");
    const second = reasoningProviderOptions("anthropic");
    expect(first).not.toBe(second);
    expect(first.anthropic).not.toBe(second.anthropic);
  });
});
