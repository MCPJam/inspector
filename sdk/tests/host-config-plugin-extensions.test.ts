import { describe, expect, it } from "vitest";
import {
  applyPluginExtensionsToClientCapabilities,
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
  PLUGIN_EXTENSION_CAPABILITY_KEYS,
  resolvePluginExtensions,
} from "../src/host-config/internal";
import type {
  HostConfigInputV2,
  HostConfigMcpProfileV1,
} from "../src/host-config/internal";
import { disabledPluginFeatures } from "../src/plugin-host/capabilities";
import { HOST_TEMPLATES } from "../src/host-config/templates";

const base = (mcpProfile?: HostConfigMcpProfileV1): HostConfigInputV2 =>
  ({
    hostStyle: "cursor",
    modelId: "openai/gpt-5-nano",
    systemPrompt: "",
    temperature: 0.7,
    requireToolApproval: false,
    serverIds: [],
    optionalServerIds: [],
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
    clientCapabilities: {},
    hostContext: {},
    ...(mcpProfile ? { mcpProfile } : {}),
  }) as HostConfigInputV2;

const profile = (pluginExtensions: unknown): HostConfigMcpProfileV1 =>
  ({
    profileVersion: 1,
    apps: { pluginExtensions },
  }) as HostConfigMcpProfileV1;

describe("mcpProfile.apps.pluginExtensions canonicalization", () => {
  it("keeps the setting, sorts capability keys, and changes the hash", async () => {
    const canonical = canonicalizeHostConfigV2(
      base(
        profile({
          enabled: true,
          capabilities: { mentions: false, forms: true },
        })
      )
    );
    expect(canonical.mcpProfile?.apps?.pluginExtensions).toEqual({
      capabilities: { forms: true, mentions: false },
      enabled: true,
    });
    expect(
      Object.keys(canonical.mcpProfile!.apps!.pluginExtensions!.capabilities!)
    ).toEqual(["forms", "mentions"]);

    const on = await computeHostConfigHashV2(base(profile({ enabled: true })));
    const off = await computeHostConfigHashV2(
      base(profile({ enabled: false }))
    );
    const absent = await computeHostConfigHashV2(base());
    expect(new Set([on, off, absent]).size).toBe(3);
  });

  it("collapses empty capabilities to absent", () => {
    const canonical = canonicalizeHostConfigV2(
      base(profile({ enabled: false, capabilities: {} }))
    );
    expect(canonical.mcpProfile?.apps?.pluginExtensions).toEqual({
      enabled: false,
    });
  });

  it.each([
    [{}, /enabled must be a boolean/],
    [{ enabled: "yes" }, /enabled must be a boolean/],
    [{ enabled: true, extra: 1 }, /unknown key "extra"/],
    [{ enabled: true, capabilities: { mention: false } }, /unknown key/],
    [{ enabled: true, capabilities: { forms: 1 } }, /must be a boolean/],
    [[], /must be a plain object/],
  ])("rejects malformed %j", (value, message) => {
    expect(() => canonicalizeHostConfigV2(base(profile(value)))).toThrow(
      message
    );
  });
});

