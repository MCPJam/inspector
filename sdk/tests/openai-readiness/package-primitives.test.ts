/**
 * Brand colour, text-character and `agents/openai.yaml` primitives.
 *
 * The contrast cases are chosen for the trap they set: a colour can clear the
 * threshold comfortably against white and fail against the dark surface, so a
 * check that picked ONE background would pass it and half the users would not
 * be able to see it.
 */

import { describe, expect, it } from "vitest";

import {
  checkBrandColor,
  contrastRatio,
  parseHexColor,
  relativeLuminance,
} from "../../src/openai-readiness/package/color.js";
import {
  crossCheckToolDependencies,
  parseOpenAIAgentMetadata,
} from "../../src/openai-readiness/package/openai-agent-metadata.js";
import {
  findUnsupportedCharacters,
  hasSurroundingWhitespace,
  isSupportedText,
} from "../../src/openai-readiness/package/supported-text.js";
import { OPENAI_BRAND_COLOR_CONTRAST } from "../../src/openai-readiness/profile.js";

describe("parseHexColor", () => {
  it("accepts a six-digit hex value in either case", () => {
    expect(parseHexColor("#336699")).toEqual({ r: 0x33, g: 0x66, b: 0x99 });
    expect(parseHexColor("#AABBCC")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
    expect(parseHexColor("  #000000  ")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("rejects the three-digit shorthand", () => {
    // Valid CSS, and the portal does not take it. A preflight more lenient
    // than the thing it previews sends a submitter to upload a rejection.
    expect(parseHexColor("#369")).toBeUndefined();
  });

  it("rejects anything that is not exactly six hex digits", () => {
    for (const value of ["336699", "#3366999", "#gggggg", "rgb(1,2,3)", ""]) {
      expect(parseHexColor(value), value).toBeUndefined();
    }
  });
});

describe("contrast", () => {
  it("is symmetric and bounded by the black/white extremes", () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  it("matches the WCAG relative-luminance definition at the anchors", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 6);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6);
  });
});

describe("checkBrandColor grades against BOTH backgrounds", () => {
  it("passes a mid-tone that clears the threshold on each", () => {
    const result = checkBrandColor("#767676");
    expect(result.parsed).toBe(true);
    expect(result.lightRatio).toBeGreaterThan(1);
    expect(result.darkRatio).toBeGreaterThan(1);
    expect(result.worstRatio).toBe(
      Math.min(result.lightRatio!, result.darkRatio!),
    );
  });

  it("fails a near-black that is only legible on the light background", () => {
    // The trap: excellent against white, invisible against #212121.
    const result = checkBrandColor("#1A1A1A");
    expect(result.lightRatio).toBeGreaterThan(
      OPENAI_BRAND_COLOR_CONTRAST.minRatio,
    );
    expect(result.darkRatio).toBeLessThan(OPENAI_BRAND_COLOR_CONTRAST.minRatio);
    expect(result.passes).toBe(false);
  });

  it("fails a near-white that is only legible on the dark background", () => {
    const result = checkBrandColor("#FAFAFA");
    expect(result.darkRatio).toBeGreaterThan(
      OPENAI_BRAND_COLOR_CONTRAST.minRatio,
    );
    expect(result.lightRatio).toBeLessThan(
      OPENAI_BRAND_COLOR_CONTRAST.minRatio,
    );
    expect(result.passes).toBe(false);
  });

  it("reports an unparseable value without pretending it passed", () => {
    expect(checkBrandColor("blue")).toEqual({ parsed: false, passes: false });
  });
});

describe("supported text", () => {
  it("allows tab, newline and carriage return", () => {
    // A multi-line description legitimately contains newlines; flagging them
    // would fail nearly every real submission.
    expect(isSupportedText("line one\nline two\ttabbed\r\n")).toBe(true);
  });

  it("flags the invisible separators nobody expects", () => {
    // Written as escapes, never as literals. These characters are invisible in
    // every editor and a literal NUL turns this file into something `grep`
    // treats as binary — so the fixture has to spell them out to stay
    // reviewable and to survive a copy-paste.
    const found = findUnsupportedCharacters("before\u2028after\u2029end");
    expect(found).toEqual([
      { codePoint: "U+2028", index: 6, kind: "line-separator" },
      { codePoint: "U+2029", index: 12, kind: "paragraph-separator" },
    ]);
  });

  it("flags C0, DEL and C1 control characters", () => {
    expect(findUnsupportedCharacters("a\u0000b").map((c) => c.kind)).toEqual([
      "control",
    ]);
    expect(
      findUnsupportedCharacters("a\u007Fb").map((c) => c.codePoint),
    ).toEqual(["U+007F"]);
    expect(
      findUnsupportedCharacters("a\u0085b").map((c) => c.codePoint),
    ).toEqual(["U+0085"]);
  });

  it("reports code-unit indexes past an astral character", () => {
    // Iterating by code point but reporting a code-unit index is what lets a
    // caller slice the original string at the offset it was handed: the emoji
    // is two code units, so the separator after it is at index 2, not 1.
    const found = findUnsupportedCharacters("\u{1F600}\u2028");
    expect(found).toEqual([
      { codePoint: "U+2028", index: 2, kind: "line-separator" },
    ]);
  });

  it("leaves ordinary unicode alone", () => {
    expect(isSupportedText("Café — naïve 日本語 😀")).toBe(true);
  });

  it("reports surrounding whitespace without trimming it", () => {
    expect(hasSurroundingWhitespace("My Plugin ")).toBe(true);
    expect(hasSurroundingWhitespace("My Plugin")).toBe(false);
  });
});

describe("agents/openai.yaml", () => {
  const good = [
    "interface:",
    '  display_name: "Weather"',
    '  short_description: "Forecasts for any city"',
    "  icon_small: assets/icon-48.png",
    "  icon_large: assets/icon-512.png",
    '  brand_color: "#767676"',
    '  default_prompt: "What is the weather in Lisbon?"',
    "policy:",
    "  products:",
    "    - chatgpt",
    "    - codex",
    "  allow_implicit_invocation: false",
    "dependencies:",
    "  tools:",
    "    - type: mcp",
    "      value: weather",
    "      transport: http",
    "      url: https://weather.example.com/mcp",
  ].join("\n");

  it("reads the nested shape a flat frontmatter parser cannot", () => {
    const { metadata, issues } = parseOpenAIAgentMetadata(good);
    expect(issues).toEqual([]);
    expect(metadata?.interface.displayName).toBe("Weather");
    expect(metadata?.interface.brandColor).toBe("#767676");
    expect(metadata?.policy.products).toEqual(["chatgpt", "codex"]);
    expect(metadata?.policy.allowImplicitInvocation).toBe(false);
    expect(metadata?.dependencies.tools).toEqual([
      {
        type: "mcp",
        value: "weather",
        transport: "http",
        url: "https://weather.example.com/mcp",
      },
    ]);
  });

  it("reports malformed YAML as an issue rather than throwing", () => {
    const { metadata, issues } = parseOpenAIAgentMetadata(
      "interface:\n  display_name: [unclosed",
    );
    expect(metadata).toBeUndefined();
    expect(issues[0].path).toBe("(root)");
    expect(issues[0].message).toContain("not valid YAML");
  });

  it("distinguishes an empty document from a malformed one", () => {
    expect(parseOpenAIAgentMetadata("").issues[0].message).toBe("is empty");
    expect(parseOpenAIAgentMetadata("- a\n- b").issues[0].message).toBe(
      "must be a mapping at the top level",
    );
  });

  it("refuses to coerce a non-string into a text field", () => {
    // `brand_color: 0x336699` parses as a NUMBER. Coercing it would produce
    // the text "3368601" and then fail a hex check about the wrong thing.
    const { issues } = parseOpenAIAgentMetadata(
      "interface:\n  brand_color: 0x336699\n",
    );
    expect(issues).toContainEqual({
      path: "interface.brand_color",
      message: "must be a string, got number",
    });
  });

  it("refuses a quoted boolean for allow_implicit_invocation", () => {
    // Reading `"false"` as truthy would invert the one field deciding whether
    // ChatGPT may invoke this without being asked.
    const { issues } = parseOpenAIAgentMetadata(
      'policy:\n  allow_implicit_invocation: "false"\n',
    );
    expect(issues).toContainEqual({
      path: "policy.allow_implicit_invocation",
      message: "must be a boolean",
    });
  });

  it("enforces the interface field length limits", () => {
    const { issues } = parseOpenAIAgentMetadata(
      `interface:\n  display_name: "${"x".repeat(200)}"\n`,
    );
    expect(issues[0].path).toBe("interface.display_name");
    expect(issues[0].message).toContain("the maximum is");
  });

  it("flags unsupported characters and surrounding whitespace in a field", () => {
    const { issues } = parseOpenAIAgentMetadata(
      'interface:\n  display_name: "Weather\u2028 "\n',
    );
    expect(issues.map((issue) => issue.message).join(" ")).toContain("U+2028");
    expect(issues.map((issue) => issue.message).join(" ")).toContain(
      "trailing whitespace",
    );
  });

  it("flags a low-contrast brand colour with both ratios in the message", () => {
    const { issues } = parseOpenAIAgentMetadata(
      'interface:\n  brand_color: "#1A1A1A"\n',
    );
    expect(issues[0].path).toBe("interface.brand_color");
    expect(issues[0].message).toContain("contrasts");
  });

  it("requires a dependency type of mcp and an https url", () => {
    const { issues } = parseOpenAIAgentMetadata(
      [
        "dependencies:",
        "  tools:",
        "    - type: rest",
        "      value: weather",
        "      url: http://weather.example.com/mcp",
      ].join("\n"),
    );
    expect(issues).toContainEqual({
      path: "dependencies.tools[0].type",
      message: 'must be "mcp"; got "rest"',
    });
    expect(issues).toContainEqual({
      path: "dependencies.tools[0].url",
      message: "must be an https:// URL",
    });
  });

  it("reports a non-mapping section instead of silently skipping it", () => {
    const { issues } = parseOpenAIAgentMetadata("interface: not-a-mapping\n");
    expect(issues).toContainEqual({
      path: "interface",
      message: "must be a mapping",
    });
  });
});

describe("crossCheckToolDependencies", () => {
  const tool = (value: string) => ({ type: "mcp", value });

  it("passes when the two sides name the same servers", () => {
    expect(crossCheckToolDependencies([tool("weather")], ["weather"])).toEqual(
      [],
    );
  });

  it("reports a dependency on a server the package does not declare", () => {
    expect(
      crossCheckToolDependencies([tool("missing")], ["weather"]),
    ).toContainEqual({
      path: "dependencies.tools[0].value",
      message: 'names "missing", which the package declares no MCP server for',
    });
  });

  it("reports a declared server no dependency references", () => {
    // The direction that would otherwise stay invisible until a reviewer
    // noticed the plugin does nothing.
    expect(crossCheckToolDependencies([], ["weather"])).toContainEqual({
      path: "dependencies.tools",
      message: 'declares no dependency on the MCP server "weather"',
    });
  });

  it("ignores non-mcp dependencies when matching", () => {
    expect(
      crossCheckToolDependencies([{ type: "other", value: "weather" }], []),
    ).toEqual([]);
  });
});
