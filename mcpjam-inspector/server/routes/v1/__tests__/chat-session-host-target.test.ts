import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * HOST TARGETING on `POST /v1/chat-sessions/messages` — which ENGINE ran.
 *
 * Every property here is one whose violation is INVISIBLE in the response
 * body, which is exactly how the bug this file exists for reached production:
 * a turn aimed at a Cursor-harness environment answered 200, reported a plain
 * `anthropic/…` model, and had run MCPJam's emulated engine the whole time.
 *
 *   1. A HARNESS HOST DISPATCHES THE HARNESS. Reading the host's `harness`
 *      is not enough — the turn also has to reach `runHarnessTurn` with an MCP
 *      proxy strategy, which it THROWS without whenever servers are selected.
 *      Both are asserted, because either one missing is a silently emulated
 *      turn rather than an error.
 *   2. THE BODY NEVER SUPPLIES THE ENGINE. `harness` in the request is a 400,
 *      and the engine is read only off the config the server fetched.
 *   3. TWO POINTERS THAT DISAGREE ARE REFUSED. A `hostId` contradicting the
 *      environment's own host must not be resolved by precedence.
 *   4. AN UNAVAILABLE RUNTIME IS A NAMED PRE-STREAM REFUSAL. Never a fallback:
 *      the assertion is that no runtime was resolved and no turn was run, not
 *      merely that the status code was unhappy.
 *   5. EVERY TURN NAMES ITS ENGINE. Emulated turns too — a response that says
 *      nothing is indistinguishable from one that ran the harness.
 *
 * The availability gate itself is NOT mocked. It is driven through the real
 * environment (`E2B_API_KEY` and friends), so these tests exercise the same
 * `checkHarnessRuntimeAvailable` chat, swarms and eval admission call, and a
 * new rule added there shows up here.
 */

const {
  queryMock,
  mutationMock,
  fetchHostRuntimeConfigMock,
  resolveEnvironmentForRuntimeMock,
  createManualHostedConnectionMock,
  resolveHostModelDefinitionMock,
  prepareChatV2Mock,
  resolveTurnRuntimeMock,
  runUnifiedAssistantTurnMock,
  persistChatSessionToConvexMock,
  getToolsMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  resolveEnvironmentForRuntimeMock: vi.fn(),
  createManualHostedConnectionMock: vi.fn(),
  resolveHostModelDefinitionMock: vi.fn(),
  prepareChatV2Mock: vi.fn(),
  resolveTurnRuntimeMock: vi.fn(),
  runUnifiedAssistantTurnMock: vi.fn(),
  persistChatSessionToConvexMock: vi.fn(),
  getToolsMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
}));

vi.mock("../../../utils/host-runtime-config.js", () => ({
  fetchHostRuntimeConfig: (...args: unknown[]) =>
    fetchHostRuntimeConfigMock(...args),
}));

vi.mock("../../../services/environments/runtime.js", () => ({
  resolveEnvironmentForRuntime: (...args: unknown[]) =>
    resolveEnvironmentForRuntimeMock(...args),
  runtimeServerIds: (spec: { servers: { effectiveServerIds: string[] } }) =>
    spec.servers.effectiveServerIds,
  runtimeServerNames: () => [],
}));

vi.mock("../../web/auth.js", () => ({
  createManualHostedConnection: (...args: unknown[]) =>
    createManualHostedConnectionMock(...args),
}));

vi.mock("../../../utils/org-model-config.js", () => ({
  resolveHostModelDefinition: (...args: unknown[]) =>
    resolveHostModelDefinitionMock(...args),
}));

vi.mock("../../../utils/chat-v2-orchestration.js", () => ({
  prepareChatV2: (...args: unknown[]) => prepareChatV2Mock(...args),
}));

vi.mock("../../../utils/resolve-turn-runtime.js", () => ({
  resolveTurnRuntime: (...args: unknown[]) => resolveTurnRuntimeMock(...args),
}));

vi.mock("../../../utils/turn-execution.js", () => ({
  runUnifiedAssistantTurn: (...args: unknown[]) =>
    runUnifiedAssistantTurnMock(...args),
}));