describe("resolvePluginExtensions", () => {
  it("defaults on for ChatGPT, Codex and the Codex harness only", () => {
    expect(resolvePluginExtensions({ hostStyle: "chatgpt" }).enabled).toBe(
      true
    );
    expect(resolvePluginExtensions({ hostStyle: "codex" }).enabled).toBe(true);
    expect(
      resolvePluginExtensions({ hostStyle: "mcpjam", harness: "codex" })
        .enabled
    ).toBe(true);
    for (const hostStyle of [
      "cursor",
      "cursor-cli",
      "vscode",
      "mistral",
      "goose",
      "slack",
      "copilot",
      "n8n",
      "perplexity",
      "cline",
      "notion",
      "claude",
      "mcpjam",
    ]) {
      const resolved = resolvePluginExtensions({ hostStyle });
      expect(resolved.enabled, hostStyle).toBe(false);
      expect(Object.values(resolved.capabilities).some(Boolean)).toBe(false);
    }
    expect(resolvePluginExtensions(undefined).enabled).toBe(false);
  });

  it("an explicit setting wins over the style default", () => {
    const off = resolvePluginExtensions({
      hostStyle: "chatgpt",
      mcpProfile: profile({ enabled: false }),
    });
    expect(off).toMatchObject({ enabled: false, explicit: true });
    expect(Object.values(off.capabilities).some(Boolean)).toBe(false);

    const on = resolvePluginExtensions({
      hostStyle: "cursor",
      mcpProfile: profile({ enabled: true }),
    });
    expect(on.enabled).toBe(true);
    expect(Object.values(on.capabilities).every(Boolean)).toBe(true);
  });

  it("turning one capability off removes only that capability", () => {
    const resolved = resolvePluginExtensions({
      hostStyle: "codex",
      mcpProfile: profile({
        enabled: true,
        capabilities: { modelContext: false },
      }),
    });
    for (const key of PLUGIN_EXTENSION_CAPABILITY_KEYS) {
      expect(resolved.capabilities[key], key).toBe(key !== "modelContext");
    }
  });

  it("treats a malformed saved setting as not set", () => {
    expect(
      resolvePluginExtensions({
        hostStyle: "cursor",
        mcpProfile: { profileVersion: 1, apps: { pluginExtensions: {} } },
      })
    ).toMatchObject({ enabled: false, explicit: false });
  });
});

describe("applyPluginExtensionsToClientCapabilities", () => {
  const caps = {
    elicitation: { form: {} },
    extensions: {
      "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
      "openai/elicitation": { form: {} },
      "openai/form": {},
    },
  };

  it("keeps the OpenAI form claims while forms are on", () => {
    const resolved = resolvePluginExtensions({ hostStyle: "codex" });
    expect(applyPluginExtensionsToClientCapabilities(caps, resolved)).toEqual(
      caps
    );
  });

  it("removes only the OpenAI form claims when forms are off", () => {
    const resolved = resolvePluginExtensions({
      hostStyle: "codex",
      mcpProfile: profile({ enabled: true, capabilities: { forms: false } }),
    });
    expect(applyPluginExtensionsToClientCapabilities(caps, resolved)).toEqual({
      elicitation: { form: {} },
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    });
    // Input is not mutated.
    expect(caps.extensions["openai/form"]).toEqual({});
  });

  it("drops an extensions object left empty", () => {
    const resolved = resolvePluginExtensions({ hostStyle: "cursor" });
    expect(
      applyPluginExtensionsToClientCapabilities(
        { extensions: { "openai/form": {} } },
        resolved
      )
    ).toEqual({});
  });
});

describe("disabledPluginFeatures", () => {
  it("maps switched-off toggles to plugin features", () => {
    expect(
      disabledPluginFeatures({
        sidebarApps: false,
        localFiles: false,
        forms: false,
        mentions: true,
      })
    ).toEqual(["global-entrypoint", "file-open", "forms"]);
    expect(disabledPluginFeatures({})).toEqual([]);
  });
});

describe("seed templates", () => {
  const byId = (id: string) => HOST_TEMPLATES.find((t) => t.id === id)!;

  it("turn plugin extensions on for Codex and ChatGPT and leave others unset", () => {
    for (const template of HOST_TEMPLATES) {
      const seeded = template.seed() as unknown as Parameters<typeof resolvePluginExtensions>[0] & HostConfigInputV2;
      const resolved = resolvePluginExtensions(seeded);
      const expected = template.id === "codex" || template.id === "chatgpt";
      expect(resolved.enabled, template.id).toBe(expected);
      if (expected) expect(resolved.explicit, template.id).toBe(true);
    }
  });

  it("Codex advertises OpenAI's form extensions like the real 0.158 client", () => {
    const seeded = byId("codex").seed();
    const extensions = seeded.clientCapabilities.extensions as Record<
      string,
      unknown
    >;
    expect(extensions["openai/elicitation"]).toEqual({ form: {} });
    expect(extensions["openai/form"]).toEqual({});
    // And canonicalizes cleanly.
    expect(() => canonicalizeHostConfigV2(seeded)).not.toThrow();
  });
});
