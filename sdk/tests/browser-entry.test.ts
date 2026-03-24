import * as browser from "../src/browser";

describe("browser entrypoint", () => {
  it("exports browser-safe capability helpers without MCPClientManager", () => {
    expect(browser.MCP_UI_EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
    expect(browser.MCP_UI_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(browser.getDefaultClientCapabilities()).toEqual({
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    });
    expect(
      (browser as Record<string, unknown>).MCPClientManager,
    ).toBeUndefined();
  });
});
