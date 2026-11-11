/**
 * What a harness turn does with its MCP route decision, observed through the
 * real runner: the retained-route log line, the session fingerprint, the label
 * required discovery sees, and the discovery guard itself.
 *
 * The mock preamble follows `run-harness-turn-host-executed-options.test.ts`;
 * the route table itself lives in `harness-mcp-plan.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const loggerSpy = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  systemEvent: vi.fn(),
}));
vi.mock("../../logger.js", () => ({ logger: loggerSpy }));

const harnessState = vi.hoisted(() => ({
  streamParts: [{ type: "finish", finishReason: "stop" }] as Array<
    Record<string, unknown> & { type?: string }
  >,
  createRuntime: vi.fn(() => ({ harnessId: "claude-code" })),
  stream: vi.fn(),
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

const adapterDelivery = vi.hoisted(() => ({ value: "harness" }));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => harnessState.session);
    stream = vi.fn(async (args: Record<string, unknown>) => {
      harnessState.stream(args);
      return {
        fullStream: (async function* () {
          for (const part of harnessState.streamParts) yield part;
        })(),
        text: Promise.resolve("done"),
      };
    });
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
    pinnedRuntimeVersion: "2.1.245",
    forwardingRuntime: {
      runtimeVersion: "2.1.245",
      configurationVersion: "config-v1",
      refresh: (runtime: object) => runtime,
    },
    displayName: "Claude Code",
    defaultPermissionMode: "allow-all",
    approvalPermissionMode: "allow-reads",
    supportsSkills: false,
    supportsNativeToolApproval: false,
    supportsHostExecutedToolApproval: false,
    supportsMcpToolApproval: false,
    mcpDelivery: adapterDelivery.value,
    mcpNativeDelivery: "session-config",
    supportsModel: vi.fn(() => true),
    toNativeModel: vi.fn(() => "claude-haiku-4-5"),
    createHarness: harnessState.createRuntime,
    parseToolName: vi.fn((toolName: string) =>
      toolName.startsWith("mcp__")
        ? { serverId: "srv-a", toolName: toolName.split("__").at(-1) }
        : { toolName },
    ),
  })),
}));

const projectSpy = vi.hoisted(() =>
  vi.fn(async (_args: Record<string, unknown>) => ({
    tools: {},
    keyToServerId: { server: "srv-a" },
  })),
);
vi.mock("../host-executed-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../host-executed-mcp-tools.js")>()),
  projectSelectedMcpServersAsHostTools: projectSpy,
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
// Convex mints the per-server identity token the rebuild proxy route seals.
vi.mock("../harness-proxy-token-client.js", () => ({
  fetchHarnessProxyTokens: vi.fn(async () => ({
    ok: true,
    tokens: { "srv-a": "bare-token" },
  })),
}));

const claims = vi.hoisted(() => [] as Array<{ runtimeFingerprint: string }>);
vi.mock("../harness-session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-session-state.js")>()),
  claimHarnessSessionState: vi.fn(
    async (args: { runtimeFingerprint: string }) => {
      claims.push(args);
      return {
        ok: true,
        leaseId: "lease-1",
        stateVersion: 1,
        state: null,
        fingerprintChanged: false,
      };
    },
  ),
  commitHarnessSessionState: vi.fn(async () => true),
  heartbeatHarnessSessionState: vi.fn(async () => "ok"),
  releaseHarnessSessionState: vi.fn(async () => {}),
}));

const broker = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../harness-model-broker.js", () => ({
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => {
    broker.start();
    return {
      ok: true,
      proxyBaseUrl: "https://broker.example",
      forwarding: {},
      expiresAt: Date.now() + 60_000,
    };
  }),
}));

const RAW = { content: [{ type: "text", text: "raw from the server" }] };
const forwarding = vi.hoisted(() => ({
  allowed: true,
  admission: vi.fn((): { delivery?: "native" | "bridge"; gaps: string[] } => ({
    gaps: [],
  })),
  prepare: vi.fn(async (_args: Record<string, unknown>) => ({
    mcpJson: { mcpServers: { server: { url: "https://forward.test/mcp" } } },
    keyToServerId: { server: "srv-a" },
    policyDigest: "policy",
    logScopeIds: {},
    isForwardedTool: () => true,
    readToolResult: vi.fn(async () => RAW),
    stop: vi.fn(async () => {}),
  })),
}));
vi.mock("../forwarding/enhanced-admission.js", () => ({
  forwardingAdmission: forwarding.admission,
}));
vi.mock("../forwarding/native-turn.js", async (original) => ({
  ...(await original<typeof import("../forwarding/native-turn.js")>()),
  hasForwardingOrganization: () => forwarding.allowed,
  nativeForwardingSelection: () => ({ serverIds: ["srv-a"] }),
  prepareNativeForwarding: forwarding.prepare,
}));

/** Records what required discovery was asked, then refuses like the real gate. */
const discovery = vi.hoisted(() => ({
  calls: [] as Array<{ required?: boolean; route?: { delivery?: string } }>,
}));
vi.mock("../native-discovery.js", async (original) => {
  const actual = await original<typeof import("../native-discovery.js")>();
  return {
    ...actual,
    assertNativeDiscovery: vi.fn(
      (args: Parameters<typeof actual.assertNativeDiscovery>[0]) => {
        discovery.calls.push(args);
        actual.assertNativeDiscovery({ required: args.required });
      },
    ),
  };
});

