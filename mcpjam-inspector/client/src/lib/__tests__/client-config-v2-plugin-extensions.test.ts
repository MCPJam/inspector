import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  filterOpenAiHostCapabilities,
  maskPluginAppHandle,
  PLUGIN_EXTENSIONS_OFF,
  pluginExtensionsForHost,
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
