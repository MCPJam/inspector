/**
 * The Cursor CLI route through the real runner, the real planner and the real
 * native admission, with Cursor's own adapter declarations.
 *
 * A gap-free profile (MCPJam's 300 s outer timeout, no client overrides) in an
 * organization enrolled in forwarding gets pure pass-through: a forwarding
 * grant without a model lease, and the same MCP config on every turn. The
 * routing record proves each surface: enrolled Playground, an unenrolled
 * organization, an eval, a swarm, and the built-in profile's gaps today.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  createHarness: vi.fn((_args: Record<string, unknown>) => ({
    harnessId: "cursor",
  })),
  parts: (() => [{ type: "finish", finishReason: "stop" }]) as (
    mcpJson: { mcpServers: Record<string, unknown> },
  ) => Array<Record<string, unknown>>,
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => harnessState.session);
    stream = vi.fn(async () => {
      const last = harnessState.createHarness.mock.calls.at(-1)?.[0] as
        | { mcpJson: { mcpServers: Record<string, unknown> } }
        | undefined;
      const parts = harnessState.parts(last?.mcpJson ?? { mcpServers: {} });
      return {
        fullStream: (async function* () {
          for (const part of parts) yield part;
        })(),
        text: Promise.resolve("done"),
      };
    });
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../registry.js")>();
  const cursor = actual.getHarnessAdapter("cursor");
  return {
    ...actual,
    getHarnessAdapter: vi.fn(() => ({
      ...cursor,
      createHarness: harnessState.createHarness,
    })),
  };
});

const secrets = vi.hoisted(() => ({ selection: ["secret-cursor"] }));
vi.mock("../../computers/convex-secrets-client.js", () => ({
  convexListProjectSecretBindings: vi.fn(async () => []),
  convexGetEnvironmentSecretSelection: vi.fn(async () => secrets.selection),
  convexListSecretsForRuntimeExecution: vi.fn(async () => []),
  convexMarkSecretsDelivered: vi.fn(async () => ({ marked: 0 })),
}));
vi.mock("../../computers/control-plane-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../computers/control-plane-client.js")
  >()),
  getHarnessCredentialReadiness: vi.fn(async () => ({ ok: true, value: { readiness: "ready" } })),
  getBoxCredentialAvailability: vi.fn(async () => ({ ok: false, status: 404 })),
}));
vi.mock("../resolve-sandbox.js", () => ({
  resolveHarnessSandbox: vi.fn(async () => ({
    computerId: "computer-1",
    sandboxId: "sandbox-1",
  })),
}));
vi.mock("../e2b-sandbox-provider.js", () => ({
  createE2BHarnessSandboxProvider: vi.fn(() => ({ sandboxId: "sandbox-1" })),
}));
vi.mock("../runtime-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-skills.js")>()),
  fetchRuntimeSkills: vi.fn(async () => ({ ok: true, skills: [] })),
  skillsFingerprint: vi.fn(() => "empty-skills"),
}));
vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: vi.fn(async () => {}),
}));
vi.mock("../harness-proxy-token-client.js", () => ({
  fetchHarnessProxyTokens: vi.fn(async () => ({
    ok: true,
    tokens: { "srv-a": "per-turn-token" },
  })),
}));

const lanes = vi.hoisted(() => ({ claims: 0 }));
vi.mock("../harness-session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-session-state.js")>()),
  claimHarnessSessionState: vi.fn(async () => ({
    ok: true,
    laneId: "lane-1",
    leaseId: `lease-${++lanes.claims}`,
    stateVersion: 1,
    state: null,
    fingerprintChanged: false,
  })),
  commitHarnessSessionState: vi.fn(async () => true),
  heartbeatHarnessSessionState: vi.fn(async () => "ok"),
  releaseHarnessSessionState: vi.fn(async () => {}),
}));

vi.mock("../harness-model-broker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-model-broker.js")>()),
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  renewHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => ({ ok: true })),
  startHarnessModelBroker: vi.fn(async () => {
    throw new Error("an external-account turn must never start a model lease");
  }),
}));

import { runHarnessTurn } from "../run-harness-turn";
import { revokeHarnessModelBroker } from "../harness-model-broker.js";
import { harnessServerKeyToName, toAcpMcpServers, type HarnessMcpJson } from "../mcp-config";
import { unsealHarnessProxyToken } from "../harness-proxy-policy-seal";
import { setManagerOrganization } from "../../mcp-connections";
import { extractToolErrors } from "@/shared/eval-matching";

const HANDLE = "lane-1-session-handle";
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const KEY = Object.keys(harnessServerKeyToName([{ name: "srv-a" }]))[0]!;

/** MCPJam's own connection to the server: the profile admission reads. */
function manager(config: Record<string, unknown>, capabilities: object = {}) {
  const value = {
    getServerConfig: vi.fn(() => config),
    getInitializationInfo: vi.fn(() => ({
      transport: "streamable-http",
      protocolVersion: "2025-11-25",
      clientCapabilities: capabilities,
    })),
  };
  setManagerOrganization(value as never, "org_1");
  return value;
}
/** A profile with nothing native admission counts as a gap. */
const GAP_FREE = { url: "https://server.test/mcp", timeout: 300_000 };
/** What the built-in `cursor-cli` template sets today. */
const BUILT_IN = {
  url: "https://server.test/mcp",
  timeout: 10_000,
  clientInfo: { name: "cursor-vscode", version: "1.0.0" },
  supportedProtocolVersions: ["2025-06-18"],
};

