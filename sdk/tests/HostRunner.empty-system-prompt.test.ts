import { describe, expect, it } from "vitest";

import { HostRunner } from "../src/HostRunner";

/**
 * An empty system prompt must never reach the provider.
 *
 * Anthropic refuses an empty system block outright — `system: text content
 * blocks must be non-empty`, HTTP 400, before the model sees anything. A saved
 * MCPJam client with no system prompt reads as `""`, and `runWithClient` passes
 * that through, so every generation of every case in the suite failed with a
 * bare "Bad Request".
 */
describe("HostRunner system prompt", () => {
  it("falls back when the configured prompt is empty", () => {
    const runner = new HostRunner({
      tools: {},
      model: "anthropic/claude-haiku-4.5",
      apiKey: "test-api-key",
      systemPrompt: "",
    });

    expect(runner.getSystemPrompt()).toBe("You are a helpful assistant.");
  });

  it("keeps a configured prompt that has content", () => {
    const runner = new HostRunner({
      tools: {},
      model: "anthropic/claude-haiku-4.5",
      apiKey: "test-api-key",
      systemPrompt: "You shop for groceries.",
    });

    expect(runner.getSystemPrompt()).toBe("You shop for groceries.");
  });
});
