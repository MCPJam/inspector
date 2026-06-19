import { describe, expect, it, vi } from "vitest";
import {
  CHATGPT_HOST_STYLE,
  CLAUDE_HOST_STYLE,
  CLAUDE_CODE_HOST_STYLE,
  CODEX_HOST_STYLE,
  COPILOT_HOST_STYLE,
  DEFAULT_HOST_STYLE,
  GOOSE_HOST_STYLE,
  MCPJAM_HOST_STYLE,
  N8N_HOST_STYLE,
  PERPLEXITY_HOST_STYLE,
  SPEC_DEFAULT_HOST_CAPABILITIES,
  findHostStyle,
  getHostCapabilitiesForStyle,
  getHostStyleOrDefault,
  isKnownHostStyleId,
  listHostStyles,
  registerHostStyle,
  type HostStyleDefinition,
} from "..";

describe("host-styles registry", () => {
  it("registers built-in host styles by id", () => {
    expect(findHostStyle("mcpjam")).toBe(MCPJAM_HOST_STYLE);
    expect(findHostStyle("claude")).toBe(CLAUDE_HOST_STYLE);
    expect(findHostStyle("chatgpt")).toBe(CHATGPT_HOST_STYLE);
    expect(findHostStyle("goose")).toBe(GOOSE_HOST_STYLE);
    expect(findHostStyle("copilot")).toBe(COPILOT_HOST_STYLE);
    expect(findHostStyle("codex")).toBe(CODEX_HOST_STYLE);
    expect(findHostStyle("claude-code")).toBe(CLAUDE_CODE_HOST_STYLE);
    expect(findHostStyle("n8n")).toBe(N8N_HOST_STYLE);
    expect(findHostStyle("perplexity")).toBe(PERPLEXITY_HOST_STYLE);
  });

  it("returns undefined for unknown ids", () => {
    expect(findHostStyle("does-not-exist")).toBeUndefined();
    expect(findHostStyle(null)).toBeUndefined();
    expect(findHostStyle(undefined)).toBeUndefined();
  });

  it("falls back to mcpjam when an id is unknown or absent", () => {
    expect(DEFAULT_HOST_STYLE).toBe(MCPJAM_HOST_STYLE);
    expect(getHostStyleOrDefault(null)).toBe(MCPJAM_HOST_STYLE);
    expect(getHostStyleOrDefault("missing")).toBe(MCPJAM_HOST_STYLE);
    expect(getHostStyleOrDefault("chatgpt")).toBe(CHATGPT_HOST_STYLE);
  });

  it("recognises only registered ids via the type guard", () => {
    expect(isKnownHostStyleId("mcpjam")).toBe(true);
    expect(isKnownHostStyleId("claude")).toBe(true);
    expect(isKnownHostStyleId("chatgpt")).toBe(true);
    expect(isKnownHostStyleId("goose")).toBe(true);
    expect(isKnownHostStyleId("copilot")).toBe(true);
    expect(isKnownHostStyleId("codex")).toBe(true);
    expect(isKnownHostStyleId("claude-code")).toBe(true);
    expect(isKnownHostStyleId("n8n")).toBe(true);
    expect(isKnownHostStyleId("perplexity")).toBe(true);
    expect(isKnownHostStyleId("unknown")).toBe(false);
    expect(isKnownHostStyleId(42)).toBe(false);
    expect(isKnownHostStyleId(null)).toBe(false);
  });

  it("includes the built-ins in listHostStyles in registration order", () => {
    const ids = listHostStyles().map((host) => host.id);
    expect(ids).toContain("mcpjam");
    expect(ids).toContain("claude");
    expect(ids).toContain("chatgpt");
    expect(ids).toContain("goose");
    expect(ids).toContain("copilot");
    expect(ids).toContain("codex");
    expect(ids).toContain("claude-code");
    expect(ids).toContain("n8n");
    expect(ids).toContain("perplexity");
    // MCPJam ships first so the default-fallback host appears at the top
    // of pickers.
    expect(ids.indexOf("mcpjam")).toBeLessThan(ids.indexOf("claude"));
    expect(ids.indexOf("claude")).toBeLessThan(ids.indexOf("chatgpt"));
    expect(ids.indexOf("mistral")).toBeLessThan(ids.indexOf("goose"));
    // Copilot ships after Cursor (registration order in BUILT_IN_HOST_STYLES).
    expect(ids.indexOf("chatgpt")).toBeLessThan(ids.indexOf("copilot"));
    expect(ids.indexOf("copilot")).toBeLessThan(ids.indexOf("codex"));
    // Later headless/runtime presets ship after the core chat-style hosts.
    expect(ids.indexOf("codex")).toBeLessThan(ids.indexOf("claude-code"));
    expect(ids.indexOf("agentcore")).toBeLessThan(ids.indexOf("n8n"));
    expect(ids.indexOf("n8n")).toBeLessThan(ids.indexOf("perplexity"));
  });

  it("registers custom host styles for project-defined hosts", () => {
    const fakeStyle: HostStyleDefinition = {
      id: "test-host-registry",
      mcp: {
        protocolOverride: CLAUDE_HOST_STYLE.mcp.protocolOverride,
        platform: "web",
        fontCss: "",
        mcpAppsCapabilities: CLAUDE_HOST_STYLE.mcp.mcpAppsCapabilities,
        resolveStyleVariables: CLAUDE_HOST_STYLE.mcp.resolveStyleVariables,
      },
      chatUi: {
        label: "Test Host",
        shortLabel: "Test-style host",
        pickerDescription: "Test chrome",
        logoSrc: "/test-logo.png",
        family: "claude",
        resolveChatBackground: () => "rgba(0, 0, 0, 1)",
        loadingIndicator: CLAUDE_HOST_STYLE.chatUi.loadingIndicator,
      },
    };

    registerHostStyle(fakeStyle);

    expect(findHostStyle("test-host-registry")).toBe(fakeStyle);
    expect(isKnownHostStyleId("test-host-registry")).toBe(true);
    expect(listHostStyles()).toContain(fakeStyle);
  });

  it("derives the host style's hostCapabilities blob from the matrix preset by id", () => {
    // Identity equality no longer holds — buildHostCapabilities returns a
    // fresh object each call. Verify the derived blob's shape instead.
    expect(getHostCapabilitiesForStyle("claude")).toEqual({
      openLinks: {},
      serverTools: {},
      serverResources: {},
      logging: {},
      updateModelContext: { text: {} },
      message: { text: {} },
      downloadFile: {},
    });
    // ChatGPT drops serverResources / logging per its matrix; downloadFile
    // is on for every FULL-surface preset (ChatGPT inherits MCP_APPS_FULL_SURFACE
    // with serverResources / logging overridden off).
    expect(getHostCapabilitiesForStyle("chatgpt")).toEqual({
      openLinks: {},
      serverTools: {},
      updateModelContext: { text: {} },
      message: { text: {} },
      downloadFile: {},
    });
  });

  it("falls back to the spec-default capabilities for unknown ids (NOT claude)", () => {
    // Critical: we don't want unknown ids to silently impersonate Claude's
    // capability blob. The honest fallback is "no claims."
    expect(getHostCapabilitiesForStyle("does-not-exist")).toBe(
      SPEC_DEFAULT_HOST_CAPABILITIES,
    );
    expect(getHostCapabilitiesForStyle(null)).toBe(
      SPEC_DEFAULT_HOST_CAPABILITIES,
    );
    expect(getHostCapabilitiesForStyle(undefined)).toBe(
      SPEC_DEFAULT_HOST_CAPABILITIES,
    );
  });

  it("differentiates claude and chatgpt capability presets", () => {
    // Two profiles MUST differ in at least one observable key — otherwise
    // host-style switching is cosmetic only and provides no signal to
    // widget authors testing cross-client.
    expect(getHostCapabilitiesForStyle("claude")).not.toEqual(
      getHostCapabilitiesForStyle("chatgpt"),
    );
  });

  it("advertises no MCP Apps host capabilities for headless client styles", () => {
    expect(getHostCapabilitiesForStyle("n8n")).toEqual({});
    expect(getHostCapabilitiesForStyle("perplexity")).toEqual({});
  });

  it("keeps Goose to its probed openLinks-only advertised surface", () => {
    expect(getHostCapabilitiesForStyle("goose")).toEqual({
      openLinks: {},
    });
  });

  it("resolves Goose shell tokens to concrete colors for the active theme", () => {
    const lightVars = GOOSE_HOST_STYLE.mcp.resolveStyleVariables("light");
    const darkVars = GOOSE_HOST_STYLE.mcp.resolveStyleVariables("dark");

    expect(lightVars["--color-text-primary"]).toBe("#3f434b");
    expect(darkVars["--color-text-primary"]).toBe("#ffffff");
    expect(darkVars["--color-background-primary"]).toBe("#22252a");
    expect(
      Object.values(darkVars).some(
        (value) => typeof value === "string" && value.includes("light-dark("),
      ),
    ).toBe(false);
  });

  it("rejects duplicate host style ids", async () => {
    vi.resetModules();
    const { CLAUDE_HOST_STYLE, registerHostStyle } = await import("..");

    expect(() => registerHostStyle(CLAUDE_HOST_STYLE)).toThrow(
      /already registered/,
    );
  });
});