import { runHarnessTurn } from "../run-harness-turn";
import { harnessConnectionFingerprint } from "../harness-connection-profile";
import { setManagerConnections } from "../../mcp-connections";

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

/** A hosted Claude Code chat whose organization is enrolled in forwarding. */
function enrolled(overrides: Record<string, unknown> = {}) {
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
    hostId: "host-claude",
    chatSessionId: "chat-claude",
    ...overrides,
  };
}

/** The four routes, each reached through the runner's own inputs. */
const ROUTES = {
  "forwarded-native": {
    admission: { delivery: "native", gaps: [] },
    options: {},
  },
  "forwarded-bridge": {
    admission: { delivery: "bridge", gaps: ["app-host-capabilities"] },
    options: {},
  },
  "native-proxy": {
    admission: { gaps: ["unqualified-protocol"] },
    options: {},
  },
  "host-tools": {
    admission: { gaps: ["unqualified-protocol"] },
    options: { agentLoop: "claude-code" },
  },
} as const;

function admit(route: keyof typeof ROUTES) {
  const { admission } = ROUTES[route];
  forwarding.admission.mockReturnValue({
    ...admission,
    gaps: [...admission.gaps],
  });
  return enrolled(ROUTES[route].options);
}

function retainedLogs() {
  return loggerSpy.info.mock.calls.filter(([message]) =>
    String(message).startsWith("[harness] retaining configured bridge"),
  );
}

beforeEach(() => {
  vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
  vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "x".repeat(48));
  adapterDelivery.value = "harness";
  forwarding.allowed = true;
  forwarding.admission.mockReset().mockReturnValue({ gaps: [] });
  forwarding.prepare.mockClear();
  projectSpy.mockClear();
  harnessState.createRuntime.mockClear();
  harnessState.stream.mockClear();
  broker.start.mockClear();
  loggerSpy.info.mockClear();
  discovery.calls.length = 0;
  claims.length = 0;
  harnessState.streamParts = [{ type: "finish", finishReason: "stop" }];
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the retained-route log line", () => {
  it("names every gap, byte for byte, when forwarding is not admitted", async () => {
    forwarding.admission.mockReturnValue({
      gaps: ["unqualified-protocol", "tasks"],
    });
    await runHarnessTurn(
      enrolled({ agentLoop: "claude-code" }) as never,
      "none",
    );
    expect(retainedLogs()).toEqual([
      [
        "[harness] retaining configured bridge (unqualified-protocol, tasks)",
        { gaps: ["unqualified-protocol", "tasks"] },
      ],
    ]);
    expect(projectSpy).toHaveBeenCalledOnce();
  });

  it("is silent when the turn was never a forwarding candidate", async () => {
    vi.stubEnv("HARNESS_NATIVE_FORWARDING", "false");
    await runHarnessTurn(
      enrolled({ agentLoop: "claude-code" }) as never,
      "none",
    );
    expect(forwarding.admission).not.toHaveBeenCalled();
    expect(retainedLogs()).toEqual([]);
  });
});

describe("profiled forwarding", () => {
  it("prepares the bridge with this manager's sealed connection profiles", async () => {
    await runHarnessTurn(admit("forwarded-bridge") as never, "none");
    expect(forwarding.prepare).toHaveBeenCalledOnce();
    expect(forwarding.prepare.mock.calls[0]![0]).toMatchObject({
      delivery: "bridge",
      profiles: {
        "srv-a": expect.objectContaining({ mcpProtocolVersion: "2026-07-28" }),
      },
    });
  });

  it("keeps pass-through forwarding off the bridge arguments", async () => {
    await runHarnessTurn(admit("forwarded-native") as never, "none");
    expect(forwarding.prepare.mock.calls[0]![0]).not.toHaveProperty("delivery");
    expect(forwarding.prepare.mock.calls[0]![0]).not.toHaveProperty("profiles");
  });
});