vi.mock("../../../utils/chat-ingestion.js", () => ({
  persistChatSessionToConvex: (...args: unknown[]) =>
    persistChatSessionToConvexMock(...args),
}));

vi.mock("../../../utils/computers/cloud-skill-tools.js", () => ({
  listCloudRuntimeSkills: async () => [],
}));

vi.mock("../../../services/environments/plugin-attribution.js", () => ({
  fetchPluginRuntimeAttribution: async () => null,
}));

vi.mock("../../../services/environments/effective-capabilities.js", () => ({
  resolveEffectiveCapabilities: () => undefined,
  buildLiveEffectiveCapabilities: () => undefined,
}));

vi.mock("../../../utils/analytics.js", () => ({
  captureServerEvent: () => {},
}));

import chatSessions from "../chat-sessions.js";
import { v1OnError } from "../envelope.js";
import { __testing } from "../chat-session-turn.js";
import {
  assertHarnessDispatchable,
  assertHostPointerAgreement,
  engineLabel,
  harnessOfRuntimeConfig,
  resolveChatSessionEngine,
} from "../chat-session-host-target.js";
import {
  __resetHostedModelCatalogForTests,
  __setHostedCatalogForTests,
} from "../../../services/hosted-model-catalog.js";

const PROJECT = "proj_a";
const MODEL = "anthropic/claude-sonnet-5";
const HOST = "host_claude_code";
const ENVIRONMENT = "env_1";

function turn(body: Record<string, unknown>) {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", chatSessions);
  return app.request("/api/v1/chat-sessions/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** The base body for a FIRST turn that should reach the engine. */
function firstTurn(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT,
    idempotencyKey: `k-${Math.random()}`,
    message: "hi",
    modelId: MODEL,
    // A harness builds its own tool set, so `read_only` is unenforceable there
    // and refused. Every harness case here opts in deliberately.
    toolMode: "auto",
    ...overrides,
  };
}

/** A resolved environment whose host carries `runtimeConfig`. */
function environmentSpec(
  runtimeConfig: Record<string, unknown>,
  hostId = HOST,
) {
  return {
    environmentRef: { environmentId: ENVIRONMENT, name: "prod", revision: 1 },
    host: { hostId, runtimeConfig },
    servers: { effectiveServerIds: ["srv_1"] },
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_URL = "https://convex.test";
  process.env.CONVEX_HTTP_URL = "https://convex.test";
  // Everything `isComputersDataPlaneConfigured()` reads. Set here rather than
  // mocked so the REAL availability gate decides.
  process.env.INSPECTOR_SERVICE_TOKEN = "svc";
  process.env.E2B_API_KEY = "e2b";
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "secret";
  delete process.env.MCPJAM_HARNESS_BROKER_DELIVERY;
  __setHostedCatalogForTests([MODEL]);

  mutationMock.mockImplementation(async (name: string) =>
    name === "chatSessions:claimTurnLease"
      ? { status: "claimed", turnId: "turn_1" }
      : null,
  );
  resolveHostModelDefinitionMock.mockResolvedValue({
    id: MODEL,
    provider: "anthropic",
  });
  getToolsMock.mockResolvedValue([]);
  createManualHostedConnectionMock.mockResolvedValue({
    manager: {
      getTools: getToolsMock,
      disconnectAllServers: async () => {},
    },
  });
  prepareChatV2Mock.mockResolvedValue({
    allTools: {},
    enhancedSystemPrompt: "system",
  });
  resolveTurnRuntimeMock.mockResolvedValue({
    runtime: { kind: "hosted", endpointPath: "/stream" },
    modelSource: "mcpjam",
    finalizeUsage: async () => {},
    classifyFailure: () => "failed",
  });
  runUnifiedAssistantTurnMock.mockResolvedValue({
    messages: [],
    assistantMessages: [
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
    toolCalls: [],
    toolResults: [],
    turnTrace: { turnId: "turn_1", spans: [] },
    usage: { inputTokens: 1, outputTokens: 2 },
    finishReason: "stop",
    aborted: false,
  });
  persistChatSessionToConvexMock.mockResolvedValue({
    outcome: "saved",
    sessionDocId: "cs_1",
    version: 1,
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  __resetHostedModelCatalogForTests();
});

describe("host targeting dispatches the real harness", () => {
  it("runs the harness an ENVIRONMENT's host declares, with an MCP proxy", async () => {
    resolveEnvironmentForRuntimeMock.mockResolvedValue(
      environmentSpec({ harness: "claude-code", modelId: MODEL }),
    );

    const response = await turn(firstTurn({ environmentId: ENVIRONMENT }));
    const body = await response.json();

    expect(response.status).toBe(200);
    // The engine selector reached the runtime resolver…
    expect(resolveTurnRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "claude-code" }),
    );
    // …AND the turn carries the plane strategy `runHarnessTurn` throws without
    // whenever servers are selected. Asserting only the first would pass for a
    // turn that could never actually have run the harness.
    expect(runUnifiedAssistantTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessMcpProxy: expect.objectContaining({
          plane: "web-authorized",
        }),
      }),
    );
    // The response SAYS which engine ran. This is the field whose absence let
    // a silently emulated turn look identical to a harness one.
    expect(body.engine).toBe("harness:claude-code");
    expect(body.hostId).toBe(HOST);
  });

  it("runs the harness an explicit hostId names, using the host's own servers", async () => {
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        hostId: HOST,
        harness: "claude-code",
        selectedServerIds: ["srv_from_host"],
      },
    });

    const response = await turn(firstTurn({ hostId: HOST }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.engine).toBe("harness:claude-code");
    // The server set came off the HOST config, never the request.
    expect(createManualHostedConnectionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverIds: ["srv_from_host"] }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("names the engine on an EMULATED turn too", async () => {
    resolveEnvironmentForRuntimeMock.mockResolvedValue(environmentSpec({}));

    const body = await (
      await turn(firstTurn({ environmentId: ENVIRONMENT }))
    ).json();

    expect(body.engine).toBe("emulated");
    // No harness selector reaches the runtime for a plain host.
    expect(resolveTurnRuntimeMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ harness: expect.anything() }),
    );
  });
});

