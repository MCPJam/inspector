import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalizeHostConfigV2,
  canonicalizePluginExtensionBehavior,
  PLUGIN_EXTENSION_BEHAVIOR_VALUES,
  PLUGIN_EXTENSION_CAPABILITY_KEYS,
  pluginExtensionStyleDefaults,
  readPluginExtensionBehavior,
  resolvePluginExtensionBehavior,
  resolvePluginExtensions,
} from "../src/host-config/internal";
import type {
  HostConfigInputV2,
  PluginExtensionsHostInput,
  ResolvedPluginExtensionBehavior,
} from "../src/host-config/internal";
import { HOST_TEMPLATES } from "../src/host-config/templates";

const CHATGPT: ResolvedPluginExtensionBehavior = {
  displayHints: "openai/ui",
  displayStart: "hint-first",
  entrypointVisibility: "ignore",
  entrypointWithoutFullscreen: "refuse",
  entrypointNames: "any",
  entrypointQuickActions: "show",
};
const CLAUDE: ResolvedPluginExtensionBehavior = {
  displayHints: "ui",
  displayStart: "inline-then-move",
  entrypointVisibility: "require-model",
  entrypointWithoutFullscreen: "inline",
  entrypointNames: "no-double-separators",
  entrypointQuickActions: "hide",
};

const withSetting = (
  pluginExtensions: unknown,
  rest: Omit<PluginExtensionsHostInput, "mcpProfile"> = {}
): PluginExtensionsHostInput => ({
  ...rest,
  mcpProfile: { profileVersion: 1, apps: { pluginExtensions } },
});

const onKeys = (input: PluginExtensionsHostInput | undefined) => {
  const { capabilities } = resolvePluginExtensions(input);
  return PLUGIN_EXTENSION_CAPABILITY_KEYS.filter((key) => capabilities[key]);
};

/**
 * The resolver as it was before the style table: ChatGPT, Codex and the
 * Codex harness on by default, and a saved setting turning on everything it
 * didn't switch off. Every style but Claude's must still resolve this way.
 */
function previousResolution(input: PluginExtensionsHostInput) {
  const apps = (input.mcpProfile as { apps?: Record<string, unknown> })?.apps;
  const setting = apps?.pluginExtensions as
    { enabled?: unknown; capabilities?: Record<string, unknown> } | undefined;
  const saved = typeof setting?.enabled === "boolean" ? setting : undefined;
  const enabled = saved
    ? saved.enabled === true
    : input.hostStyle === "chatgpt" ||
      input.hostStyle === "codex" ||
      input.harness === "codex";
  return Object.fromEntries(
    PLUGIN_EXTENSION_CAPABILITY_KEYS.map((key) => [
      key,
      enabled && saved?.capabilities?.[key] !== false,
    ])
  );
}

describe("canonicalizePluginExtensionBehavior", () => {
  it("accepts every value of every field and sorts the keys", () => {
    for (const [key, values] of Object.entries(
      PLUGIN_EXTENSION_BEHAVIOR_VALUES
    )) {
      for (const value of values) {
        expect(canonicalizePluginExtensionBehavior({ [key]: value })).toEqual({
          [key]: value,
        });
      }
    }
    const canonical = canonicalizePluginExtensionBehavior({
      entrypointQuickActions: "hide",
      displayStart: "inline-then-move",
      displayHints: "ui",
    });
    expect(JSON.stringify(canonical)).toBe(
      '{"displayHints":"ui","displayStart":"inline-then-move","entrypointQuickActions":"hide"}'
    );
  });

  it("collapses an empty object to absent", () => {
    expect(canonicalizePluginExtensionBehavior({})).toBeUndefined();
  });

  it.each([
    [
      null,
      "hostConfigV2: mcpProfile.apps.pluginExtensions.behavior must be a plain object",
    ],
    [
      ["ui"],
      "hostConfigV2: mcpProfile.apps.pluginExtensions.behavior must be a plain object",
    ],
    [
      "ui",
      "hostConfigV2: mcpProfile.apps.pluginExtensions.behavior must be a plain object",
    ],
    [
      { displayHint: "ui" },
      'hostConfigV2: mcpProfile.apps.pluginExtensions.behavior has unknown key "displayHint"',
    ],
    [
      { displayStart: "inline" },
      'hostConfigV2: mcpProfile.apps.pluginExtensions.behavior.displayStart must be one of "hint-first", "inline-then-move"',
    ],
    [
      { entrypointQuickActions: true },
      'hostConfigV2: mcpProfile.apps.pluginExtensions.behavior.entrypointQuickActions must be one of "show", "hide"',
    ],
    [
      // Keys are checked in sorted order, as the backend does.
      { zzz: 1, displayHints: "bogus" },
      'hostConfigV2: mcpProfile.apps.pluginExtensions.behavior.displayHints must be one of "openai/ui", "ui"',
    ],
  ])("refuses %j", (value, message) => {
    expect(() => canonicalizePluginExtensionBehavior(value)).toThrow(
      new Error(message)
    );
  });
});

