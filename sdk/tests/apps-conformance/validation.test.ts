import {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
} from "../../src/mcp-client-manager/index.js";
import { normalizeMCPAppsConformanceConfig } from "../../src/apps-conformance/validation.js";

describe("normalizeMCPAppsConformanceConfig", () => {
  it("forces the MCP Apps UI capability even when clientCapabilities clears extensions", () => {
    const normalized = normalizeMCPAppsConformanceConfig({
      command: "echo",
      clientCapabilities: {
        extensions: {},
        experimental: {
          customClient: {},
        },
      } as any,
    });

    expect(normalized.serverConfig.clientCapabilities).toMatchObject({
      experimental: {
        customClient: {},
      },
      elicitation: {},
    });
    expect(
      (
        normalized.serverConfig.clientCapabilities as Record<string, unknown>
      ).extensions,
    ).toEqual({
      [MCP_UI_EXTENSION_ID]: {
        mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
      },
    });
  });
});