function turn(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "write it" }] },
  ];
  return {
    messages,
    modelId: "cursor/auto",
    provider: "cursor",
    systemPrompt: "Use tools.",
    authHeader: "Bearer test",
    projectId: "p1",
    environmentId: "env-1",
    harnessSandboxBinding: { sandboxRowId: "computer-1", sandboxId: "sandbox-1" },
    runtimeSecrets: [{ name: "CURSOR_API_KEY", value: "fixture-key", updatedAt: 1 }],
    mcpClientManager: manager(GAP_FREE),
    selectedServers: ["srv-a"],
    harnessMcpProxy: {
      plane: "web-authorized",
      mode: "direct",
      publicBaseUrl: "https://inspector.test",
    },
    respectToolVisibility: false,
    requireToolApproval: false,
    sourceType: "direct",
    harness: "cursor",
    hostId: "host-1",
    chatSessionId: "chat-1",
    ...overrides,
  };
}

async function record(options: Record<string, unknown>) {
  const onConversationComplete = vi.fn(async () => ({ outcome: "saved" }));
  const onEngineError = vi.fn();
  await runHarnessTurn(
    { ...options, onConversationComplete, onEngineError } as never,
    "none",
  );
  expect(onEngineError).not.toHaveBeenCalled();
  const done = onConversationComplete.mock.calls as unknown as Array<
    [ModelMessage[], { harnessMcpAtTurn?: Record<string, unknown> }]
  >;
  return { messages: done[0]![0], receipt: done[0]![1].harnessMcpAtTurn };
}
const configs = () =>
  harnessState.createHarness.mock.calls.map(
    ([args]) => args.mcpJson as HarnessMcpJson,
  );
const posted = (path: string) =>
  calls.filter((call) => call.path === path).map((call) => call.body);

