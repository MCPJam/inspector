import { describe, expect, it } from "vitest";
import {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
} from "@mcpjam/sdk/browser";
import { HOST_TEMPLATES, seedFromHostTemplate } from "../client-templates";

describe("client templates", () => {
  it("seeds Mistral Le Chat from the captured MCP Apps surface", () => {
    const seed = seedFromHostTemplate("mistral");

    expect(seed.hostStyle).toBe("mistral");
    expect(seed.modelId).toBe("mistralai/mistral-large-2512");
    expect(seed.clientCapabilities).toEqual({
      extensions: {
        [MCP_UI_EXTENSION_ID]: {
          mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
        },
      },
    });
    expect(seed.hostContext.availableDisplayModes).toEqual([
      "inline",
      "fullscreen",
    ]);
    expect(seed.hostContext.displayMode).toBe("fullscreen");
    expect(seed.mcpProfile?.initialize).toEqual({
      supportedProtocolVersions: ["2025-11-25"],
      clientInfo: { name: "mcp", version: "0.1.0" },
    });
    expect(seed.mcpProfile?.apps?.uiInitialize?.hostInfo).toEqual({
      name: "Le Chat",
      version: "1.0.0",
    });
    expect(seed.mcpProfile?.apps?.compatRuntime).toEqual({
      openaiApps: false,
    });
    expect(seed.mcpProfile?.apps?.mcpAppsOverrides).toMatchObject({
      availableDisplayModes: ["inline", "fullscreen"],
      toolInputPartial: true,
      hostContextChanged: true,
      openLinks: true,
      serverTools: true,
      serverResources: true,
      logging: true,
      updateModelContext: true,
      message: true,
      sandboxPermissions: true,
      toolCancelled: false,
      resourceTeardown: false,
      toolInfo: false,
      cspFrameDomains: false,
      cspBaseUriDomains: false,
      resourcePrefersBorder: false,
      downloadFile: false,
      requestTeardown: false,
    });
  });

  it("seeds Goose Desktop from the captured MCP Apps surface", () => {
    const seed = seedFromHostTemplate("goose");

    expect(HOST_TEMPLATES.some((template) => template.id === "goose")).toBe(
      true
    );
    expect(seed.hostStyle).toBe("goose");
    expect(seed.progressiveToolDiscovery).toBe(true);
    expect(seed.clientCapabilities).toEqual({
      extensions: {
        [MCP_UI_EXTENSION_ID]: {
          mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
        },
      },
      roots: {},
      sampling: {},
      elicitation: {},
    });
    expect(seed.hostCapabilitiesOverride).toEqual({ openLinks: {} });
    expect(seed.hostContext.availableDisplayModes).toEqual([
      "inline",
      "fullscreen",
      "pip",
    ]);
    expect(seed.hostContext.displayMode).toBe("inline");
    expect(seed.hostContext.platform).toBe("desktop");
    expect(seed.mcpProfile?.initialize).toEqual({
      supportedProtocolVersions: ["2025-03-26"],
      clientInfo: { name: "goose-desktop", version: "1.38.0" },
    });
    expect(seed.mcpProfile?.apps?.uiInitialize?.hostInfo).toEqual({
      name: "MCP-UI Host",
      version: "1.0.0",
    });
    expect(seed.mcpProfile?.apps?.compatRuntime).toEqual({
      openaiApps: false,
    });
    expect(seed.mcpProfile?.apps?.mcpAppsOverrides).toMatchObject({
      availableDisplayModes: ["inline", "fullscreen", "pip"],
      toolInfo: true,
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

  it("seeds Slack from the captured MCP Apps surface", () => {
    const seed = seedFromHostTemplate("slack");

    expect(HOST_TEMPLATES.some((template) => template.id === "slack")).toBe(
      true
    );
    expect(seed.hostStyle).toBe("slack");
    expect(seed.clientCapabilities).toEqual({
      extensions: {
        [MCP_UI_EXTENSION_ID]: {
          mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
        },
      },
    });
    expect(seed.hostCapabilitiesOverride).toEqual({
      openLinks: {},
      serverTools: {},
      serverResources: {},
      logging: {},
    });
    expect(seed.hostContext.displayMode).toBe("inline");
    expect(seed.hostContext.availableDisplayModes).toEqual([
      "inline",
      "fullscreen",
    ]);
    expect(seed.hostContext.containerDimensions).toEqual({ maxWidth: 598 });
    expect(seed.hostContext.theme).toBe("dark");
    expect(
      seed.hostContext.styles?.variables["--color-background-primary"]
    ).toBe("#1a1d21");
    expect(seed.mcpProfile?.initialize).toEqual({
      supportedProtocolVersions: ["2025-06-18"],
      clientInfo: { name: "Slack MCP Client", version: "1.0.0" },
    });
    expect(seed.mcpProfile?.apps?.uiInitialize?.hostInfo).toEqual({
      name: "Slack",
      version: "1.0.0",
    });
    expect(seed.mcpProfile?.apps?.compatRuntime).toEqual({
      openaiApps: false,
    });
    expect(seed.mcpProfile?.apps?.mcpAppsOverrides).toMatchObject({
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

  it("seeds n8n as a tools-only MCP client", () => {
    const seed = seedFromHostTemplate("n8n");

    expect(HOST_TEMPLATES.some((template) => template.id === "n8n")).toBe(true);
    expect(seed.hostStyle).toBe("n8n");
    expect(seed.clientCapabilities).toEqual({});
    expect(seed.hostCapabilitiesOverride).toEqual({});
    expect(seed.hostContext).toEqual({});
    expect(seed.mcpProfile).toEqual({
      profileVersion: 1,
      initialize: {
        supportedProtocolVersions: ["2025-11-25"],
        clientInfo: {
          name: "@n8n/n8n-nodes-langchain.mcpClientTool",
          version: "1.3",
        },
      },
    });
  });

  it("seeds Perplexity as a tools-only MCP client", () => {
    const seed = seedFromHostTemplate("perplexity");

    expect(
      HOST_TEMPLATES.some((template) => template.id === "perplexity")
    ).toBe(true);
    expect(seed.hostStyle).toBe("perplexity");
    expect(seed.clientCapabilities).toEqual({});
    expect(seed.hostCapabilitiesOverride).toEqual({});
    expect(seed.hostContext).toEqual({});
    expect(seed.mcpProfile).toEqual({
      profileVersion: 1,
      initialize: {
        supportedProtocolVersions: ["2025-06-18"],
        clientInfo: { name: "mcp", version: "0.1.0" },
      },
    });
  });

  it("seeds Cline as a tools-only MCP client", () => {
    const seed = seedFromHostTemplate("cline");

    expect(HOST_TEMPLATES.some((template) => template.id === "cline")).toBe(
      true
    );
    expect(seed.hostStyle).toBe("cline");
    expect(seed.clientCapabilities).toEqual({});
    expect(seed.hostCapabilitiesOverride).toEqual({});
    expect(seed.hostContext).toEqual({});
    // Captured verbatim from the Cline 3.89.2 probe (protocol 2025-11-25,
    // real clientInfo, empty capabilities, no snapshot).
    expect(seed.mcpProfile).toEqual({
      profileVersion: 1,
      initialize: {
        supportedProtocolVersions: ["2025-11-25"],
        clientInfo: { name: "Cline", version: "3.89.2" },
      },
    });
  });

  it("seeds Notion as a tools-only MCP client", () => {
    const seed = seedFromHostTemplate("notion");

    expect(HOST_TEMPLATES.some((template) => template.id === "notion")).toBe(
      true
    );
    expect(seed.hostStyle).toBe("notion");
    expect(seed.clientCapabilities).toEqual({});
    expect(seed.hostCapabilitiesOverride).toEqual({});
    expect(seed.hostContext).toEqual({});
    expect(seed.mcpProfile).toEqual({
      profileVersion: 1,
      initialize: {
        supportedProtocolVersions: ["2025-11-25"],
        clientInfo: { name: "notion", version: "1.0.0" },
      },
    });
  });
});