describe("what the UI shows for a forwarded tool result", () => {
  const projected = { type: "text", value: "the harness projection" };
  async function outputFor(route: "forwarded-native" | "forwarded-bridge") {
    harnessState.streamParts = [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "mcp__server__echo",
        input: {},
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "mcp__server__echo",
        output: projected,
      },
      { type: "finish", finishReason: "stop" },
    ];
    const turn = await runHarnessTurn(admit(route) as never, "ui");
    const wire = await turn.response!.text();
    const chunks = wire
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    return chunks.find((chunk) => chunk.type === "tool-output-available")
      ?.output;
  }

  it("shows the raw server result on pass-through forwarding", async () => {
    expect(await outputFor("forwarded-native")).toEqual(RAW);
  });

  it("shows the harness's own projection on profiled forwarding", async () => {
    expect(await outputFor("forwarded-bridge")).toEqual(projected);
  });
});

describe("the session fingerprint", () => {
  it("forks between pass-through, profiled and unforwarded turns", async () => {
    await runHarnessTurn(admit("forwarded-native") as never, "none");
    await runHarnessTurn(admit("forwarded-bridge") as never, "none");
    vi.stubEnv("HARNESS_NATIVE_FORWARDING", "false");
    await runHarnessTurn(enrolled() as never, "none");
    const fingerprints = claims.map((claim) => claim.runtimeFingerprint);
    expect(fingerprints).toHaveLength(3);
    expect(new Set(fingerprints).size).toBe(3);
  });
});

describe("required native discovery", () => {
  it.each(Object.keys(ROUTES) as Array<keyof typeof ROUTES>)(
    "checks the %s label and refuses before anything is provisioned",
    async (route) => {
      const turn = await runHarnessTurn(
        { ...admit(route), requireNativeToolDiscovery: true } as never,
        "ui",
      );
      expect(await turn.response!.text()).toContain(
        "qualified harness execution route",
      );
      expect(discovery.calls.map((call) => call.route?.delivery)).toEqual([
        route,
      ]);
      expect(harnessState.createRuntime).not.toHaveBeenCalled();
      expect(forwarding.prepare).not.toHaveBeenCalled();
      expect(broker.start).not.toHaveBeenCalled();
    },
  );

  it.each(Object.keys(ROUTES) as Array<keyof typeof ROUTES>)(
    "is never consulted on an ordinary %s turn",
    async (route) => {
      await runHarnessTurn(admit(route) as never, "none");
      expect(discovery.calls).toEqual([]);
      expect(harnessState.createRuntime).toHaveBeenCalledOnce();
      expect(harnessState.stream).toHaveBeenCalledOnce();
    },
  );
});

describe("turns outside the hosted forwarding surface", () => {
  it.each([
    ["a scenario turn", { scenarioId: "scenario-1", sourceType: "scenario" }],
    ["a journey run", { journeyRunId: "journey-1", sourceType: "swarm" }],
    ["a turn without a host", { hostId: undefined }],
    ["the local MCP plane", { harnessMcpProxy: { plane: "local-mcp" } }],
  ])("never asks for admission on %s", async (_name, overrides) => {
    forwarding.admission.mockReturnValue({ delivery: "native", gaps: [] });
    await runHarnessTurn(
      enrolled({ agentLoop: "claude-code", ...overrides }) as never,
      "none",
    );
    expect(forwarding.admission).not.toHaveBeenCalled();
    expect(forwarding.prepare).not.toHaveBeenCalled();
  });
});

