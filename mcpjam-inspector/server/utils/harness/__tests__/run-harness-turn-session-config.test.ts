/**
 * A runtime that fingerprints its MCP configuration (Cursor's ACP adapter
 * compares every header value on live and cold resume) must get the same MCP
 * config on every turn of its lane, or it starts a new session each turn.
 *
 * Driven through the real runner with the scaffold of
 * `run-harness-turn-mcp-plan.test.ts`: two turns of one Playground chat in an
 * organization that forwarding has not enrolled (the signed proxy), two turns
 * of a swarm session, and an eval turn, which has no lane and keeps per-turn
 * tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  createRuntime: vi.fn((_args: Record<string, unknown>) => ({
    harnessId: "session-stable",
  })),
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => harnessState.session);
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop" };
      })(),
      text: Promise.resolve("done"),
    }));
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../registry.js", () => ({
  buildBrokerDummyAuth: vi.fn(() => ({
    anthropic: {
      apiKey: "",
      authToken: "mcpjam-broker-dummy",
      baseUrl: "https://broker.example",
    },
  })),
  getHarnessAdapter: vi.fn((id = "claude-code") => ({
    id,
    pinnedRuntimeVersion: "1.0.0",
    displayName: "Session-stable runtime",
    defaultPermissionMode: "allow-all",
    approvalPermissionMode: "allow-reads",
    supportsSkills: false,
    supportsNativeToolApproval: false,
    supportsHostExecutedToolApproval: false,
    supportsMcpToolApproval: false,
    mcpDelivery: "harness",
    mcpNativeDelivery: "session-config",
    sessionStableMcpConfig: true,
    // Like Cursor: the customer's own account, so no model lease is minted.
    modelAccess: "external-account",
    externalAccountCredentialEnv: ["VENDOR_API_KEY"],
    supportsModel: vi.fn(() => true),
    toNativeModel: vi.fn(() => "native-model"),
    createHarness: harnessState.createRuntime,
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
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
vi.mock("../runtime-skills.js", () => ({
  frontmatterSafeSkills: vi.fn((skills) => skills),
  fetchRuntimeSkills: vi.fn(async () => ({ ok: true, skills: [] })),
  skillsFingerprint: vi.fn(() => "empty-skills"),
}));
vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: vi.fn(async () => {}),
}));

const minted = vi.hoisted(() => ({ count: 0 }));
vi.mock("../harness-proxy-token-client.js", () => ({
  fetchHarnessProxyTokens: vi.fn(async () => {
    minted.count += 1;
    return { ok: true, tokens: { "srv-a": `per-turn-token-${minted.count}` } };
  }),
}));

vi.mock("../external-account-credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../external-account-credentials.js")>()),
  resolveOrgKeyCredentialPlan: vi.fn(async () => ({
    auth: { VENDOR_API_KEY: "mcpjam-brokered-credential" },
  })),
}));

vi.mock("../harness-session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-session-state.js")>()),
  claimHarnessSessionState: vi.fn(async () => ({
    ok: true,
    laneId: "lane-1",
    stateVersion: 1,
    state: null,
    fingerprintChanged: false,
  })),
  commitHarnessSessionState: vi.fn(async () => true),
  heartbeatHarnessSessionState: vi.fn(async () => "ok"),
  releaseHarnessSessionState: vi.fn(async () => {}),
}));

const revoked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../harness-model-broker.js", async (importOriginal) => ({
  boxRequestFields: (await importOriginal<typeof import("../harness-model-broker.js")>()).boxRequestFields,
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  renewHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async (args: Record<string, unknown>) => {
    revoked.push(args);
    return { ok: true };
  }),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    proxyBaseUrl: "https://broker.example",
    expiresAt: Date.now() + 60_000,
  })),
}));

import { runHarnessTurn } from "../run-harness-turn";
import { toAcpMcpServers, type HarnessMcpJson } from "../mcp-config";
import { unsealHarnessProxyToken } from "../harness-proxy-policy-seal";
import { logger } from "../../logger.js";

const HANDLE = "session-handle-for-lane-1";
const binds: Array<Record<string, unknown>> = [];
const grants: Array<Record<string, unknown>> = [];

function manager() {
  return {
    getServerConfig: vi.fn(() => ({ url: "https://server.test/mcp" })),
    getInitializationInfo: vi.fn(() => ({
      transport: "streamable-http",
      protocolVersion: "2025-11-25",
      clientCapabilities: {},
    })),
  };
}

function turn(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "list the issues" }] },
  ];
  return {
    messages,
    modelId: "anthropic/claude-haiku-4.5",
    provider: "anthropic",
    systemPrompt: "Use tools.",
    authHeader: "Bearer test",
    projectId: "project-1",
    mcpClientManager: manager(),
    selectedServers: ["srv-a"],
    harnessMcpProxy: {
      plane: "web-authorized",
      mode: "direct",
      publicBaseUrl: "https://inspector.test",
    },
    requireToolApproval: false,
    sourceType: "direct",
    harness: "claude-code",
    hostId: "host-1",
    chatSessionId: "chat-1",
    ...overrides,
  };
}

/** The MCP config the runtime was built with on each turn, as ACP receives it. */
function configs(): HarnessMcpJson[] {
  return harnessState.createRuntime.mock.calls.map(
    ([args]) => args.mcpJson as HarnessMcpJson,
  );
}

