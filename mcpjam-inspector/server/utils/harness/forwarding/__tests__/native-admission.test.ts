import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk";
import { DEFAULT_MODEL_VISIBLE_MCP_TOOL_RESULTS } from "@mcpjam/sdk";
import { harnessPinnedVersion } from "@/shared/harness-model-support";
import { nativeForwardingGaps } from "../native-admission";
import { NATIVE_ELICITATION_RUNTIME } from "../native-elicitation-profile";

/** The CLI build the native profile was read from, as the bridge lock pins it. */
const PROFILE_READ_FROM =
  "sha512-1FQDIO4tXPFyw9wR1icEedIhEmLzOiQBAGR0NgETrXK8M2YbHEDXoE5Gg/LIuIee7giUuX5F2RzLw2N2i++ofQ==";

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
  it("requires a new reading of the CLI handshake whenever the installed runtime moves", () => {
    expect(harnessPinnedVersion("claude-code")).toBe(NATIVE_ELICITATION_RUNTIME);
    const require = createRequire(import.meta.url);
    const lock = readFileSync(
      join(
        dirname(require.resolve("@ai-sdk/harness-claude-code/package.json")),
        "dist/bridge/pnpm-lock.yaml",
      ),
      "utf8",
    );
    expect(lock).toContain(
      `'@anthropic-ai/claude-code-linux-x64@${NATIVE_ELICITATION_RUNTIME}':\n    resolution: {integrity: ${PROFILE_READ_FROM}}`,
    );
  });
  const nativeConfig = () => ({
    url: "https://mcp.example/mcp",
    clientCapabilities: {
      elicitation: { form: {}, url: {} },
      roots: { listChanged: true },
    },
  });
  it("admits the CLI's own elicitation profile only with its owned runtime handler", () => {
    const form = candidate(nativeConfig());
    expect(nativeForwardingGaps(form)).toContain("client-capabilities");
    expect(nativeForwardingGaps({ ...form, elicitationRuntimeVersion: "2.1.290" })).toEqual([]);
    expect(nativeForwardingGaps({ ...form, elicitationRuntimeVersion: "2.1.310" })).toContain("client-capabilities");
  });
  it("honors exact-set precedence over duplicated or conflicting inactive overlays", () => {
    const config = nativeConfig();
    for (const overlay of [config.clientCapabilities, { extensions: { "future.test/ignored": {} } }]) {
      expect(nativeForwardingGaps({ ...candidate({ ...config, capabilities: overlay, eraCapabilities: { modern: overlay } }), elicitationRuntimeVersion: "2.1.290" })).toEqual([]);
    }
    const effective = candidate(config).manager.getInitializationInfo();
    expect(nativeForwardingGaps({ ...candidate({ url: config.url, capabilities: config.clientCapabilities }, effective), elicitationRuntimeVersion: "2.1.290" })).toContain("capability-overrides");
  });
  it.each([
    { elicitation: { form: {} } },
    { elicitation: { url: {} } },
    { extensions: { "io.modelcontextprotocol/tasks": {} } },
    { futureCapability: {} },
  ])("retains a profile that differs from the CLI's own: %j", (addition) => {
    const config = nativeConfig();
    Object.assign(config.clientCapabilities, addition);
    expect(nativeForwardingGaps({ ...candidate(config), elicitationRuntimeVersion: "2.1.290" })).toContain("client-capabilities");
  });
  it("does not qualify modern input_required with a legacy callback", () => {
    const config = nativeConfig();
    const form = candidate(config);
    expect(nativeForwardingGaps({
      ...form,
      elicitationRuntimeVersion: "2.1.290",
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