describe("the request body never supplies the engine", () => {
  it("REJECTS a body-supplied harness rather than honouring or ignoring it", async () => {
    const response = await turn(
      firstTurn({ serverIds: ["srv_1"], harness: "claude-code" }),
    );

    expect(response.status).toBe(400);
    // Refused at the boundary: no lease, so nothing could have spent.
    expect(mutationMock).not.toHaveBeenCalled();
    expect(runUnifiedAssistantTurnMock).not.toHaveBeenCalled();
  });

  it("reads the harness ONLY from the config the server fetched", async () => {
    // The pointer is the same in both cases; only the SERVER-FETCHED config
    // differs, and it alone decides the engine.
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: { hostId: HOST, selectedServerIds: ["srv_1"] },
    });
    const emulated = await (await turn(firstTurn({ hostId: HOST }))).json();
    expect(emulated.engine).toBe("emulated");

    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        hostId: HOST,
        harness: "claude-code",
        selectedServerIds: ["srv_1"],
      },
    });
    const harnessed = await (await turn(firstTurn({ hostId: HOST }))).json();
    expect(harnessed.engine).toBe("harness:claude-code");
  });

  it("FAILS CLOSED when the host config cannot be loaded", async () => {
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: false,
      status: 500,
      error: "convex down",
    });

    const response = await turn(firstTurn({ hostId: HOST }));

    // Never "no host config, therefore emulated": a host we cannot read might
    // be a harness host, and running emulated would misreport the runtime.
    expect(response.status).toBe(502);
    expect(runUnifiedAssistantTurnMock).not.toHaveBeenCalled();
  });
});

describe("two pointers that disagree", () => {
  it("refuses a hostId that contradicts the environment's host", async () => {
    resolveEnvironmentForRuntimeMock.mockResolvedValue(
      environmentSpec({ harness: "claude-code" }, "host_the_env_pins"),
    );
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: { hostId: "host_other", selectedServerIds: ["srv_1"] },
    });

    const response = await turn(
      firstTurn({ environmentId: ENVIRONMENT, hostId: "host_other" }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.details.reason).toBe("HOST_TARGET_CONFLICT");
    // Both ids are named: the caller has to know which one to drop.
    expect(body.details.environmentHostId).toBe("host_the_env_pins");
    expect(body.details.hostId).toBe("host_other");
    expect(runUnifiedAssistantTurnMock).not.toHaveBeenCalled();
  });

  it("accepts a hostId that AGREES — it is an assertion, not a second target", async () => {
    resolveEnvironmentForRuntimeMock.mockResolvedValue(
      environmentSpec({ harness: "claude-code" }, HOST),
    );
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: { hostId: HOST },
    });

    const response = await turn(
      firstTurn({ environmentId: ENVIRONMENT, hostId: HOST }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).engine).toBe("harness:claude-code");
  });
});

