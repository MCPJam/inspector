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
      HOST_TEMPLATES.some((template) => template.id === "perplexity"),
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
});