describe("account routing", () => {
  it("keeps the MCPJam client and hands it the account groups", async () => {
    const options = enrolled({ agentLoop: "claude-code" });
    const groups = {
      "srv-a": [{ key: "srv-a::work" }, { key: "srv-a::personal" }],
    };
    setManagerConnections(options.mcpClientManager as never, groups as never);
    forwarding.admission.mockReturnValue({ delivery: "native", gaps: [] });
    await runHarnessTurn(options as never, "none");
    expect(forwarding.admission).not.toHaveBeenCalled();
    expect(projectSpy).toHaveBeenCalledOnce();
    expect(projectSpy.mock.calls[0]![0]).toMatchObject({
      connectionsByServerId: groups,
    });
  });

  it("refuses an eval that would move a harness off its own MCP client", async () => {
    const options = enrolled({ evalIterationId: "iteration-1" });
    setManagerConnections(options.mcpClientManager as never, {
      "srv-a": [{ key: "srv-a" }, { key: "srv-a#personal" }],
    } as never);
    const turn = await runHarnessTurn(options as never, "ui");
    expect(await turn.response!.text()).toContain(
      "This client runs evals on one account per server.",
    );
    expect(harnessState.createRuntime).not.toHaveBeenCalled();
    expect(projectSpy).not.toHaveBeenCalled();
  });

  it("runs an eval on one chosen account through the harness's own client", async () => {
    const options = enrolled({ evalIterationId: "iteration-1" });
    setManagerConnections(options.mcpClientManager as never, {
      "srv-a": [{ key: "srv-a" }],
    } as never);
    admit("forwarded-native");
    await runHarnessTurn(options as never, "none");
    expect(projectSpy).not.toHaveBeenCalled();
  });
});

describe("the route receipt on the persisted turn trace", () => {
  async function persisted(options: Record<string, unknown>) {
    const onConversationComplete = vi.fn(async () => ({ outcome: "saved" }));
    await runHarnessTurn(
      { ...options, onConversationComplete } as never,
      "none",
    );
    expect(onConversationComplete).toHaveBeenCalledOnce();
    const calls = onConversationComplete.mock.calls as unknown as Array<
      [unknown, { harnessMcpAtTurn?: Record<string, unknown> }]
    >;
    return calls[0]![1].harnessMcpAtTurn;
  }

  it("records a host-tools turn on MCPJam's client with the client profile", async () => {
    vi.stubEnv("HARNESS_NATIVE_FORWARDING", "false");
    const receipt = await persisted(enrolled({ agentLoop: "claude-code" }));
    expect(receipt).toMatchObject({
      version: 1,
      upstream: "mcpjam",
      delivery: "host-tools",
      profile: "client",
      reasons: ["forwarding flag off"],
      pinnedRuntimeVersion: "2.1.245",
      adapterVersion: "config-v1",
      plannerVersion: "harness-mcp-plan-v1",
      qualification: { status: "not-required" },
    });
    expect(receipt?.profileDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(["native-proxy", "host-tools"] as const)(
    "omits the profile when %s delivers no servers",
    async (route) => {
      vi.stubEnv("HARNESS_NATIVE_FORWARDING", "false");
      const options = enrolled({
        ...(route === "host-tools" ? { agentLoop: "claude-code" } : {}),
        unavailableServerIds: ["srv-a"],
      });
      if (route === "host-tools") {
        projectSpy.mockResolvedValueOnce({ tools: {}, keyToServerId: {} });
      }
      const receipt = await persisted(options);
      expect(receipt).not.toHaveProperty("profile");
      expect(receipt).not.toHaveProperty("profileDigest");
      expect(receipt?.reasons).toContain("no servers delivered");
    },
  );

  it("digests only delivered servers when another selection is unavailable", async () => {
    vi.stubEnv("HARNESS_NATIVE_FORWARDING", "false");
    const options = enrolled({
      selectedServers: ["srv-a", "srv-b"],
      unavailableServerIds: ["srv-b"],
    });
    const receipt = await persisted(options);
    expect(receipt?.profileDigest).toBe(
      harnessConnectionFingerprint(options.mcpClientManager as never, ["srv-a"]),
    );
    expect(receipt?.profileDigest).not.toBe(
      harnessConnectionFingerprint(options.mcpClientManager as never, ["srv-a", "srv-b"]),
    );
  });

  it("records why forwarding was not admitted on a retained route", async () => {
    forwarding.admission.mockReturnValue({ gaps: ["unqualified-protocol"] });
    const receipt = await persisted(enrolled());
    expect(receipt).toMatchObject({
      upstream: "mcpjam",
      delivery: "mcp-endpoint",
      profile: "client",
      gaps: ["unqualified-protocol"],
      reasons: ["forwarding not admitted; configured route retained"],
    });
    expect(receipt).not.toHaveProperty("forwarding");
  });

  it("records pass-through forwarding with no profile of MCPJam's", async () => {
    const receipt = await persisted(admit("forwarded-native"));
    expect(receipt).toMatchObject({
      upstream: "harness",
      delivery: "mcp-endpoint",
      forwarding: { kind: "pass-through" },
    });
    expect(receipt).not.toHaveProperty("profile");
  });
});
