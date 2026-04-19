import * as browser from "../src/browser";

describe("browser entrypoint", () => {
  it("deep-merges extensions by extension id when merging client capabilities", () => {
    const ui = browser.MCP_UI_EXTENSION_ID;
    const merged = browser.mergeClientCapabilities(
      {
        extensions: {
          [ui]: { mimeTypes: ["text/html;profile=mcp-app"] },
          "custom/ext": { foo: 1 },
        },
      } as any,
      {
        extensions: {
          [ui]: { extra: true },
        },
      } as any
    );

    const extensions = (merged as Record<string, unknown>).extensions as Record<
      string,
      unknown
    >;
    expect(extensions[ui]).toEqual({
      mimeTypes: ["text/html;profile=mcp-app"],
      extra: true,
    });
    expect(extensions["custom/ext"]).toEqual({ foo: 1 });
  });

  it("treats explicit empty extensions object as a full clear", () => {
    const merged = browser.mergeClientCapabilities(
      browser.getDefaultClientCapabilities(),
      { extensions: {} } as any
    );
    expect((merged as Record<string, unknown>).extensions).toEqual({});
  });

  it("exports browser-safe capability helpers without MCPClientManager", () => {
    expect(browser.MCP_UI_EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
    expect(browser.MCP_UI_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(typeof browser.redactSensitiveValue).toBe("function");
    expect(browser.getDefaultClientCapabilities()).toEqual({
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    });
    expect(
      (browser as Record<string, unknown>).MCPClientManager
    ).toBeUndefined();
    expect(
      (browser as Record<string, unknown>).runHttpServerDoctor
    ).toBeUndefined();
  });

  it("exports browser-safe OAuth debug helpers without OAuthConformanceTest", () => {
    expect(browser.EMPTY_OAUTH_FLOW_STATE.currentStep).toBe("idle");
    expect(typeof browser.createOAuthStateMachine).toBe("function");
    expect(typeof browser.buildOAuthSequenceActions).toBe("function");
    expect(browser.PROTOCOL_VERSION_INFO["2025-11-25"]).toBeDefined();
    expect(browser.getDefaultRegistrationStrategy("2025-11-25")).toBe("cimd");
    expect(browser.getSupportedRegistrationStrategies("2025-06-18")).toEqual([
      "dcr",
      "preregistered",
    ]);
    expect(typeof browser.getStepInfo).toBe("function");
    expect(typeof browser.getStepIndex).toBe("function");
    expect(
      (browser as Record<string, unknown>).OAuthConformanceTest
    ).toBeUndefined();
  });
});
