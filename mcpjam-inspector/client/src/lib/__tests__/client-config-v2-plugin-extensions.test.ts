import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  displayBehaviorForHost,
  filterOpenAiHostCapabilities,
  maskPluginAppHandle,
  PLUGIN_EXTENSION_CAPABILITY_KEYS,
  PLUGIN_EXTENSIONS_OFF,
  pluginExtensionsForHost,
  pluginExtensionProfileForHost,
  setPluginExtensionCapabilityOnDraft,
  setPluginExtensionsEnabledOnDraft,
} from "@/lib/client-config-v2-plugin-extensions";

const withSetting = (pluginExtensions: unknown) => ({
  profileVersion: 1 as const,
  apps: { pluginExtensions },
});

describe("pluginExtensionsForHost", () => {
  it("is on for ChatGPT and Codex and off for the rest of the ChatGPT family", () => {
    expect(pluginExtensionsForHost({ hostStyle: "chatgpt" }).enabled).toBe(
      true,
    );
    expect(pluginExtensionsForHost({ hostStyle: "codex" }).enabled).toBe(true);
    expect(
      pluginExtensionsForHost({ hostStyle: "mcpjam", harness: "codex" })
        .enabled,
    ).toBe(true);
    for (const hostStyle of ["cursor", "vscode", "mistral", "notion"]) {
      expect(pluginExtensionsForHost({ hostStyle }).enabled).toBe(false);
    }
    expect(pluginExtensionsForHost(null)).toEqual(PLUGIN_EXTENSIONS_OFF);
  });

  it("reads the saved setting", () => {
    const resolved = pluginExtensionsForHost({
      hostStyle: "chatgpt",
      mcpProfile: withSetting({
        enabled: true,
        capabilities: { messages: false },
      }),
    });
    expect(resolved.capabilities.messages).toBe(false);
    expect(resolved.capabilities.modelContext).toBe(true);
  });
});

describe("draft setters", () => {
  it("master off clears per-extension choices; master on keeps them", () => {
    let draft = emptyHostConfigInputV2({ hostStyle: "codex" });
    draft = setPluginExtensionCapabilityOnDraft(draft, "forms", false);
    expect(draft.mcpProfile?.apps?.pluginExtensions).toEqual({
      enabled: true,
      capabilities: { forms: false },
    });
    draft = setPluginExtensionsEnabledOnDraft(draft, false);
    expect(draft.mcpProfile?.apps?.pluginExtensions).toEqual({
      enabled: false,
    });
    draft = setPluginExtensionsEnabledOnDraft(draft, true);
    expect(draft.mcpProfile?.apps?.pluginExtensions).toEqual({
      enabled: true,
    });
  });

  it("keeps sibling Apps settings", () => {
    const draft = setPluginExtensionsEnabledOnDraft(
      emptyHostConfigInputV2({
        hostStyle: "cursor",
        mcpProfile: {
          profileVersion: 1,
          apps: { sandbox: { browserStorage: { indexedDB: false } } },
        },
      }),
      true,
    );
    expect(draft.mcpProfile?.apps).toEqual({
      sandbox: { browserStorage: { indexedDB: false } },
      pluginExtensions: { enabled: true },
    });
    const back = setPluginExtensionsEnabledOnDraft(draft, false);
    expect(back.mcpProfile?.apps).toEqual({
      sandbox: { browserStorage: { indexedDB: false } },
    });
  });

  it("switching an extension off while everything is off is a no-op", () => {
    const draft = emptyHostConfigInputV2({ hostStyle: "cursor" });
    expect(setPluginExtensionCapabilityOnDraft(draft, "forms", false)).toBe(
      draft,
    );
  });
});

