import { describe, expect, it } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk";
import { nativeForwardingGaps } from "../native-admission";

function candidate(
  config: MCPServerConfig = {
    url: "https://mcp.example/mcp",
    clientCapabilities: {},
  },
  initialized = {
    transport: "streamable-http",
    protocolVersion: "2025-11-25",
    serverCapabilities: {},
    serverVersion: { name: "fixture", version: "1" },
    instructions: "",
    clientCapabilities: config.clientCapabilities,
  },
) {
  return {
    manager: {
      getServerConfig: () => config,
      getInitializationInfo: () => initialized,
    },
    serverIds: ["server"],
    respectToolVisibility: false,
  };
}

describe("native profile admission", () => {
  it("admits only the qualified plain HTTP profile", () => {
    expect(nativeForwardingGaps(candidate())).toEqual([]);
  });
  it.each([
    ["Apps", { extensions: { "io.modelcontextprotocol/ui": {} } }],
    ["elicitation", { elicitation: { form: {} } }],
    ["future extension", { extensions: { "future.test/capability": {} } }],
    ["future capability", { futureCapability: {} }],
  ])(
    "retains %s instead of silently dropping its promise",
    (_label, capabilities) => {
      const config = { url: "https://mcp.example/mcp", clientCapabilities: {} };
      Object.assign(config.clientCapabilities, capabilities);
      expect(nativeForwardingGaps(candidate(config))).toContain(
        "client-capabilities",
      );
    },
  );
  it("does not treat unresolved manager defaults as an empty declaration", () => {
    expect(
      nativeForwardingGaps(candidate({ url: "https://mcp.example/mcp" })),
    ).toContain("client-capabilities");
  });
  it.each([
    ["client-identity", { clientInfo: { name: "Claude web", version: "1" } }],
    ["protocol-pins", { mcpProtocolVersion: "2026-07-28" }],
    ["protocol-pins", { supportedProtocolVersions: ["2025-06-18"] }],
    ["client-behavior", { mirrorToolParamHeaders: false }],
    ["client-behavior", { firstPageOnly: true }],
    ["client-behavior", { supportsMrtr: false }],
    ["client-behavior", { suppressListenChannel: true }],
    ["client-behavior", { dropToolListChanged: true }],
    ["client-behavior", { toolCallCancellation: { legacy: false } }],
    ["request-timeout", { timeout: 1000 }],
    ["connection-options", { sessionId: "original-session" }],
    ["connection-options", { eventSourceInit: {} }],
    ["connection-options", { reconnectionOptions: { maxRetries: 1 } }],
    ["request-options", { requestInit: { headers: { "x-custom": "test" } } }],
    ["transport", { preferSSE: true }],
  ] as const)("preserves %s settings", (gap, override) => {
    expect(
      nativeForwardingGaps(
        candidate(
          Object.assign({
            url: "https://mcp.example/mcp",
            clientCapabilities: {},
            ...override,
          }),
        ),
      ),
    ).toContain(gap);
  });
  it("keeps host-only promises and client-fulfilled tools", () => {
    expect(
      nativeForwardingGaps({
        ...candidate(),
        respectToolVisibility: true,
        hasClientTools: true,
        hasTasks: true,
        modelVisibleMcpToolResults: { directContent: { image: false } },
      }),
    ).toEqual([
      "client-tools",
      "tasks",
      "tool-visibility",
      "model-result-policy",
    ]);
  });
  it("checks every selected server before choosing a route", () => {
    const first = candidate();
    expect(
      nativeForwardingGaps({
        ...first,
        serverIds: ["plain", "apps"],
        manager: {
          ...first.manager,
          getServerConfig: (id) =>
            id === "plain"
              ? first.manager.getServerConfig()
              : { url: "https://apps.example/mcp" },
          getInitializationInfo: (id) =>
            id === "plain" ? first.manager.getInitializationInfo() : undefined,
        },
      }),
    ).toContain("client-capabilities");
  });
  it("does not qualify unresolved or modern negotiation or an actual SSE fallback", () => {
    const base = candidate();
    for (const initialized of [
      undefined,
      {
        ...base.manager.getInitializationInfo(),
        protocolVersion: "2026-07-28",
      },
      { ...base.manager.getInitializationInfo(), transport: "sse" },
    ]) {
      expect(
        nativeForwardingGaps({
          ...base,
          manager: {
            ...base.manager,
            getInitializationInfo: () => initialized,
          },
        }),
      ).toContain("unqualified-protocol");
    }
  });
});