describe("an unavailable harness runtime is refused, never emulated", () => {
  it("names the failing rule and runs NOTHING", async () => {
    // The real gate's `computers-unconfigured` arm: this server is not a
    // computers data plane, so the harness has no box to run on.
    delete process.env.E2B_API_KEY;
    resolveEnvironmentForRuntimeMock.mockResolvedValue(
      environmentSpec({ harness: "claude-code" }),
    );

    const response = await turn(firstTurn({ environmentId: ENVIRONMENT }));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.details.reason).toBe("HARNESS_UNAVAILABLE");
    // The KIND is what a caller branches on; the sentence is free to change.
    expect(body.details.kind).toBe("computers-unconfigured");
    expect(body.details.harness).toBe("claude-code");
    // The whole point: no fallback. Nothing resolved a runtime, nothing ran.
    expect(resolveTurnRuntimeMock).not.toHaveBeenCalled();
    expect(runUnifiedAssistantTurnMock).not.toHaveBeenCalled();
  });

  it("refuses a model the harness could never have been paid for", async () => {
    // A brokered harness authenticates with MCPJam's own credential, so a
    // model MCPJam does not host cannot be paid for. Without this the turn
    // would fall through to the emulated engine (which DOES honour org BYOK)
    // and report the harness's name over it.
    const byokModel = "custom:acme:local-llm";
    resolveHostModelDefinitionMock.mockResolvedValue({
      id: byokModel,
      provider: "custom",
    });
    resolveEnvironmentForRuntimeMock.mockResolvedValue(
      environmentSpec({ harness: "claude-code" }),
    );

    const body = await (
      await turn(firstTurn({ environmentId: ENVIRONMENT, modelId: byokModel }))
    ).json();

    expect(body.details.kind).toBe("model-not-hosted");
    expect(runUnifiedAssistantTurnMock).not.toHaveBeenCalled();
  });

  it("refuses a read_only harness turn rather than dropping the narrowing", async () => {
    resolveEnvironmentForRuntimeMock.mockResolvedValue(
      environmentSpec({ harness: "claude-code" }),
    );

    // `toolMode` defaults to read_only, which this route applies by withholding
    // tools from the engine it builds — a harness builds its own, so the policy
    // would evaporate while the response still reported it.
    const response = await turn(
      firstTurn({ environmentId: ENVIRONMENT, toolMode: undefined }),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.details.kind).toBe("surface-tool-policy");
    expect(runUnifiedAssistantTurnMock).not.toHaveBeenCalled();
  });

  it("leaves an EMULATED read_only turn alone", async () => {
    resolveEnvironmentForRuntimeMock.mockResolvedValue(environmentSpec({}));

    const response = await turn(
      firstTurn({ environmentId: ENVIRONMENT, toolMode: undefined }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).engine).toBe("emulated");
  });
});

// ── The decision helpers, on their own ──────────────────────────────────────

