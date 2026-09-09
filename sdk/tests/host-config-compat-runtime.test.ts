import {
  readOpenAiCompatOverride,
  compatPresetForHostStyle,
  resolveOpenAiCompatForHostConfig,
  resolveOpenAiCompatCapabilitiesForHostConfig,
} from "../src/host-config/internal";
import { Host } from "../src/host-config/host";

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
      readOpenAiCompatOverride({ mcpProfile: { apps: {} } })
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
    expect(compatPresetForHostStyle("goose")).toBe(false);
  });

  it("returns undefined for unknown styles or non-string input", () => {
    expect(compatPresetForHostStyle("custom")).toBeUndefined();
    expect(compatPresetForHostStyle(undefined)).toBeUndefined();
    expect(compatPresetForHostStyle(42)).toBeUndefined();
    expect(compatPresetForHostStyle(null)).toBeUndefined();
  });

  it("returns undefined for styles colliding with Object.prototype keys", () => {
    // Must not read the inherited function — resolveOpenAiCompatForHostConfig
    // treats any non-undefined preset as authoritative.
    expect(compatPresetForHostStyle("toString")).toBeUndefined();
    expect(compatPresetForHostStyle("constructor")).toBeUndefined();
    expect(compatPresetForHostStyle("hasOwnProperty")).toBeUndefined();
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
      }
    );
    expect(result).toBe(false);
  });

  it("2. override hostStyle wins over base explicit + base style", () => {
    const result = resolveOpenAiCompatForHostConfig(
      {
        hostStyle: "chatgpt",
        mcpProfile: { apps: { compatRuntime: { openaiApps: true } } },
      },
      { hostStyle: "claude" }
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
    expect(resolveOpenAiCompatForHostConfig({ hostStyle: "chatgpt" })).toBe(
      true
    );
    expect(resolveOpenAiCompatForHostConfig({ hostStyle: "claude" })).toBe(
      false
    );
  });

  it("5. defaults to false when nothing matches", () => {
    expect(resolveOpenAiCompatForHostConfig(null)).toBe(false);
    expect(resolveOpenAiCompatForHostConfig({})).toBe(false);
    expect(resolveOpenAiCompatForHostConfig({ hostStyle: "custom" })).toBe(
      false
    );
  });

  it("treats override absent the same as no override", () => {
    expect(
      resolveOpenAiCompatForHostConfig({ hostStyle: "mcpjam" }, undefined)
    ).toBe(true);
  });
});

// Regression: the helpers historically only read the CANONICAL shape
// (`hostStyle`, `mcpProfile`). `HostRunner` now feeds them the PUBLIC
// shape produced by `Host.toJSON()` (`style`, `mcp`). Both shapes must
// resolve identically — otherwise `new Host({ style: "mcpjam" })`
// silently fails to opt into ChatGPT-style compat injection.
describe("HostJson shape (public API) compatibility", () => {
  it("readOpenAiCompatOverride accepts host.mcp.apps.compatRuntime.openaiApps", () => {
    const cfg = {
      mcp: { apps: { compatRuntime: { openaiApps: true } } },
    };
    expect(readOpenAiCompatOverride(cfg)).toBe(true);

    const cfgFalse = {
      mcp: { apps: { compatRuntime: { openaiApps: false } } },
    };
    expect(readOpenAiCompatOverride(cfgFalse)).toBe(false);
  });

  it("resolveOpenAiCompatForHostConfig accepts public `style` field", () => {
    expect(resolveOpenAiCompatForHostConfig({ style: "mcpjam" })).toBe(true);
    expect(resolveOpenAiCompatForHostConfig({ style: "chatgpt" })).toBe(true);
    expect(resolveOpenAiCompatForHostConfig({ style: "claude" })).toBe(false);
    expect(resolveOpenAiCompatForHostConfig({ style: "cursor" })).toBe(false);
  });

  it("resolveOpenAiCompatForHostConfig honors explicit override via host.mcp.* path", () => {
    // Style preset would say false, but explicit override says true.
    expect(
      resolveOpenAiCompatForHostConfig({
        style: "claude",
        mcp: { apps: { compatRuntime: { openaiApps: true } } },
      })
    ).toBe(true);
  });

  it("resolves correctly when fed a real Host.toJSON() snapshot", () => {
    const mcpjamHost = new Host({
      style: "mcpjam",
      model: "openai/gpt-4o",
    }).toJSON();
    expect(resolveOpenAiCompatForHostConfig(mcpjamHost)).toBe(true);

    const claudeHost = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
    }).toJSON();
    expect(resolveOpenAiCompatForHostConfig(claudeHost)).toBe(false);

    // Claude style with explicit opt-in via host.mcp.apps.compatRuntime
    const claudeOptIn = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
      mcp: { apps: { compatRuntime: { openaiApps: true } } },
    }).toJSON();
    expect(resolveOpenAiCompatForHostConfig(claudeOptIn)).toBe(true);
  });

  it("override using public `style` short-circuits a base canonical config", () => {
    // Base canonical config says claude (false); override says chatgpt (true).
    expect(
      resolveOpenAiCompatForHostConfig(
        { hostStyle: "claude" },
        { style: "chatgpt" }
      )
    ).toBe(true);
  });
});

describe("resolveOpenAiCompatCapabilitiesForHostConfig", () => {
  const withOverrides = (openaiAppsOverrides: Record<string, unknown>) => ({
    mcpProfile: {
      apps: { compatRuntime: { openaiApps: true, openaiAppsOverrides } },
    },
  });

  it("returns undefined when no host declares overrides", () => {
    // Not `{}`. The injector omits the field entirely for undefined, which is
    // what keeps the serialized runtime config byte-identical for the hosts
    // that declare nothing — i.e. almost all of them.
    expect(
      resolveOpenAiCompatCapabilitiesForHostConfig(undefined)
    ).toBeUndefined();
    expect(resolveOpenAiCompatCapabilitiesForHostConfig({})).toBeUndefined();
    expect(
      resolveOpenAiCompatCapabilitiesForHostConfig({
        mcpProfile: { apps: { compatRuntime: { openaiApps: true } } },
      })
    ).toBeUndefined();
  });

  it("reads the sparse turn-off set a host declares", () => {
    // ChatGPT's shape as of the 2026-09-02 probe: the method is gone from the
    // real `window.openai`, so the emulated one must not expose it either.
    expect(
      resolveOpenAiCompatCapabilitiesForHostConfig(
        withOverrides({ notifyIntrinsicHeight: false })
      )
    ).toEqual({ notifyIntrinsicHeight: false });
  });

  it("accepts the public `mcp` shape as well as canonical `mcpProfile`", () => {
    expect(
      resolveOpenAiCompatCapabilitiesForHostConfig({
        mcp: {
          apps: {
            compatRuntime: { openaiAppsOverrides: { requestModal: false } },
          },
        },
      })
    ).toEqual({ requestModal: false });
  });

  it("merges an override onto the base per key", () => {
    expect(
      resolveOpenAiCompatCapabilitiesForHostConfig(
        withOverrides({ notifyIntrinsicHeight: false, uploadFile: false }),
        withOverrides({ uploadFile: true })
      )
    ).toEqual({ notifyIntrinsicHeight: false, uploadFile: true });
  });

  it("keeps a base-only set when the override declares none", () => {
    expect(
      resolveOpenAiCompatCapabilitiesForHostConfig(
        withOverrides({ requestDisplayMode: "fullscreen-only" }),
        { hostStyle: "copilot" }
      )
    ).toEqual({ requestDisplayMode: "fullscreen-only" });
  });
});