beforeEach(() => {
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET =
    "test-harness-proxy-secret-32-chars";
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  binds.length = 0;
  grants.length = 0;
  revoked.length = 0;
  minted.count = 0;
  harnessState.createRuntime.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/web/harness/session-grant/start")) {
        const body = JSON.parse(String(init?.body));
        grants.push(body);
        return Response.json({
          ok: true,
          runId: body.runId,
          expiresAt: Date.now() + 15 * 60_000,
          delivery: "e2b-network-transform",
          grantOrigin: "https://inspector.test",
        });
      }
      if (String(url).endsWith("/web/harness/session-state/bind-turn")) {
        const body = JSON.parse(String(init?.body));
        binds.push(body);
        return Response.json({
          ok: true,
          bound: true,
          laneId: "lane-1",
          handles: { "srv-a": HANDLE },
        });
      }
      return Response.json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a session-stable runtime's MCP config", () => {
  it("is identical on both turns of a Playground chat, with the runtime restarted between them", async () => {
    await runHarnessTurn(turn() as never, "none");
    // A restart resumes with `session/load`, which compares the same config.
    await runHarnessTurn(turn() as never, "none");
    const [first, second] = configs();
    expect(first).toBeDefined();
    expect(JSON.stringify(toAcpMcpServers(second!))).toBe(
      JSON.stringify(toAcpMcpServers(first!)),
    );
    const entry = Object.values(first!.mcpServers)[0]!;
    expect(entry.url).toBe("https://inspector.test/api/web/harness-mcp/srv-a");
    // Only the session envelope: no turn id in a header or in the URL.
    expect(Object.keys(entry.headers ?? {})).toEqual(["X-MCPJam-Proxy-Token"]);
    const sealed = unsealHarnessProxyToken(
      entry.headers!["X-MCPJam-Proxy-Token"],
      "srv-a",
    );
    expect(sealed).toMatchObject({ session: true, token: HANDLE });
    // No per-turn token was minted for either turn.
    expect(minted.count).toBe(0);
    // Each turn bound itself, with its own turn id and the same digest.
    expect(binds).toHaveLength(2);
    expect(binds[0]).toMatchObject({
      ownerType: "direct-chat",
      chatSessionId: "chat-1",
      servers: [{ serverId: "srv-a", policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    });
    expect(binds[0]!.turnId).not.toBe(binds[1]!.turnId);
    expect(binds[0]!.servers).toEqual(binds[1]!.servers);
  });

  it("is identical on both turns of a swarm session", async () => {
    const swarm = {
      sourceType: "swarm",
      journeyRunId: "journey-run-1",
      hostId: "host-1",
      chatSessionId: "swarm-chat-1",
    };
    await runHarnessTurn(turn(swarm) as never, "none");
    await runHarnessTurn(turn(swarm) as never, "none");
    const [first, second] = configs();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(binds.map((bind) => bind.ownerType)).toEqual([
      "swarm-chat",
      "swarm-chat",
    ]);
    expect(binds[0]).toMatchObject({ journeyRunId: "journey-run-1" });
  });

  it("fails the turn before the runtime starts when the lease cannot be bound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ok: true, bound: false, reason: "lease_unavailable" }),
      ),
    );
    const onEngineError = vi.fn();
    await runHarnessTurn(turn({ onEngineError }) as never, "none");
    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onEngineError.mock.calls[0]![0])).toContain(
      "Couldn't connect this turn to its chat session. Send your message again.",
    );
    expect(harnessState.createRuntime).not.toHaveBeenCalled();
  });

  it("installs each turn's session grant on its box and revokes it at teardown", async () => {
    await runHarnessTurn(turn() as never, "none");
    await runHarnessTurn(turn() as never, "none");
    // The grant is the turn's own, for the lane lease the claim returned.
    expect(grants).toHaveLength(2);
    expect(grants[0]).toMatchObject({
      computerId: "computer-1",
      projectId: "project-1",
      harnessId: "claude-code",
      sessionGrant: { harnessSessionId: "lane-1", leaseId: expect.any(String) },
    });
    expect(grants[0]!.runId).not.toBe(grants[1]!.runId);
    expect(revoked.map((call) => call.runId)).toEqual(
      grants.map((grant) => grant.runId),
    );
  });

  it("fails the turn before the runtime starts when the grant cannot be installed", async () => {
    const onEngineError = vi.fn();
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) =>
      String(url).endsWith("/web/harness/session-grant/start")
        ? Response.json(
            { ok: false, error: "A harness run is already active on this computer." },
            { status: 409 },
          )
        : original(url, init),
    );
    await runHarnessTurn(turn({ onEngineError }) as never, "none");
    expect(JSON.stringify(onEngineError.mock.calls[0]?.[0])).toContain(
      "A harness run is already active on this computer.",
    );
    expect(harnessState.createRuntime).not.toHaveBeenCalled();
    // The run id was set, so teardown cleared whatever was installed.
    expect(revoked).toHaveLength(1);
  });

  it("keeps per-turn tokens when the grant's origin is not the proxy's, and says so once", async () => {
    // A preview or self-hosted Inspector: the backend's forwarding origin is
    // another deployment's, where egress injects the grant.
    const warn = vi.spyOn(logger, "warn");
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) =>
      String(url).endsWith("/web/harness/session-grant/start")
        ? Response.json({
            ok: true,
            runId: JSON.parse(String(init?.body)).runId,
            expiresAt: Date.now() + 60_000,
            delivery: "e2b-network-transform",
            grantOrigin: "https://elsewhere.test",
          })
        : original(url, init),
    );
    const onEngineError = vi.fn();
    await runHarnessTurn(turn({ onEngineError }) as never, "none");
    expect(onEngineError).not.toHaveBeenCalled();
    const entry = Object.values(configs()[0]!.mcpServers)[0]!;
    const sealed = unsealHarnessProxyToken(
      entry.headers?.["X-MCPJam-Proxy-Token"],
      "srv-a",
    );
    expect(sealed?.token).toBe("per-turn-token-1");
    expect(sealed?.session).toBeUndefined();
    expect(minted.count).toBe(1);
    const fallbacks = warn.mock.calls.filter(([message]) =>
      String(message).includes("session grant origin differs"),
    );
    expect(fallbacks).toEqual([
      [
        "[harness] session grant origin differs from the MCP proxy; using per-turn tokens",
        { proxyOrigin: "https://inspector.test", grantOrigin: "https://elsewhere.test" },
      ],
    ]);
    // Teardown still revokes the grant the turn installed.
    expect(revoked).toHaveLength(1);
    warn.mockRestore();
  });

  it("keeps per-turn tokens through a relay, where no session grant can reach the proxy", async () => {
    await runHarnessTurn(
      turn({ harnessMcpProxy: { plane: "web-authorized", mode: "relay" } }) as never,
      "none",
    );
    expect(binds).toHaveLength(0);
    expect(grants).toHaveLength(0);
  });

  it("keeps per-turn tokens for an eval turn, which has no lane to resume", async () => {
    await runHarnessTurn(
      turn({ sourceType: "eval", evalIterationId: "iteration-1" }) as never,
      "none",
    );
    expect(binds).toHaveLength(0);
    expect(minted.count).toBe(1);
  });
});