describe("resolveChatSessionEngine", () => {
  const hostTarget = (runtimeConfig: Record<string, unknown>) => ({
    hostId: HOST,
    runtimeConfig,
    source: "host" as const,
  });
  const base = {
    model: { id: MODEL, provider: "anthropic" },
    hasSelectedMcpServers: true,
    toolPolicy: { toolMode: "auto" as const },
  };

  beforeEach(() => {
    __setHostedCatalogForTests([MODEL]);
  });

  it("is emulated when no host is targeted at all", () => {
    expect(resolveChatSessionEngine(base)).toEqual({
      ok: true,
      engine: { kind: "emulated" },
    });
  });

  it("refuses an approval host: a synchronous turn has nobody to ask", () => {
    const result = resolveChatSessionEngine({
      ...base,
      hostTarget: hostTarget({
        harness: "claude-code",
        requireToolApproval: true,
      }),
    });
    expect(result).toMatchObject({ ok: false, kind: "surface-approval" });
  });

  it("refuses per-turn tool narrowing a harness cannot honour", () => {
    for (const toolPolicy of [
      { toolMode: "read_only" as const },
      { toolMode: "auto" as const, allowedTools: ["search"] },
      { toolMode: "auto" as const, maxToolCalls: 1 },
    ]) {
      expect(
        resolveChatSessionEngine({
          ...base,
          toolPolicy,
          hostTarget: hostTarget({ harness: "claude-code" }),
        }),
      ).toMatchObject({ ok: false, kind: "surface-tool-policy" });
    }
  });

  it("ignores an UNREGISTERED harness id rather than trusting it", () => {
    // Same membership test the execution-context resolver applies: an id no
    // adapter claims is not a harness, and must not reach `getHarnessAdapter`.
    expect(
      harnessOfRuntimeConfig({ harness: "totally-made-up" }),
    ).toBeUndefined();
    expect(
      resolveChatSessionEngine({
        ...base,
        hostTarget: hostTarget({ harness: "totally-made-up" }),
      }),
    ).toEqual({ ok: true, engine: { kind: "emulated" } });
  });
});

describe("assertHostPointerAgreement", () => {
  it("passes when no pointer was sent, or when it agrees", () => {
    expect(() =>
      assertHostPointerAgreement({
        environmentHostId: HOST,
        environmentId: ENVIRONMENT,
      }),
    ).not.toThrow();
    expect(() =>
      assertHostPointerAgreement({
        requestedHostId: HOST,
        environmentHostId: HOST,
        environmentId: ENVIRONMENT,
      }),
    ).not.toThrow();
  });

  it("throws on a contradiction instead of picking a winner", () => {
    expect(() =>
      assertHostPointerAgreement({
        requestedHostId: "host_a",
        environmentHostId: "host_b",
        environmentId: ENVIRONMENT,
      }),
    ).toThrow(/contradicts environment/);
  });
});

describe("assertHarnessDispatchable", () => {
  it("refuses a harness that resolved to a LOCAL runtime", () => {
    // `runAssistantTurn` would log-and-degrade to the emulated engine here, and
    // a direct runtime drops `harness` entirely — either way the turn would
    // answer 200 for a runtime that never ran.
    expect(() =>
      assertHarnessDispatchable({
        engine: { kind: "harness", harness: "claude-code", hostId: HOST },
        runtimeKind: "direct",
      }),
    ).toThrow(/refused rather than run on the emulated engine/);
  });

  it("is a no-op for a hosted harness and for an emulated turn", () => {
    expect(() =>
      assertHarnessDispatchable({
        engine: { kind: "harness", harness: "claude-code", hostId: HOST },
        runtimeKind: "hosted",
      }),
    ).not.toThrow();
    expect(() =>
      assertHarnessDispatchable({
        engine: { kind: "emulated" },
        runtimeKind: "direct",
      }),
    ).not.toThrow();
  });
});

describe("engineLabel", () => {
  it("distinguishes the engines by name", () => {
    expect(engineLabel({ kind: "emulated" })).toBe("emulated");
    expect(
      engineLabel({ kind: "harness", harness: "codex", hostId: HOST }),
    ).toBe("harness:codex");
  });
});

describe("hostSelectedServerIds", () => {
  const { hostSelectedServerIds } = __testing;

  it("reads the host's own selection", () => {
    expect(hostSelectedServerIds({ selectedServerIds: ["a", "b"] })).toEqual([
      "a",
      "b",
    ]);
  });

  it("reads a malformed list as EMPTY rather than salvaging part of it", () => {
    // A partially-valid list would connect a subset nobody chose. Empty makes
    // the route refuse with a message instead.
    expect(hostSelectedServerIds({ selectedServerIds: ["a", 7] })).toEqual([]);
    expect(hostSelectedServerIds({ selectedServerIds: "a" })).toEqual([]);
    expect(hostSelectedServerIds({})).toEqual([]);
  });
});
