import { describe, expect, it } from "vitest";
import { HOST_TEMPLATES, seedFromHostTemplate } from "../client-templates";

describe("client templates", () => {
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
});
