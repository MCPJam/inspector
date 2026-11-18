import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";

// The assembled `.mcp.json` is the only place that can prove a policied run got
// a sealed credential, so the refusals live there and are exercised there. The
// harness agent itself is irrelevant to this file: only the config assembly is.
vi.mock("../harness-proxy-token-client.js", () => ({
  fetchHarnessProxyTokens: vi.fn(async () => ({
    ok: true,
    tokens: { "srv-a": "convex-token-a" },
  })),
}));

vi.mock("../harness-proxy-strategy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-proxy-strategy.js")>()),
  resolveHarnessProxyUrl: vi.fn(
    async (args: { serverId: string }) =>
      `https://mcpjam.example/api/web/harness-mcp/${args.serverId}`
  ),
}));

const { buildHarnessProxyMcpJsonFromManager } = await import(
  "../run-harness-turn.js"
);
const { isSealedHarnessProxyToken, unsealHarnessProxyToken } =
  await import("../harness-proxy-policy-seal.js");

const policy: ToolPolicySnapshot = {
  mode: "default",
  denied: {
    delete_repo: { reason: "denyList", classification: "destructive" },
  },
  known: ["delete_repo", "read_file"],
  unknownTool: "deny",
};

const manager = {
  getServerConfig: vi.fn(() => ({ url: "https://upstream.example/mcp" })),
} as unknown as Parameters<
  typeof buildHarnessProxyMcpJsonFromManager
>[0]["manager"];

const build = (
  strategy: Parameters<
    typeof buildHarnessProxyMcpJsonFromManager
  >[0]["strategy"],
  toolPolicy?: Record<string, ToolPolicySnapshot>
) =>
  buildHarnessProxyMcpJsonFromManager({
    manager,
    selectedServerIds: ["srv-a"],
    authHeader: "Bearer test",
    projectId: "proj-1",
    strategy,
    scopeStepUpCorrelationId: "corr-1",
    ...(toolPolicy ? { toolPolicy } : {}),
  });

const hosted = {
  plane: "web-authorized",
  mode: "direct",
  publicBaseUrl: "https://mcpjam.example",
} as Parameters<typeof buildHarnessProxyMcpJsonFromManager>[0]["strategy"];

const local = { plane: "local-mcp" } as Parameters<
  typeof buildHarnessProxyMcpJsonFromManager
>[0]["strategy"];

beforeEach(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET =
    "a-sufficiently-long-test-secret";
});

describe("policied harness .mcp.json assembly", () => {
  it("does not mint or deliver a refused plugin server even with a cached config", async () => {
    const { fetchHarnessProxyTokens } = await import("../harness-proxy-token-client.js");
    vi.mocked(fetchHarnessProxyTokens).mockClear();
    const { mcpJson } = await buildHarnessProxyMcpJsonFromManager({
      manager, selectedServerIds: ["srv-a", "refused"],
      unavailableServerIds: ["refused"],
      pluginOrigins: { refused: { pluginId: "p", pluginVersionId: "v", name: "Refused plugin", bundleHash: null } },
      authHeader: "Bearer test", projectId: "proj-1", strategy: hosted,
      scopeStepUpCorrelationId: "corr-1",
    });
    expect(Object.keys(mcpJson.mcpServers)).toEqual(["srv-a"]);
    expect(fetchHarnessProxyTokens).toHaveBeenCalledWith(expect.objectContaining({ serverIds: ["srv-a"] }));
  });

  it("carries a sealed token, and no bare one, for a policied server", async () => {
    const { mcpJson } = await build(hosted, { "srv-a": policy });
    const header = Object.values(mcpJson.mcpServers)[0]?.headers?.[
      "X-MCPJam-Proxy-Token"
    ];
    expect(isSealedHarnessProxyToken(header)).toBe(true);
    expect(header).not.toContain("convex-token-a");
  });

  it("seals the connection profile even when no tool policy is in force", async () => {
    const { mcpJson } = await build(hosted);
    const value = Object.values(mcpJson.mcpServers)[0]?.headers?.[
      "X-MCPJam-Proxy-Token"
    ];
    expect(unsealHarnessProxyToken(value, "srv-a")).toMatchObject({
      token: "convex-token-a",
      profile: {},
    });
  });

  it("refuses a policied run on the local-mcp plane rather than run it unenforced", async () => {
    await expect(build(local, { "srv-a": policy })).rejects.toThrow(
      /TOOL_POLICY_UNSUPPORTED/
    );
  });

  it("refuses a policied run when this deployment cannot seal", async () => {
    delete process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
    await expect(build(hosted, { "srv-a": policy })).rejects.toThrow();
  });
});

describe("the v1 API's read_only exclusions on a proxied harness", () => {
  it("are sealed into the credential, and the proxy refuses a mutating call with them", async () => {
    const { toolModeHarnessPolicy } = await import(
      "../../../routes/v1/chat-session-host-target.js"
    );
    const { evaluateHarnessProxyToolPolicy } = await import(
      "../harness-proxy-policy-enforcement.js"
    );
    const readOnly = toolModeHarnessPolicy(
      ["srv-a"],
      [
        {
          serverId: "srv-a",
          tools: [
            { name: "read_file", annotations: { readOnlyHint: true } },
            { name: "delete_repo" },
          ],
        },
      ],
      ["delete_repo"],
    );
    const { mcpJson } = await build(hosted, readOnly);
    const sealed = unsealHarnessProxyToken(
      Object.values(mcpJson.mcpServers)[0]?.headers?.["X-MCPJam-Proxy-Token"],
      "srv-a",
    );
    expect(sealed?.policy).toEqual(readOnly["srv-a"]);
    const call = (name: string) =>
      evaluateHarnessProxyToolPolicy({
        body: { method: "tools/call", params: { name, arguments: {} }, id: 1 },
        policyServerId: "srv-a",
        policy: sealed!.policy,
        hasServer: (id) => id === "srv-a",
      });
    expect(call("delete_repo")?.marker).toMatchObject({
      toolName: "delete_repo",
      reason: "readOnlyModeUnclassified",
    });
    expect(call("read_file")).toBeNull();
  });
});
