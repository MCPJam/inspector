import { describe, it, expect } from "vitest";
import {
  seedHostTemplate,
  HOST_TEMPLATES,
  emptyHostConfigInputV2,
  type HostTemplateId,
} from "../src/host-config/templates/index.js";

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

  it("emptyHostConfigInputV2 deep-clones inputs (no aliasing)", () => {
    const caps = { extensions: { foo: { bar: 1 } } };
    const config = emptyHostConfigInputV2({ clientCapabilities: caps });
    (config.clientCapabilities as any).extensions.foo.bar = 999;
    expect(caps.extensions.foo.bar).toBe(1);
  });

  // Golden-output guard. The committed snapshot was captured when these seeds
  // were extracted from the inspector client, at which point a client-side
  // parity test verified them byte-identical to the pre-refactor
  // `seedFromHostTemplate` implementation (running against the live client
  // modules). It now locks the seed output so any accidental drift in the
  // extracted seeds — a changed default, a dropped field — fails CI and must
  // be re-blessed deliberately. `appVersion` is pinned so the snapshot is
  // deterministic.
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