describe("pluginExtensions canonical form with behavior", () => {
  const base = (pluginExtensions: unknown): HostConfigInputV2 =>
    ({
      hostStyle: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: {},
      hostContext: {},
      mcpProfile: { profileVersion: 1, apps: { pluginExtensions } },
    }) as HostConfigInputV2;
  const canonical = (pluginExtensions: unknown) =>
    JSON.stringify(
      canonicalizeHostConfigV2(base(pluginExtensions)).mcpProfile?.apps
        ?.pluginExtensions
    );

  it("emits behavior, capabilities, then enabled", () => {
    expect(
      canonical({
        enabled: true,
        capabilities: { forms: true },
        behavior: { displayStart: "hint-first" },
      })
    ).toBe(
      '{"behavior":{"displayStart":"hint-first"},"capabilities":{"forms":true},"enabled":true}'
    );
    expect(
      canonical({ behavior: { displayHints: "openai/ui" }, enabled: false })
    ).toBe('{"behavior":{"displayHints":"openai/ui"},"enabled":false}');
  });

  it("drops an empty behavior, so it hashes like no behavior", () => {
    expect(canonical({ enabled: true, behavior: {} })).toBe(
      canonical({ enabled: true })
    );
    expect(canonical({ enabled: true })).toBe('{"enabled":true}');
  });

  it("refuses a malformed behavior through the whole config", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ enabled: true, behavior: { displayStart: "later" } })
      )
    ).toThrow(/behavior\.displayStart must be one of/);
  });
});

describe("readPluginExtensionBehavior", () => {
  it("keeps the valid fields and drops the rest", () => {
    expect(
      readPluginExtensionBehavior({
        displayHints: "ui",
        displayStart: "sideways",
        unknown: "x",
      })
    ).toEqual({ displayHints: "ui" });
    expect(readPluginExtensionBehavior(null)).toEqual({});
    expect(readPluginExtensionBehavior(["ui"])).toEqual({});
  });
});

describe("style defaults", () => {
  it.each([
    ["chatgpt", undefined, true, 13, CHATGPT],
    ["codex", undefined, true, 13, CHATGPT],
    ["mcpjam", "codex", true, 13, CHATGPT],
    // The Codex harness is Codex, whatever style it is drawn in.
    ["claude", "codex", true, 13, CHATGPT],
    ["claude", undefined, true, 1, CLAUDE],
    ["claude-desktop", undefined, true, 1, CLAUDE],
    ["claude-code", "claude-code", false, 13, CHATGPT],
    ["cursor", undefined, false, 13, CHATGPT],
    ["vscode", undefined, false, 13, CHATGPT],
    ["mcpjam", undefined, false, 13, CHATGPT],
    ["constructor", undefined, false, 13, CHATGPT],
    [undefined, undefined, false, 13, CHATGPT],
  ] as const)(
    "%s (harness %s): master %s, %i extensions when on, its behavior",
    (hostStyle, harness, enabled, onCount, behavior) => {
      const defaults = pluginExtensionStyleDefaults({ hostStyle, harness });
      expect(defaults.enabled).toBe(enabled);
      expect(
        PLUGIN_EXTENSION_CAPABILITY_KEYS.filter(
          (key) => defaults.capabilities[key]
        )
      ).toHaveLength(onCount);
      expect(defaults.behavior).toEqual(behavior);
      expect(resolvePluginExtensionBehavior({ hostStyle, harness })).toEqual(
        behavior
      );
    }
  );

  it("turns on only Display modes for a Claude client", () => {
    for (const hostStyle of ["claude", "claude-desktop"])
      expect(onKeys({ hostStyle })).toEqual(["displayModes"]);
    expect(resolvePluginExtensionBehavior(undefined)).toEqual(CHATGPT);
  });
});

