import {
  readOpenAiCompatOverride,
  compatPresetForHostStyle,
  resolveOpenAiCompatForHostConfig,
} from "../src/host-config/internal";

describe("readOpenAiCompatOverride", () => {
  it("returns undefined for non-record input", () => {
    expect(readOpenAiCompatOverride(null)).toBeUndefined();
    expect(readOpenAiCompatOverride("string")).toBeUndefined();
    expect(readOpenAiCompatOverride(42)).toBeUndefined();
    expect(readOpenAiCompatOverride([])).toBeUndefined();
  });

  it("returns undefined when mcpProfile.apps.compatRuntime path is absent", () => {
    expect(readOpenAiCompatOverride({})).toBeUndefined();
    expect(readOpenAiCompatOverride({ mcpProfile: {} })).toBeUndefined();
    expect(
      readOpenAiCompatOverride({ mcpProfile: { apps: {} } }),
    ).toBeUndefined();
  });

  it("returns the boolean when the openaiApps flag is set", () => {
    const cfg = {
      mcpProfile: { apps: { compatRuntime: { openaiApps: true } } },
    };
    expect(readOpenAiCompatOverride(cfg)).toBe(true);

    const cfgFalse = {
      mcpProfile: { apps: { compatRuntime: { openaiApps: false } } },
    };
    expect(readOpenAiCompatOverride(cfgFalse)).toBe(false);
  });

  it("returns undefined when openaiApps is not a boolean", () => {
    const cfg = {
      mcpProfile: { apps: { compatRuntime: { openaiApps: "yes" } } },
    };
    expect(readOpenAiCompatOverride(cfg)).toBeUndefined();
  });
});

describe("compatPresetForHostStyle", () => {
  it("returns true for chatgpt-family styles", () => {
    expect(compatPresetForHostStyle("chatgpt")).toBe(true);
    expect(compatPresetForHostStyle("copilot")).toBe(true);
    expect(compatPresetForHostStyle("mcpjam")).toBe(true);
  });

  it("returns false for claude-family styles", () => {
    expect(compatPresetForHostStyle("claude")).toBe(false);
    expect(compatPresetForHostStyle("cursor")).toBe(false);
    expect(compatPresetForHostStyle("codex")).toBe(false);
  });

  it("returns undefined for unknown styles or non-string input", () => {
    expect(compatPresetForHostStyle("custom")).toBeUndefined();
    expect(compatPresetForHostStyle(undefined)).toBeUndefined();
    expect(compatPresetForHostStyle(42)).toBeUndefined();
    expect(compatPresetForHostStyle(null)).toBeUndefined();
  });
});

describe("resolveOpenAiCompatForHostConfig — resolution order", () => {
  // Order: override explicit > override style > base explicit > base style > false

  it("1. explicit override profile wins over everything", () => {
    const result = resolveOpenAiCompatForHostConfig(
      {
        hostStyle: "chatgpt",
        mcpProfile: { apps: { compatRuntime: { openaiApps: true } } },
      },
      {
        hostStyle: "chatgpt",
        mcpProfile: { apps: { compatRuntime: { openaiApps: false } } },
      },
    );
    expect(result).toBe(false);
  });

  it("2. override hostStyle wins over base explicit + base style", () => {
    const result = resolveOpenAiCompatForHostConfig(
      {
        hostStyle: "chatgpt",
        mcpProfile: { apps: { compatRuntime: { openaiApps: true } } },
      },
      { hostStyle: "claude" },
    );
    expect(result).toBe(false);
  });

  it("3. base explicit wins over base style when no override", () => {
    const result = resolveOpenAiCompatForHostConfig({
      hostStyle: "claude",
      mcpProfile: { apps: { compatRuntime: { openaiApps: true } } },
    });
    expect(result).toBe(true);
  });

  it("4. base hostStyle preset applies when nothing else set", () => {
    expect(
      resolveOpenAiCompatForHostConfig({ hostStyle: "chatgpt" }),
    ).toBe(true);
    expect(
      resolveOpenAiCompatForHostConfig({ hostStyle: "claude" }),
    ).toBe(false);
  });

  it("5. defaults to false when nothing matches", () => {
    expect(resolveOpenAiCompatForHostConfig(null)).toBe(false);
    expect(resolveOpenAiCompatForHostConfig({})).toBe(false);
    expect(resolveOpenAiCompatForHostConfig({ hostStyle: "custom" })).toBe(false);
  });

  it("treats override absent the same as no override", () => {
    expect(
      resolveOpenAiCompatForHostConfig({ hostStyle: "mcpjam" }, undefined),
    ).toBe(true);
  });
});
