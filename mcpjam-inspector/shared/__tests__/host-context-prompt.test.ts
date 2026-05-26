import { describe, expect, it } from "vitest";
import {
  formatHostContextForSystemPrompt,
  withHostContextSystemPrompt,
} from "../host-context-prompt";

describe("formatHostContextForSystemPrompt", () => {
  it("returns undefined for empty / missing input", () => {
    expect(formatHostContextForSystemPrompt(undefined)).toBeUndefined();
    expect(formatHostContextForSystemPrompt(null)).toBeUndefined();
    expect(formatHostContextForSystemPrompt({})).toBeUndefined();
  });

  it("returns undefined when no recognized field has a value", () => {
    expect(
      formatHostContextForSystemPrompt({ unknown: "field", other: 42 }),
    ).toBeUndefined();
  });

  it("renders recognized fields in a deterministic order", () => {
    // Input order is reversed vs the canonical order — output should
    // still come out locale → timeZone → deviceCapabilities.
    const block = formatHostContextForSystemPrompt({
      deviceCapabilities: { hover: false, touch: true },
      timeZone: "America/Los_Angeles",
      locale: "en-US",
    });
    expect(block).toBe(
      [
        "<host_context>",
        "Locale: en-US",
        "Time zone: America/Los_Angeles",
        "Device capabilities: hover=false, touch=true",
        "</host_context>",
      ].join("\n"),
    );
  });

  it("skips unknown / malformed values without dropping known ones", () => {
    const block = formatHostContextForSystemPrompt({
      locale: "ja-JP",
      timeZone: 123, // wrong type, dropped
      deviceCapabilities: "not an object", // wrong type, dropped
      theme: "dark",
    });
    expect(block).toBe(
      ["<host_context>", "Locale: ja-JP", "Theme: dark", "</host_context>"].join(
        "\n",
      ),
    );
  });

  it("renders containerDimensions as WxH", () => {
    const block = formatHostContextForSystemPrompt({
      containerDimensions: { width: 1280, height: 800 },
    });
    expect(block).toContain("Container dimensions: 1280x800");
  });

  it("renders safeAreaInsets as side=N pairs", () => {
    const block = formatHostContextForSystemPrompt({
      safeAreaInsets: { top: 20, bottom: 12 },
    });
    expect(block).toContain("Safe area insets: top=20, bottom=12");
  });
});

describe("withHostContextSystemPrompt", () => {
  it("returns the original system when no hostContext is set", () => {
    expect(withHostContextSystemPrompt("you are a bot", {})).toBe(
      "you are a bot",
    );
    expect(withHostContextSystemPrompt("you are a bot", undefined)).toBe(
      "you are a bot",
    );
  });

  it("returns just the block when no system prompt is set", () => {
    const result = withHostContextSystemPrompt(undefined, {
      locale: "en-US",
    });
    expect(result).toBe(
      ["<host_context>", "Locale: en-US", "</host_context>"].join("\n"),
    );
  });

  it("prepends the block to the system prompt with a blank line separator", () => {
    const result = withHostContextSystemPrompt("you are a bot", {
      locale: "en-US",
    });
    expect(result).toBe(
      [
        "<host_context>",
        "Locale: en-US",
        "</host_context>",
        "",
        "you are a bot",
      ].join("\n"),
    );
  });

  it("returns undefined when both inputs produce nothing", () => {
    expect(withHostContextSystemPrompt(undefined, undefined)).toBeUndefined();
    expect(withHostContextSystemPrompt(undefined, {})).toBeUndefined();
    expect(
      withHostContextSystemPrompt(undefined, { irrelevant: true }),
    ).toBeUndefined();
  });

  it("treats empty/whitespace system prompt as absent and returns just the block", () => {
    const result = withHostContextSystemPrompt("   ", { locale: "en-US" });
    expect(result).toBe(
      ["<host_context>", "Locale: en-US", "</host_context>"].join("\n"),
    );
  });
});
