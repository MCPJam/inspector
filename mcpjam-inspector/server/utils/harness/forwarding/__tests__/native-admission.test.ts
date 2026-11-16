import { describe, expect, it } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk";
import { DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS } from "@mcpjam/sdk";
import { harnessPinnedVersion } from "@/shared/harness-model-support";
import { nativeForwardingGaps } from "../native-admission";

function candidate(
  config: MCPServerConfig = {
    url: "https://mcp.example/mcp",
    clientCapabilities: {},
  },
  landedOn = "2025-11-25",
  initialized = {
    transport: "streamable-http",
    protocolVersion: landedOn,
    serverCapabilities: {},
    serverVersion: { name: "fixture", version: "1" },
    instructions: "",
    clientCapabilities: config.clientCapabilities,
  },
) {
  return {
    hostCapabilities: { capabilities: {}, gaps: [] },
    manager: {
      getServerConfig: () => config,
      getInitializationInfo: () => initialized,
    },
    serverIds: ["server"],
    respectToolVisibility: false,
  };
}

describe("native profile admission", () => {
  it("does not apply dormant widget promises to a plain native connection", () => {
    expect(nativeForwardingGaps({ ...candidate(), hostCapabilities: {
      capabilities: { futureCapability: {} }, gaps: ["host-capability:futureCapability"],
    } })).toEqual([]);
  });
  it("requires new elicitation qualification when the installed runtime pin changes", () => {
    expect(harnessPinnedVersion("claude-code")).toBe("2.1.290");
  });
  const formConfig = () => ({
    url: "https://mcp.example/mcp",
    clientCapabilities: { elicitation: { form: {} }, roots: { listChanged: true } },
  });
  it("admits the measured native form profile only with its owned runtime handler", () => {
    const form = candidate(formConfig());
    expect(nativeForwardingGaps(form)).toContain("client-capabilities");
    expect(nativeForwardingGaps({ ...form, elicitationRuntimeVersion: "2.1.245" })).toEqual([]);
    expect(nativeForwardingGaps({ ...form, elicitationRuntimeVersion: "2.1.290" })).toEqual([]);
    expect(nativeForwardingGaps({ ...form, elicitationRuntimeVersion: "2.1.310" })).toContain("client-capabilities");
  });
  it("honors exact-set precedence over duplicated or conflicting inactive overlays", () => {
    const config = formConfig();
    for (const overlay of [config.clientCapabilities, { extensions: { "future.test/ignored": {} } }]) {
      expect(nativeForwardingGaps({ ...candidate({ ...config, capabilities: overlay, eraCapabilities: { modern: overlay } }), elicitationRuntimeVersion: "2.1.245" })).toEqual([]);
    }
    const effective = candidate(config).manager.getInitializationInfo();
    expect(nativeForwardingGaps({ ...candidate({ url: config.url, capabilities: config.clientCapabilities }, "2025-11-25", effective), elicitationRuntimeVersion: "2.1.245" })).toContain("capability-overrides");
  });
  it.each([
    { elicitation: { form: {}, url: {} } },
    { extensions: { "io.modelcontextprotocol/tasks": {} } },
    { futureCapability: {} },
  ])("retains unqualified additions to the form profile: %j", (addition) => {
    const config = formConfig();
    Object.assign(config.clientCapabilities, addition);
    expect(nativeForwardingGaps({ ...candidate(config), elicitationRuntimeVersion: "2.1.245" })).toContain("client-capabilities");
  });
  it("does not qualify modern input_required with a legacy callback", () => {
    const config = formConfig();
    const form = candidate(config);
    expect(nativeForwardingGaps({
      ...form,
      elicitationRuntimeVersion: "2.1.245",
      manager: { ...form.manager, getInitializationInfo: () => ({ ...form.manager.getInitializationInfo(), protocolVersion: "2026-07-28" }) },
    })).toContain("client-capabilities");
  });
  it("admits only the qualified plain HTTP profile", () => {
    expect(nativeForwardingGaps(candidate())).toEqual([]);
  });
  it("admits the same default policy before and after host normalization", () => {
    expect(nativeForwardingGaps({ ...candidate(), modelVisibleMcpToolResults: DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS })).toEqual([]);
    expect(nativeForwardingGaps({ ...candidate(), modelVisibleMcpToolResults: {} })).toEqual([]);
    expect(nativeForwardingGaps({ ...candidate(), modelVisibleMcpToolResults: { directContent: { image: false } } })).toContain("model-result-policy");
    const unknownPolicy = { directContent: { text: true, unknown: true } };
    expect(nativeForwardingGaps({ ...candidate(), modelVisibleMcpToolResults: unknownPolicy })).toContain("model-result-policy");
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
  describe("pins equal to the runtime's measured handshake", () => {
    const nativeClient = {
      clientInfo: { name: "fixture-cli", title: "Fixture", version: "1.2.3" },
      capabilities: { sampling: {}, roots: { listChanged: true } },
      supportedProtocolVersions: ["2025-06-18"],
      mcpProtocolVersion: "2025-06-18" as const,
    };
    // As `toHttpConfig` builds a pinned connection: the exact declaration,
    // repeated as the overlay the SDK then ignores.
    const pinned = (overrides: Record<string, unknown> = {}) =>
      candidate(
        Object.assign(
          {
            url: "https://mcp.example/mcp",
            clientInfo: { version: "1.2.3", name: "fixture-cli", title: "Fixture" },
            clientCapabilities: { roots: { listChanged: true }, sampling: {} },
            capabilities: { roots: { listChanged: true }, sampling: {} },
            supportedProtocolVersions: ["2025-06-18"],
            mcpProtocolVersion: "2025-06-18",
          },
          overrides,
        ),
        // A connection pinned to the runtime's versions lands on one of them.
        "2025-06-18",
      );

    it("add no gap, in any key order", () => {
      expect(nativeForwardingGaps(pinned())).toEqual(
        expect.arrayContaining(["client-capabilities", "client-identity", "protocol-pins"]),
      );
      expect(nativeForwardingGaps({ ...pinned(), nativeClient })).toEqual([]);
    });

    it.each([
      ["client-identity", { clientInfo: { name: "fixture-cli", version: "1.2.4" } }],
      ["client-identity", { version: "1.2.3" }],
      ["client-capabilities", { clientCapabilities: { sampling: {} } }],
      ["protocol-pins", { supportedProtocolVersions: ["2025-06-18", "2025-11-25"] }],
      ["protocol-pins", { mcpProtocolVersion: "2025-11-25" }],
      ["protocol-pins", { versionNegotiation: "legacy-first" }],
    ])("still count %s where a pin differs", (gap, override) => {
      expect(nativeForwardingGaps({ ...pinned(override), nativeClient })).toContain(gap);
    });

    it("leaves a setting the profile does not pin to the runtime", () => {
      expect(
        nativeForwardingGaps({
          ...candidate(
            { url: "https://mcp.example/mcp", clientCapabilities: {} },
            "2025-06-18",
          ),
          nativeClient,
        }),
      ).toEqual([]);
    });

    it("keeps the configured route where the connection landed on a version the runtime's own client does not offer", () => {
      // On pass-through the runtime's client speaks to the server itself.
      expect(
        nativeForwardingGaps({
          ...candidate({ url: "https://mcp.example/mcp", clientCapabilities: {} }),
          nativeClient,
        }),
      ).toEqual(["unqualified-protocol"]);
    });

    it("keeps the configured route for elicitation the turn would not hand to its handler", () => {
      const elicitation = {
        ...nativeClient,
        capabilities: { elicitation: { form: {} } },
        supportedProtocolVersions: ["2025-06-18", "2025-11-25"],
      };
      const config = {
        url: "https://mcp.example/mcp",
        clientCapabilities: { elicitation: { form: {} } },
      };
      // With or without a live handler, on either landing: the turn routes
      // elicitation only for the measured Claude Code profile, so the
      // runtime's client would answer the server itself.
      for (const landedOn of ["2025-06-18", "2025-11-25"])
        for (const elicitationRuntimeVersion of [undefined, "1.2.3"])
          expect(
            nativeForwardingGaps({
              ...candidate(config, landedOn),
              nativeClient: elicitation,
              elicitationRuntimeVersion,
            }),
          ).toContain("client-capabilities");
    });

    it("admits elicitation the runtime's client declares where the turn routes it to its handler", () => {
      const claudeCode = {
        clientInfo: { name: "claude-code", version: "2.1.290" },
        capabilities: { elicitation: { form: {} }, roots: { listChanged: true } },
      };
      const config = {
        url: "https://mcp.example/mcp",
        clientCapabilities: claudeCode.capabilities,
        clientInfo: claudeCode.clientInfo,
      };
      expect(
        nativeForwardingGaps({
          ...candidate(config),
          nativeClient: claudeCode,
          elicitationRuntimeVersion: "2.1.290",
        }),
      ).toEqual([]);
    });
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
