import { describe, expect, it } from "vitest";
import { getHarnessAdapter } from "../registry";

describe("harness registry", () => {
  it("returns the claude-code adapter", () => {
    expect(getHarnessAdapter("claude-code").id).toBe("claude-code");
  });

  it("maps host model ids to Claude Code CLI-native aliases", () => {
    const { toNativeModel } = getHarnessAdapter("claude-code");
    expect(toNativeModel?.("anthropic/claude-haiku-4.5")).toBe("haiku");
    expect(toNativeModel?.("anthropic/claude-opus-4-6")).toBe("opus");
    expect(toNativeModel?.("anthropic/claude-sonnet-4-6")).toBe("sonnet");
    expect(toNativeModel?.("openai/gpt-5")).toBeUndefined();
  });

  it("throws for an unknown harness id (e.g. a not-yet-installed adapter)", () => {
    expect(() => getHarnessAdapter("codex")).toThrow(/Unsupported harness/);
  });
});