beforeEach(() => {
  vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
  vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", "org_1");
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-service-token-for-tests");
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "test-harness-proxy-secret-32-chars";
  calls.length = 0;
  lanes.claims = 0;
  harnessState.createHarness.mockClear();
  harnessState.parts = () => [{ type: "finish", finishReason: "stop" }];
  vi.mocked(revokeHarnessModelBroker).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ path, body });
      if (path === "/web/harness/forwarding/start")
        return Response.json({
          ok: true,
          runId: body.runId,
          expiresAt: Date.now() + 15 * 60_000,
          delivery: "e2b-network-transform",
          forwardingOwners: body.nativeForwarding.servers.map(
            (server: { serverId: string }) => ({
              kind: "chat",
              userId: "user_convex_1",
              serverId: server.serverId,
              harnessSessionId: body.nativeForwarding.harnessSessionId,
            }),
          ),
          forwardingOrigin: "https://inspector.test",
        });
      if (path === "/web/harness/session-grant/start")
        return Response.json({
          ok: true,
          runId: body.runId,
          expiresAt: Date.now() + 15 * 60_000,
          delivery: "e2b-network-transform",
          grantOrigin: "https://inspector.test",
        });
      if (path === "/web/harness/session-state/bind-turn")
        return Response.json({
          ok: true,
          bound: true,
          laneId: "lane-1",
          handles: { "srv-a": HANDLE },
        });
      if (path === "/internal/v1/harness-forwarding/executions")
        return Response.json(
          body.operation.kind === "bind_policy" ? { bound: true } : [],
        );
      return Response.json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the Cursor CLI on pass-through forwarding", () => {
  it("forwards a gap-free profile with no lease, and the same MCP config every turn", async () => {
    const first = await record(turn());
    const second = await record(turn());
    expect(first.receipt).toMatchObject({
      upstream: "harness",
      delivery: "mcp-endpoint",
      forwarding: { kind: "pass-through" },
      gaps: [],
      reasons: [],
      pinnedRuntimeVersion: "2026.11.05-86047df",
      adapterVersion: "acp-forward-v1",
    });
    expect(first.receipt).not.toHaveProperty("profile");
    expect(second.receipt).toEqual(first.receipt);

    const starts = posted("/web/harness/forwarding/start");
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({
      harnessId: "cursor",
      sandboxRowId: "computer-1",
      nativeForwarding: {
        harnessSessionId: "lane-1",
        hostId: "host-1",
        servers: [{ serverId: "srv-a" }],
      },
    });
    expect(starts[0]!.runId).not.toBe(starts[1]!.runId);
    // Teardown clears each turn's grant by the turn it was installed for.
    expect(vi.mocked(revokeHarnessModelBroker).mock.calls.map(([args]) => args.runId))
      .toEqual(starts.map((start) => start.runId));

    const [one, two] = configs();
    expect(JSON.stringify(toAcpMcpServers(two!))).toBe(
      JSON.stringify(toAcpMcpServers(one!)),
    );
    const entry = one!.mcpServers[KEY]!;
    expect(new URL(entry.url).searchParams.get("native")).toBe("1");
    expect(entry).not.toHaveProperty("timeout");
    expect(unsealHarnessProxyToken(entry.headers!["X-MCPJam-Forwarding-Context"], "srv-a"))
      .toMatchObject({ session: true, token: HANDLE });
    // Each turn binds itself on the lane and on its own grant.
    const binds = posted("/web/harness/session-state/bind-turn");
    expect(binds).toHaveLength(2);
    expect(binds[0]!.servers).toEqual(binds[1]!.servers);
    const policies = posted("/internal/v1/harness-forwarding/executions")
      .map((body) => body.operation as Record<string, unknown>)
      .filter((operation) => operation.kind === "bind_policy");
    expect(policies.map((operation) => operation.turnId)).toEqual(
      starts.map((start) => start.runId),
    );
  });

  it("keeps an organization not enrolled in forwarding on the signed proxy", async () => {
    vi.stubEnv("HARNESS_FORWARDING_ORGANIZATION_IDS", "another-org");
    const { receipt } = await record(turn());
    expect(receipt).toMatchObject({
      upstream: "mcpjam",
      delivery: "mcp-endpoint",
      profile: "client",
      reasons: ["organization not enrolled"],
    });
    expect(receipt).not.toHaveProperty("forwarding");
    expect(posted("/web/harness/forwarding/start")).toHaveLength(0);
    // The signed proxy takes the session envelope only with this box's grant.
    expect(posted("/web/harness/session-grant/start")).toHaveLength(1);
    expect(new URL(configs()[0]!.mcpServers[KEY]!.url).searchParams.has("native")).toBe(false);
  });

  it.each([
    ["eval iteration", { sourceType: "eval", evalIterationId: "iteration-1" }],
    ["journey run", { sourceType: "swarm", journeyRunId: "journey-run-1" }],
  ])("records the signed proxy for an %s", async (reason, overrides) => {
    const { receipt } = await record(turn(overrides));
    expect(receipt).toMatchObject({
      upstream: "mcpjam",
      delivery: "mcp-endpoint",
      profile: "client",
      reasons: [reason],
    });
    expect(posted("/web/harness/forwarding/start")).toHaveLength(0);
  });

  it("keeps the built-in profile on the signed proxy with its gaps listed, never on the bridge", async () => {
    const { receipt } = await record(
      turn({
        mcpClientManager: manager(BUILT_IN, { roots: {}, elicitation: {} }),
        respectToolVisibility: true,
      }),
    );
    expect(receipt).toMatchObject({
      upstream: "mcpjam",
      delivery: "mcp-endpoint",
      profile: "client",
      reasons: ["forwarding not admitted; configured route retained"],
    });
    expect(receipt).not.toHaveProperty("forwarding");
    expect(receipt?.gaps).toEqual(
      expect.arrayContaining([
        "tool-visibility",
        "client-capabilities",
        "client-identity",
        "protocol-pins",
        "request-timeout",
      ]),
    );
    expect(posted("/web/harness/forwarding/start")).toHaveLength(0);
  });
});

describe("a Cursor tool call that timed out", () => {
  const TIMEOUT = "MCP error -32001: Request timed out";
  beforeEach(() => {
    harnessState.parts = (mcpJson) => [
      {
        type: "tool-call",
        toolCallId: "tool_1",
        toolName: "acp_tool_tool_1",
        input: JSON.stringify({
          providerIdentifier: Object.keys(mcpJson.mcpServers)[0],
          toolName: "slow_write",
          args: { text: "a" },
        }),
        providerExecuted: true,
      },
      // ACP reports Cursor's own 60 s timeout as `completed` with `rawOutput.error`.
      {
        type: "tool-result",
        toolCallId: "tool_1",
        toolName: "acp_tool_tool_1",
        result: { error: TIMEOUT },
      },
      { type: "finish", finishReason: "stop" },
    ];
  });

  it.each([
    ["the Playground, forwarded", {}],
    ["an eval, on the signed proxy", { sourceType: "eval", evalIterationId: "iteration-1" }],
  ])("is a tool error in %s, with Cursor's reason", async (_surface, overrides) => {
    const onToolResult = vi.fn();
    const { messages } = await record(turn({ ...overrides, onToolResult }));
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "slow_write",
        serverId: "srv-a",
        isError: true,
      }),
    );
    // The check an eval runs over the saved transcript counts it.
    expect(extractToolErrors(messages)).toEqual([
      expect.objectContaining({
        kind: "protocol-error",
        toolName: "slow_write",
        message: TIMEOUT,
      }),
    ]);
  });
});