describe("draft setters on a Claude client", () => {
  const on = (draft: ReturnType<typeof emptyHostConfigInputV2>) => {
    const { capabilities } = pluginExtensionsForHost(draft);
    return PLUGIN_EXTENSION_CAPABILITY_KEYS.filter((key) => capabilities[key]);
  };
  const saved = (draft: ReturnType<typeof emptyHostConfigInputV2>) =>
    draft.mcpProfile?.apps?.pluginExtensions;

  it("one toggle changes one switch, storing only what differs from Claude's defaults", () => {
    let draft = emptyHostConfigInputV2({ hostStyle: "claude" });
    expect(on(draft)).toEqual(["displayModes"]);
    draft = setPluginExtensionCapabilityOnDraft(draft, "forms", true);
    expect(saved(draft)).toEqual({
      enabled: true,
      capabilities: { forms: true },
    });
    expect(on(draft)).toEqual(["displayModes", "forms"]);
    draft = setPluginExtensionCapabilityOnDraft(draft, "displayModes", false);
    expect(on(draft)).toEqual(["forms"]);
    draft = setPluginExtensionCapabilityOnDraft(draft, "forms", false);
    draft = setPluginExtensionCapabilityOnDraft(draft, "displayModes", true);
    expect(saved(draft)).toEqual({ enabled: true });
    expect(on(draft)).toEqual(["displayModes"]);
  });

  it("master off then on brings back Claude's defaults", () => {
    let draft = setPluginExtensionCapabilityOnDraft(
      emptyHostConfigInputV2({ hostStyle: "claude-desktop" }),
      "messages",
      true,
    );
    draft = setPluginExtensionsEnabledOnDraft(draft, false);
    expect(saved(draft)).toEqual({ enabled: false });
    expect(on(draft)).toEqual([]);
    draft = setPluginExtensionsEnabledOnDraft(draft, true);
    expect(saved(draft)).toEqual({ enabled: true });
    expect(on(draft)).toEqual(["displayModes"]);
  });

  it("switching one on while the master is off turns on only that one", () => {
    let draft = setPluginExtensionsEnabledOnDraft(
      emptyHostConfigInputV2({ hostStyle: "claude" }),
      false,
    );
    draft = setPluginExtensionCapabilityOnDraft(draft, "forms", true);
    expect(saved(draft)).toEqual({
      enabled: true,
      capabilities: { displayModes: false, forms: true },
    });
    expect(on(draft)).toEqual(["forms"]);
  });

  it("keeps a saved behavior through every write", () => {
    const behavior = { displayStart: "hint-first" as const };
    const withBehavior = (hostStyle: string) =>
      emptyHostConfigInputV2({
        hostStyle,
        mcpProfile: {
          profileVersion: 1,
          apps: { pluginExtensions: { enabled: true, behavior } },
        },
      });
    let draft = setPluginExtensionCapabilityOnDraft(
      withBehavior("claude"),
      "forms",
      true,
    );
    expect(saved(draft)).toEqual({
      behavior,
      capabilities: { forms: true },
      enabled: true,
    });
    draft = setPluginExtensionsEnabledOnDraft(draft, false);
    expect(saved(draft)).toEqual({ behavior, enabled: false });
    draft = setPluginExtensionCapabilityOnDraft(draft, "settings", true);
    expect(saved(draft)?.behavior).toEqual(behavior);
    draft = setPluginExtensionsEnabledOnDraft(draft, true);
    expect(saved(draft)?.behavior).toEqual(behavior);
    // An off-by-default style keeps its behavior instead of collapsing.
    expect(
      saved(setPluginExtensionsEnabledOnDraft(withBehavior("cursor"), false)),
    ).toEqual({ behavior, enabled: false });
  });

  it("collapses Cursor back to not set as before", () => {
    let draft = setPluginExtensionsEnabledOnDraft(
      emptyHostConfigInputV2({ hostStyle: "cursor" }),
      true,
    );
    expect(saved(draft)).toEqual({ enabled: true });
    draft = setPluginExtensionsEnabledOnDraft(draft, false);
    expect(draft.mcpProfile).toBeUndefined();
  });
});

describe("displayBehaviorForHost", () => {
  it("follows each client's style, saved behavior and Display modes switch", () => {
    expect(displayBehaviorForHost({ hostStyle: "chatgpt" })).toEqual({
      hints: "openai/ui",
      start: "hint-first",
    });
    expect(displayBehaviorForHost({ hostStyle: "claude" })).toEqual({
      hints: "ui",
      start: "inline-then-move",
    });
    expect(
      displayBehaviorForHost({
        hostStyle: "claude",
        mcpProfile: withSetting({
          enabled: true,
          behavior: { displayStart: "hint-first" },
        }),
      }),
    ).toEqual({ hints: "ui", start: "hint-first" });
    expect(displayBehaviorForHost({ hostStyle: "cursor" })).toBeUndefined();
    expect(
      displayBehaviorForHost({
        hostStyle: "claude",
        mcpProfile: withSetting({
          enabled: true,
          capabilities: { displayModes: false },
        }),
      }),
    ).toBeUndefined();
    expect(displayBehaviorForHost(null)).toBeUndefined();
  });

  it("returns the same object for the same behavior", () => {
    expect(displayBehaviorForHost({ hostStyle: "claude" })).toBe(
      displayBehaviorForHost({ hostStyle: "claude-desktop" }),
    );
  });
});

describe("App-facing narrowing", () => {
  const resolved = pluginExtensionsForHost({
    hostStyle: "chatgpt",
    mcpProfile: withSetting({
      enabled: true,
      capabilities: { modelContext: false, localFiles: false, deepLinks: false },
    }),
  });

  it("masks only the handle grants whose extension is off", () => {
    const handle = {
      instanceToken: "t",
      contextEnabled: true,
      messageEnabled: true,
      localFilesAvailable: true,
      deepLinkNamespace: { pluginId: "p", runtime: "chatgpt" as const },
    };
    const masked = maskPluginAppHandle(handle, resolved);
    expect(masked).toEqual({
      instanceToken: "t",
      contextEnabled: false,
      messageEnabled: true,
      localFilesAvailable: false,
    });
    // Original untouched.
    expect(handle.contextEnabled).toBe(true);
  });

  it("filters openai/* experimental claims for switched-off extensions", () => {
    const filtered = filterOpenAiHostCapabilities(
      {
        updateModelContext: { text: {} },
        experimental: {
          "openai/modelContext": {},
          "openai/message": {},
          "openai/files": {},
          other: {},
        },
      },
      resolved,
    );
    expect(filtered).toEqual({
      updateModelContext: { text: {} },
      experimental: { "openai/message": {}, other: {} },
    });
    expect(
      filterOpenAiHostCapabilities(
        { experimental: { "openai/files": {} } },
        resolved,
      ),
    ).toEqual({});
  });
});

describe("pluginExtensionProfileForHost", () => {
  it("keeps ChatGPT App behavior when Codex owns its agent loop", () => {
    expect(
      pluginExtensionProfileForHost({ hostStyle: "chatgpt", agentLoop: "codex" }),
    ).toBe("chatgpt");
    expect(
      pluginExtensionProfileForHost({ hostStyle: "codex", harness: "codex" }),
    ).toBe("codex");
  });
});