describe("resolvePluginExtensionBehavior", () => {
  it("uses each saved field over the style default", () => {
    expect(
      resolvePluginExtensionBehavior(
        withSetting(
          { enabled: true, behavior: { displayStart: "hint-first" } },
          { hostStyle: "claude" }
        )
      )
    ).toEqual({ ...CLAUDE, displayStart: "hint-first" });
    expect(
      resolvePluginExtensionBehavior(
        withSetting(
          {
            enabled: false,
            behavior: { displayHints: "ui", entrypointQuickActions: "hide" },
          },
          { hostStyle: "chatgpt" }
        )
      )
    ).toEqual({
      ...CHATGPT,
      displayHints: "ui",
      entrypointQuickActions: "hide",
    });
  });

  it("ignores malformed fields and a malformed setting", () => {
    expect(
      resolvePluginExtensionBehavior(
        withSetting(
          { enabled: true, behavior: { displayStart: "later", bogus: 1 } },
          { hostStyle: "claude" }
        )
      )
    ).toEqual(CLAUDE);
    expect(
      resolvePluginExtensionBehavior(
        withSetting(
          { behavior: { displayStart: "hint-first" } },
          { hostStyle: "claude" }
        )
      )
    ).toEqual(CLAUDE);
  });
});

describe("resolvePluginExtensions with the style table", () => {
  it("resolves an absent extension to the style's default", () => {
    // Saving a behavior, or switching the master off and on, keeps Claude's
    // choice of extensions instead of turning all of them on.
    expect(
      onKeys(
        withSetting(
          { enabled: true, behavior: { displayStart: "hint-first" } },
          { hostStyle: "claude" }
        )
      )
    ).toEqual(["displayModes"]);
    expect(
      onKeys(withSetting({ enabled: true }, { hostStyle: "claude" }))
    ).toEqual(["displayModes"]);
    expect(
      onKeys(
        withSetting(
          { enabled: true, capabilities: { forms: true, displayModes: false } },
          { hostStyle: "claude-desktop" }
        )
      )
    ).toEqual(["forms"]);
    expect(
      onKeys(withSetting({ enabled: false }, { hostStyle: "claude" }))
    ).toEqual([]);
  });

  it.each([
    ["ChatGPT", { hostStyle: "chatgpt" }],
    [
      "ChatGPT with one extension off",
      withSetting(
        { enabled: true, capabilities: { mentions: false } },
        { hostStyle: "chatgpt" }
      ),
    ],
    [
      "ChatGPT switched off",
      withSetting({ enabled: false }, { hostStyle: "chatgpt" }),
    ],
    ["Codex", { hostStyle: "codex", harness: "codex" }],
    [
      "Codex with forms off",
      withSetting(
        { enabled: true, capabilities: { forms: false } },
        { hostStyle: "codex" }
      ),
    ],
    ["Cursor", { hostStyle: "cursor" }],
    [
      "Cursor opted in",
      withSetting({ enabled: true }, { hostStyle: "cursor" }),
    ],
    [
      "Cursor opted in with one on",
      withSetting(
        {
          enabled: true,
          capabilities: Object.fromEntries(
            PLUGIN_EXTENSION_CAPABILITY_KEYS.filter((k) => k !== "forms").map(
              (k) => [k, false]
            )
          ),
        },
        { hostStyle: "cursor" }
      ),
    ],
  ] as const)("%s resolves as before", (_name, input) => {
    expect(resolvePluginExtensions(input).capabilities).toEqual(
      previousResolution(input)
    );
  });

  it("every non-Claude seed template and golden fixture row resolves as before", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = JSON.parse(
      readFileSync(
        join(here, "fixtures", "host-config-parity-fixtures.json"),
        "utf8"
      )
    ) as { rows: { input: PluginExtensionsHostInput }[] };
    const inputs: PluginExtensionsHostInput[] = [
      ...HOST_TEMPLATES.map((template) => template.seed()),
      ...fixture.rows.map((row) => row.input),
    ];
    const compared = inputs.filter(
      (input) =>
        input.harness === "codex" ||
        (input.hostStyle !== "claude" && input.hostStyle !== "claude-desktop")
    );
    expect(compared.length).toBeGreaterThan(20);
    for (const input of compared)
      expect(resolvePluginExtensions(input).capabilities).toEqual(
        previousResolution(input)
      );
  });
});
