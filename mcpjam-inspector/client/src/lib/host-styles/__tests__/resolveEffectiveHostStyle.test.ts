import { describe, expect, it } from "vitest";
import {
  CHATGPT_HOST_STYLE,
  CLAUDE_HOST_STYLE,
  DEFAULT_HOST_STYLE,
  MCPJAM_HOST_STYLE,
  resolveEffectiveHostStyle,
  type ChatUiOverride,
} from "..";

describe("resolveEffectiveHostStyle", () => {
  it("returns the preset when no override is provided", () => {
    const resolved = resolveEffectiveHostStyle({ hostStyle: "claude" });
    expect(resolved).toBe(CLAUDE_HOST_STYLE);
  });

  it("falls back to MCPJam when the id is unknown or absent", () => {
    expect(
      resolveEffectiveHostStyle({ hostStyle: null }),
    ).toBe(DEFAULT_HOST_STYLE);
    expect(
      resolveEffectiveHostStyle({ hostStyle: "does-not-exist" }),
    ).toBe(DEFAULT_HOST_STYLE);
  });

  it("returns a new object (not the preset) when override is set, leaving the preset untouched", () => {
    const override: ChatUiOverride = { label: "Custom" };
    const resolved = resolveEffectiveHostStyle({
      hostStyle: "claude",
      chatUiOverride: override,
    });
    expect(resolved).not.toBe(CLAUDE_HOST_STYLE);
    expect(CLAUDE_HOST_STYLE.chatUi.label).toBe("Claude");
  });

  it("overrides chatUi scalars while preserving the preset id", () => {
    const resolved = resolveEffectiveHostStyle({
      hostStyle: "claude",
      chatUiOverride: {
        label: "My Host",
        shortLabel: "My-style host",
        pickerDescription: "Custom chrome",
        logoSrc: "/custom-logo.png",
      },
    });
    expect(resolved.id).toBe("claude");
    expect(resolved.chatUi.label).toBe("My Host");
    expect(resolved.chatUi.shortLabel).toBe("My-style host");
    expect(resolved.chatUi.pickerDescription).toBe("Custom chrome");
    expect(resolved.chatUi.logoSrc).toBe("/custom-logo.png");
    // Untouched fields inherit from the Claude preset.
    expect(resolved.chatUi.family).toBe(CLAUDE_HOST_STYLE.chatUi.family);
  });

  it("flips family between visual languages", () => {
    const resolved = resolveEffectiveHostStyle({
      hostStyle: "claude",
      chatUiOverride: { family: "chatgpt" },
    });
    expect(resolved.chatUi.family).toBe("chatgpt");
  });

  it("uses the override's chatBackground for both themes when set", () => {
    const resolved = resolveEffectiveHostStyle({
      hostStyle: "claude",
      chatUiOverride: {
        chatBackground: {
          light: "rgb(1, 2, 3)",
          dark: "rgb(4, 5, 6)",
        },
      },
    });
    expect(resolved.chatUi.resolveChatBackground("light")).toBe("rgb(1, 2, 3)");
    expect(resolved.chatUi.resolveChatBackground("dark")).toBe("rgb(4, 5, 6)");
  });

  it("falls through to preset chatBackground when override omits it", () => {
    const resolved = resolveEffectiveHostStyle({
      hostStyle: "claude",
      chatUiOverride: { label: "Custom" },
    });
    expect(resolved.chatUi.resolveChatBackground("light")).toBe(
      CLAUDE_HOST_STYLE.chatUi.resolveChatBackground("light"),
    );
  });

  it("replaces styleVariables per theme when set", () => {
    const lightVars = { "--color-text-primary": "rgb(10, 10, 10)" };
    const darkVars = { "--color-text-primary": "rgb(240, 240, 240)" };
    const resolved = resolveEffectiveHostStyle({
      hostStyle: "claude",
      chatUiOverride: {
        styleVariables: {
          light: lightVars as ReturnType<
            typeof CLAUDE_HOST_STYLE.mcp.resolveStyleVariables
          >,
          dark: darkVars as ReturnType<
            typeof CLAUDE_HOST_STYLE.mcp.resolveStyleVariables
          >,
        },
      },
    });
    expect(resolved.mcp.resolveStyleVariables("light")).toEqual(lightVars);
    expect(resolved.mcp.resolveStyleVariables("dark")).toEqual(darkVars);
  });

  it("falls through to preset styleVariables when override omits them", () => {
    const resolved = resolveEffectiveHostStyle({
      hostStyle: "chatgpt",
      chatUiOverride: { label: "x" },
    });
    expect(resolved.mcp.resolveStyleVariables("light")).toEqual(
      CHATGPT_HOST_STYLE.mcp.resolveStyleVariables("light"),
    );
  });

  it("synthesizes a dispatcher component for an indicator override", () => {
    const resolved = resolveEffectiveHostStyle({
      hostStyle: "claude",
      chatUiOverride: {
        indicator: { kind: "dots", color: "#3b82f6", count: 2 },
      },
    });
    // Synthesized component is NOT the Claude one.
    expect(resolved.chatUi.loadingIndicator).not.toBe(
      CLAUDE_HOST_STYLE.chatUi.loadingIndicator,
    );
    // The component is a function (registered with a displayName).
    expect(typeof resolved.chatUi.loadingIndicator).toBe("function");
  });

  it("keeps the preset's loadingIndicator when override omits indicator", () => {
    const resolved = resolveEffectiveHostStyle({
      hostStyle: "claude",
      chatUiOverride: { label: "x" },
    });
    expect(resolved.chatUi.loadingIndicator).toBe(
      CLAUDE_HOST_STYLE.chatUi.loadingIndicator,
    );
  });

  it("supports override on top of MCPJam preset (no id required to be claude)", () => {
    const resolved = resolveEffectiveHostStyle({
      hostStyle: "mcpjam",
      chatUiOverride: { logoSrc: "/x.svg" },
    });
    expect(resolved.id).toBe("mcpjam");
    expect(resolved.chatUi.logoSrc).toBe("/x.svg");
    expect(resolved.chatUi.label).toBe(MCPJAM_HOST_STYLE.chatUi.label);
  });
});
