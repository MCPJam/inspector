import { describe, expect, it } from "vitest";
import { seedFromHostTemplate } from "../client-templates";
import {
  resolveEffectiveCompatRuntime,
  resolveEffectiveMcpAppsCapabilities,
} from "../client-config-v2";

describe("host client templates", () => {
  it("seeds Claude Desktop from the captured Electron MCP Apps profile", () => {
    const cfg = seedFromHostTemplate("claude-desktop");

    expect(cfg.hostStyle).toBe("claude-desktop");
    expect(cfg.modelId).toBe("anthropic/claude-haiku-4.5");
    expect(cfg.clientCapabilities).toEqual({
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    });
    expect(cfg.hostCapabilitiesOverride).toEqual({
      openLinks: {},
      downloadFile: {},
      serverTools: { listChanged: true },
      serverResources: { listChanged: true },
      logging: {},
      updateModelContext: { text: {}, image: {} },
      message: { text: {} },
    });
    expect(cfg.hostContext).toMatchObject({
      theme: "dark",
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { width: 698.109375, maxHeight: 5000 },
      locale: "en-US",
      timeZone: "America/Los_Angeles",
      platform: "desktop",
      deviceCapabilities: { touch: false, hover: true },
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(cfg.hostContext.userAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.12603.1 Chrome/148.0.7778.254 Electron/42.4.0 Safari/537.36",
    );
    expect(
      (cfg.hostContext.styles as { variables?: Record<string, string> })
        .variables?.["--font-sans"],
    ).toBe("Anthropic Sans, sans-serif");
    expect(cfg.mcpProfile).toEqual({
      profileVersion: 1,
      initialize: {
        clientInfo: { name: "claude-ai", version: "0.1.0" },
      },
      apps: {
        uiInitialize: {
          hostInfo: { name: "Claude", version: "1.0.0" },
        },
        compatRuntime: { openaiApps: false },
        sandbox: {
          csp: {
            mode: "declared",
            restrictTo: {
              connectDomains: [
                "https://api.openai.com",
                "https://api.anthropic.com",
                "https://cdn.jsdelivr.net",
              ],
              resourceDomains: [
                "https://cdn.jsdelivr.net",
                "https://assets.claude.ai",
              ],
            },
          },
          permissions: {
            mode: "custom",
            allow: { clipboardWrite: true },
          },
          sandboxAttrs: ["allow-forms"],
        },
      },
    });

    expect(
      resolveEffectiveCompatRuntime({
        hostStyle: cfg.hostStyle,
        profile: cfg.mcpProfile,
      }),
    ).toEqual({ injected: false });
    expect(
      resolveEffectiveMcpAppsCapabilities({
        hostStyle: cfg.hostStyle,
        profile: cfg.mcpProfile,
      }).availableDisplayModes,
    ).toEqual(["inline"]);
  });
});
