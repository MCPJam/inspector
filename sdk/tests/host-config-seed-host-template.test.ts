import { describe, it, expect } from "vitest";
import {
  seedHostTemplate,
  HOST_TEMPLATES,
  emptyHostConfigInputV2,
  type HostTemplateId,
} from "../src/host-config/templates/index.js";
import { XAA_MCP_EXTENSION } from "../src/xaa/mcp-init.js";
import { readXaaEnterprisePolicy } from "../src/xaa/enterprise-policy.js";

const ALL_IDS: HostTemplateId[] = [
  "mcpjam",
  "claude",
  "claude-code",
  "chatgpt",
  "mistral",
  "goose",
  "slack",
  "cursor",
  "codex",
  "copilot",
  "vscode",
  "agentcore",
  "n8n",
  "perplexity",
  "cline",
  "notion",
];

describe("seedHostTemplate", () => {
  it("exposes one HOST_TEMPLATES entry per id", () => {
    expect(HOST_TEMPLATES.map((t) => t.id).sort()).toEqual([...ALL_IDS].sort());
  });

  it("seeds a usable config for every template id and theme", () => {
    for (const id of ALL_IDS) {
      for (const theme of ["light", "dark"] as const) {
        const config = seedHostTemplate(id, { theme });
        expect(typeof config.hostStyle).toBe("string");
        expect(config.serverIds).toEqual([]);
        // clientCapabilities is always seeded (MCP UI extension etc.).
        expect(config.clientCapabilities).toBeTypeOf("object");
      }
    }
  });

  // The MCPJam persona is the inspector's own client and supports the full
  // XAA path, so it declares the enterprise-managed-authorization extension.
  // Every real-host persona must NOT — a seed refactor that leaks the key
  // into inheriting templates (claude/chatgpt/cursor/copilot/vscode all
  // derive their clientCapabilities from the empty-input base) fails here.
  it("advertises EMA on the mcpjam template and on no other", () => {
    for (const id of ALL_IDS) {
      const config = seedHostTemplate(id, { theme: "dark" });
      const exts = (config.clientCapabilities as { extensions?: unknown })
        ?.extensions;
      const hasEma =
        typeof exts === "object" &&
        exts !== null &&
        Object.prototype.hasOwnProperty.call(exts, XAA_MCP_EXTENSION);
      expect(hasEma, `template ${id}`).toBe(id === "mcpjam");
    }
    // The MCP UI default rides along untouched on the mcpjam seed.
    const mcpjam = seedHostTemplate("mcpjam", { theme: "dark" });
    const mcpjamExts = (
      mcpjam.clientCapabilities as { extensions: Record<string, unknown> }
    ).extensions;
    expect(mcpjamExts["io.modelcontextprotocol/ui"]).toBeDefined();
    expect(mcpjamExts[XAA_MCP_EXTENSION]).toEqual({});
  });

  // The enterprise-managed POLICY (com.mcpjam/enterprise-managed-auth under
  // mcpProfile.extensions) is opt-in per host — OFF for EVERY persona,
  // mcpjam included (product decision 2026-07-14). Unlike the EMA
  // *capability* above (mcpjam alone advertises support), no seed may carry
  // the policy; this guards against a future seed change enabling
  // enforcement-by-default.
  it("seeds the enterprise-managed policy on NO persona", () => {
    for (const id of ALL_IDS) {
      const state = readXaaEnterprisePolicy(seedHostTemplate(id).mcpProfile);
      expect(state.kind, `template ${id}`).toBe("off");
    }
  });

  it("matches the documented model + style for the claude template", () => {
    const config = seedHostTemplate("claude", { theme: "dark" });
    expect(config.hostStyle).toBe("claude");
    expect(config.modelId).toBe("anthropic/claude-haiku-4.5");
  });

  it("seeds the real Claude Code harness + a personal computer", () => {
    const config = seedHostTemplate("claude-code", { theme: "dark" });
    expect(config.hostStyle).toBe("claude-code");
    expect(config.modelId).toBe("anthropic/claude-haiku-4.5");
    expect(config.harness).toBe("claude-code");
    expect(config.computer).toEqual({ kind: "personal" });
    // requireToolApproval must be false — the harness rejects approval-gated turns.
    expect(config.requireToolApproval).toBe(false);
    expect(config.progressiveToolDiscovery).toBe(false);
  });

  it("seeds the real Codex harness + a personal computer", () => {
    const config = seedHostTemplate("codex", { theme: "dark" });
    expect(config.hostStyle).toBe("codex");
    expect(config.harness).toBe("codex");
    expect(config.computer).toEqual({ kind: "personal" });
    // Codex (like Claude Code) can't pause for interactive approval.
    expect(config.requireToolApproval).toBe(false);
  });

  it("threads appVersion into the mcpjam template (and only it)", () => {
    const mcpjam = seedHostTemplate("mcpjam", { appVersion: "9.9.9" });
    const profile = mcpjam.mcpProfile as Record<string, any>;
    expect(mcpjam.modelId).toBe("anthropic/claude-haiku-4.5");
    expect(profile.initialize.clientInfo.version).toBe("9.9.9");
    expect(profile.apps.uiInitialize.hostInfo.version).toBe("9.9.9");

    // The claude template pins a literal version — appVersion must not leak in.
    const claude = seedHostTemplate("claude", { appVersion: "9.9.9" });
    const claudeProfile = claude.mcpProfile as Record<string, any>;
    expect(claudeProfile.apps.uiInitialize.hostInfo.version).toBe("1.0.0");
  });

  it("reflects theme in the seeded hostContext styles", () => {
    const light = seedHostTemplate("mcpjam", { theme: "light" });
    const dark = seedHostTemplate("mcpjam", { theme: "dark" });
    expect((light.hostContext as any).theme).toBe("light");
    expect((dark.hostContext as any).theme).toBe("dark");
    expect(light.hostContext).not.toEqual(dark.hostContext);
  });

  it("keeps Goose HostContext style variables faithful to the raw probe", () => {
    const config = seedHostTemplate("goose", { theme: "dark" });
    const variables = (config.hostContext as any).styles.variables;

    expect(variables["--color-text-primary"]).toBe(
      "light-dark(#3f434b, #ffffff)"
    );
    expect(variables["--color-background-primary"]).toBe(
      "light-dark(#ffffff, #22252a)"
    );
  });

  it("keeps ChatGPT raw host capabilities faithful to the probe", () => {
    const config = seedHostTemplate("chatgpt", { theme: "dark" });

    expect(config.hostCapabilitiesOverride).toMatchObject({
      serverResources: {},
      logging: {},
    });
    expect(config.hostCapabilitiesOverride).not.toHaveProperty("downloadFile");
  });

  it("labels and persists the Copilot 1.0.1 documented runtime surface", () => {
    const config = seedHostTemplate("copilot", { theme: "dark" });
    const profile = config.mcpProfile;

    expect(profile?.initialize?.clientInfo).toEqual({
      name: "ms-copilot",
      version: "1.0.1",
    });
    expect(profile?.apps?.uiInitialize?.hostInfo).toEqual({
      name: "Copilot",
      version: "1.0.1",
    });
    expect(profile?.apps?.compatRuntime).toMatchObject({
      openaiApps: true,
      openaiAppsOverrides: {
        callTool: true,
        sendFollowUpMessage: true,
        requestDisplayMode: "fullscreen-only",
        uploadFile: false,
        getFileDownloadUrl: false,
        requestModal: false,
      },
    });
    expect(config.hostCapabilitiesOverride).toEqual({
      openLinks: {},
      serverTools: {},
      message: { text: {} },
      updateModelContext: { text: {} },
    });
  });

  it("keeps Goose host capabilities faithful to the raw probe", () => {
    const config = seedHostTemplate("goose", { theme: "dark" });
    const apps = config.mcpProfile?.apps as any;

    expect(config.hostCapabilitiesOverride).toEqual({ openLinks: {} });
    expect(apps?.mcpAppsOverrides).toMatchObject({
      openLinks: true,
      serverTools: false,
      serverResources: false,
      logging: false,
      updateModelContext: false,
      message: false,
      sandboxPermissions: false,
      cspFrameDomains: false,
      cspBaseUriDomains: false,
      resourcePrefersBorder: false,
      downloadFile: false,
      requestTeardown: false,
    });
  });

  it("keeps Slack HostContext and capabilities faithful to the raw probe", () => {
    const config = seedHostTemplate("slack", { theme: "dark" });
    const apps = config.mcpProfile?.apps as any;

    expect(config.clientCapabilities).toEqual({
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    });
    expect(config.hostCapabilitiesOverride).toEqual({
      openLinks: {},
      serverTools: {},
      serverResources: {},
      logging: {},
    });
    expect((config.hostContext as any).theme).toBe("dark");
    expect((config.hostContext as any).containerDimensions).toEqual({
      maxWidth: 598,
    });
    expect((config.hostContext as any).styles.variables["--font-sans"]).toBe(
      '"Slack-Lato", "Slack-Fractions", "appleLogo", sans-serif'
    );
    expect(
      (config.hostContext as any).styles.variables["--color-background-primary"]
    ).toBe("#1a1d21");
    expect(
      (config.hostContext as any).styles.variables["--color-text-primary"]
    ).toBe("#f8f8f8");
    expect(apps?.uiInitialize?.hostInfo).toEqual({
      name: "Slackbot",
      version: "1.0.0",
    });
    expect(apps?.compatRuntime).toEqual({ openaiApps: false });
    expect(apps?.mcpAppsOverrides).toMatchObject({
      availableDisplayModes: ["inline", "fullscreen"],
      toolInputPartial: false,
      toolInfo: true,
      openLinks: true,
      serverTools: true,
      serverResources: true,
      logging: true,
      updateModelContext: false,
      message: false,
      sandboxPermissions: false,
    });
  });

  it("keeps VS Code 1.130 handshake facts and emulator defaults", () => {
    const config = seedHostTemplate("vscode", { theme: "dark" });
    const profile = config.mcpProfile;
    const hostContext = config.hostContext as {
      styles: { variables: Record<string, string> };
    };

    expect(config.clientCapabilities).toMatchObject({
      roots: { listChanged: true },
      sampling: {},
      elicitation: { form: {}, url: {} },
      tasks: {
        list: {},
        cancel: {},
        requests: {
          sampling: { createMessage: {} },
          elicitation: { create: {} },
        },
      },
    });
    expect(config.hostCapabilitiesOverride).toMatchObject({
      serverTools: { listChanged: true },
      serverResources: { listChanged: true },
      updateModelContext: {
        audio: {},
        image: {},
        resourceLink: {},
        resource: {},
        structuredContent: {},
      },
      downloadFile: {},
    });
    expect(config.hostContext).toMatchObject({
      theme: "dark",
      availableDisplayModes: ["inline"],
      containerDimensions: { width: 494, maxHeight: 720 },
      locale: "en-us",
      deviceCapabilities: { touch: false, hover: true },
    });
    expect(hostContext.styles.variables["--font-text-md-size"]).toBe("13px");
    expect(profile?.initialize).toEqual({
      supportedProtocolVersions: ["2025-11-25"],
      clientInfo: { name: "Visual Studio Code", version: "1.130.0" },
    });
    expect(profile?.apps?.uiInitialize?.hostInfo).toEqual({
      name: "Visual Studio Code",
      version: "1.130.0",
    });
    expect(profile?.apps?.compatRuntime).toEqual({ openaiApps: false });
    expect(profile?.apps?.mcpAppsOverrides).toMatchObject({
      availableDisplayModes: ["inline"],
      toolInputPartial: true,
      toolCancelled: true,
      hostContextChanged: true,
      resourceTeardown: true,
      toolInfo: false,
      updateModelContext: true,
      message: false,
      cspFrameDomains: true,
      cspBaseUriDomains: true,
      resourcePrefersBorder: true,
      requestTeardown: true,
      widgetDisplayModeRequests: "accept",
    });
    expect(profile?.apps?.sandbox?.sandboxAttrs).toEqual([
      "allow-pointer-lock",
      "allow-downloads",
      "allow-forms",
    ]);
    expect(profile?.apps?.sandbox?.csp).toEqual({ mode: "declared" });
  });

  it("emptyHostConfigInputV2 deep-clones inputs (no aliasing)", () => {
    const caps = { extensions: { foo: { bar: 1 } } };
    const config = emptyHostConfigInputV2({ clientCapabilities: caps });
    (config.clientCapabilities as any).extensions.foo.bar = 999;
    expect(caps.extensions.foo.bar).toBe(1);
  });

  it("emptyHostConfigInputV2 leaves skillSelection absent by default and clones it when seeded", () => {
    // Absent stays absent — a fresh seed must hash byte-identically to a
    // pre-feature seed (the canonicalizer omits an absent skillSelection).
    const fresh = emptyHostConfigInputV2();
    expect("skillSelection" in fresh).toBe(false);

    const skillSelection = {
      mode: "explicit" as const,
      skillIds: ["sk-1"],
    };
    const seeded = emptyHostConfigInputV2({ skillSelection });
    expect(seeded.skillSelection).toEqual({
      mode: "explicit",
      skillIds: ["sk-1"],
    });
    // Cloned, not aliased.
    skillSelection.skillIds.push("sk-2");
    expect(seeded.skillSelection).toEqual({
      mode: "explicit",
      skillIds: ["sk-1"],
    });
  });

  // Golden-output guard. The committed snapshot was captured when these seeds
  // were extracted from the old inspector client template adapter. It now locks
  // the fallback seed output so any accidental drift — a changed default, a
  // dropped field — fails CI and must be re-blessed deliberately. `appVersion`
  // is pinned so the snapshot is deterministic.
  it("seed output matches the committed golden snapshot", () => {
    const golden: Record<string, unknown> = {};
    for (const id of ALL_IDS) {
      for (const theme of ["light", "dark"] as const) {
        golden[`${id}/${theme}`] = seedHostTemplate(id, {
          theme,
          appVersion: "0.0.0-test",
        });
      }
    }
    expect(golden).toMatchSnapshot();
  });
});
