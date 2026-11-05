import { describe, expect, it } from "vitest";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  harnessConnectionProfile,
  harnessConnectionFingerprint,
  isEnhancedMcpProfile,
  isEnhancedModelPolicy,
} from "../harness-connection-profile";
function manager(
  caps: object,
  protocolVersion = "2026-07-28",
  timeout = 60_000,
) {
  return {
    getInitializationInfo: () => ({
      protocolVersion,
      clientCapabilities: caps,
    }),
    getServerConfig: () => ({
      url: "https://example.test/mcp",
      timeout,
      clientCapabilities: caps,
      clientInfo: { name: "fixture", version: "1" },
      requestInit: { headers: { authorization: "secret" } },
    }),
  } as unknown as MCPClientManager;
}
const ui = {
  extensions: {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  },
};
describe("harness connection profiles", () => {
  it("qualifies modern input only when an owned handler is installed", () => {
    const m = manager({ ...ui, elicitation: { form: {}, url: {} } });
    expect(isEnhancedMcpProfile(m, "server")).toBe(false);
    expect(isEnhancedMcpProfile(m, "server", true)).toBe(true);
    expect(
      isEnhancedMcpProfile(
        manager({ elicitation: { form: {} } }),
        "server",
        true,
      ),
    ).toBe(true);
    expect(
      isEnhancedMcpProfile(
        manager({ ...ui, elicitation: { future: {} } }),
        "server",
        true,
      ),
    ).toBe(false);
  });

  it("preserves opaque capabilities and pins without copying credentials", () => {
    const m = manager({ extensions: { future: { enabled: true } } });
    const profile = harnessConnectionProfile(m, "server");
    expect(profile.clientCapabilities).toEqual({
      extensions: { future: { enabled: true } },
    });
    expect(profile.timeout).toBe(60_000);
    expect(profile.clientInfo?.name).toBe("fixture");
    expect(JSON.stringify(profile)).not.toContain("secret");
    expect(harnessConnectionFingerprint(m, ["server"])).not.toBe(
      harnessConnectionFingerprint(manager(ui), ["server"]),
    );
    expect(harnessConnectionFingerprint(m, ["server"])).not.toBe(
      harnessConnectionFingerprint(
        manager(
          { extensions: { future: { enabled: true } } },
          "2026-07-28",
          10_000,
        ),
        ["server"],
      ),
    );
  });
  it("qualifies only the known modern App declaration", () => {
    expect(isEnhancedMcpProfile(manager(ui), "server")).toBe(true);
    expect(isEnhancedMcpProfile(manager(ui, "2025-11-25"), "server")).toBe(
      false,
    );
    expect(
      isEnhancedMcpProfile(manager({ ...ui, sampling: {} }), "server"),
    ).toBe(false);
    expect(
      isEnhancedMcpProfile(
        manager({ extensions: { ...ui.extensions, future: {} } }),
        "server",
      ),
    ).toBe(false);
    expect(
      isEnhancedMcpProfile(
        manager({
          extensions: {
            "io.modelcontextprotocol/ui": { mimeTypes: ["future/type"] },
          },
        }),
        "server",
      ),
    ).toBe(false);
    expect(
      isEnhancedMcpProfile(
        manager({
          extensions: {
            "io.modelcontextprotocol/ui": {
              ...ui.extensions["io.modelcontextprotocol/ui"],
              future: true,
            },
          },
        }),
        "server",
      ),
    ).toBe(false);
  });
});

it("keeps unsupported model policies on the existing path", () => {
  expect(isEnhancedModelPolicy()).toBe(true);
  expect(isEnhancedModelPolicy({})).toBe(true);
  expect(isEnhancedModelPolicy({ directContent: { text: false } })).toBe(false);
  expect(isEnhancedModelPolicy({ directContent: { audio: true } })).toBe(false);
  expect(isEnhancedModelPolicy({ linkedResources: { text: true } })).toBe(
    false,
  );
});
