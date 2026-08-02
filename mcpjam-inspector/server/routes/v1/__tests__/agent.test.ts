import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 agent-turn surface: auth/guest gating, schema limits, the
// deployment guard, engine failure → code mapping, the per-org concurrency
// cap, and the tool adapter's project clamp + created-resource collector.

const {
  validateGuestTokenMock,
  getConvexBearerMock,
  prepareChatV2Mock,
  resolveTurnRuntimeMock,
  runUnifiedAssistantTurnMock,
  getSelfFetchMock,
  isHostedCatalogModelMock,
  managerListToolsMock,
  managerDisconnectMock,
} = vi.hoisted(() => {
  process.env.DO_NOT_TRACK = "1"; // analytics no-op in tests
  return {
    validateGuestTokenMock: vi.fn(),
    getConvexBearerMock: vi.fn(),
    prepareChatV2Mock: vi.fn(),
    resolveTurnRuntimeMock: vi.fn(),
    runUnifiedAssistantTurnMock: vi.fn(),
    getSelfFetchMock: vi.fn(),
    isHostedCatalogModelMock: vi.fn(),
    managerListToolsMock: vi.fn(),
    managerDisconnectMock: vi.fn(),
  };
});

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: getConvexBearerMock,
}));

vi.mock("../../../utils/chat-v2-orchestration.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-v2-orchestration.js")
  >("../../../utils/chat-v2-orchestration.js");
  return { ...actual, prepareChatV2: prepareChatV2Mock };
});

vi.mock("../../../utils/resolve-turn-runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/resolve-turn-runtime.js")
  >("../../../utils/resolve-turn-runtime.js");
  return { ...actual, resolveTurnRuntime: resolveTurnRuntimeMock };
});

vi.mock("../../../utils/turn-execution.js", () => ({
  runUnifiedAssistantTurn: runUnifiedAssistantTurnMock,
}));

vi.mock("../../../utils/self-app.js", () => ({
  getSelfFetch: getSelfFetchMock,
}));

vi.mock("../../../services/hosted-model-catalog.js", () => ({
  isHostedCatalogModel: isHostedCatalogModelMock,
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    MCPClientManager: vi.fn().mockImplementation(() => ({
      listTools: managerListToolsMock,
      disconnectAllServers: managerDisconnectMock,
      hasServer: () => false,
      getToolsForAiSdk: async () => ({}),
    })),
  };
});

import v1Routes from "../index.js";
import {
  AGENT_API_OPERATIONS,
  buildAgentApiToolSet,
  type CreatedResource,
} from "../agent.js";
import { isMcpjamToolId } from "../../../utils/built-in-tools/mcpjam.js";
import {
  createEvalSuiteOperation,
  getEvalRunOperation,
  listProjectServersOperation,
  runEvalSuiteOperation,
  generateEvalCasesOperation,
  type PlatformApiClient,
} from "@mcpjam/sdk/platform";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function turnRequest(
  app: Hono,
  body: unknown,
  token = "tok"
): Promise<Response> {
  return Promise.resolve(
    app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
  );
}

const OK_BODY = { messages: [{ role: "user", content: "hello" }] };

function okTurnResult(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    newMessages: [],
    assistantMessages: [
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
    toolCalls: [{ toolCallId: "t1", toolName: "list_eval_suites", input: {} }],
    toolResults: [],
    turnTrace: { turnId: "turn_1" },
    usage: { inputTokens: 5, outputTokens: 2 },
    aborted: false,
    ...overrides,
  };
}

describe("POST /api/v1/projects/:projectId/agent", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "http://convex.test";
    process.env.INSPECTOR_SERVICE_TOKEN = "svc";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    getConvexBearerMock.mockResolvedValue("delegated-jwt");
    getSelfFetchMock.mockReturnValue(async () => new Response("{}"));
    isHostedCatalogModelMock.mockReturnValue(true);
    managerListToolsMock.mockRejectedValue(new Error("docs down"));
    managerDisconnectMock.mockResolvedValue(undefined);
    prepareChatV2Mock.mockImplementation(async (opts: any) => ({
      allTools: opts.builtInTools ?? {},
      enhancedSystemPrompt: opts.systemPrompt,
    }));
    resolveTurnRuntimeMock.mockResolvedValue({
      runtime: { kind: "hosted", endpointPath: "/stream" },
      modelSource: "mcpjam",
      finalizeUsage: async () => undefined,
      classifyFailure: (message: string) =>
        /rate.?limit|spend|\bquota\b|\bcap\b/i.test(message)
          ? "rate_limited"
          : "failed",
    });
    runUnifiedAssistantTurnMock.mockResolvedValue(okTurnResult());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires a bearer token", async () => {
    const app = makeApp();
    const res = await app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(OK_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("denies guests (default-deny, no allowlist entry)", async () => {
    validateGuestTokenMock.mockResolvedValue({
      valid: true,
      guestId: "guest_abc",
    });
    const res = await turnRequest(makeApp(), OK_BODY);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("rejects an empty message list", async () => {
    const res = await turnRequest(makeApp(), { messages: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects oversized messages", async () => {
    const res = await turnRequest(makeApp(), {
      messages: [{ role: "user", content: "x".repeat(8_001) }],
    });
    expect(res.status).toBe(400);
  });

  it("returns FEATURE_NOT_SUPPORTED without hosted backend wiring", async () => {
    delete process.env.CONVEX_HTTP_URL;
    const res = await turnRequest(makeApp(), OK_BODY);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("FEATURE_NOT_SUPPORTED");
  });

  it("runs a turn and returns reply + toolCalls + usage", async () => {
    const res = await turnRequest(makeApp(), OK_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.reply).toBe("done");
    expect(body.toolCalls).toEqual([{ operation: "list_eval_suites" }]);
    expect(body.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(body.createdResources).toEqual([]);
    // Engine got the delegated JWT, never the caller's raw key.
    const engineOpts = runUnifiedAssistantTurnMock.mock.calls[0]![0];
    expect(engineOpts.authContext).toEqual({
      kind: "user_bearer",
      token: "Bearer delegated-jwt",
    });
    expect(engineOpts.projectId).toBe("p1");
    expect(engineOpts.streamSink).toBe("none");
    expect(engineOpts.approvalMode).toBe("auto-deny");
  });

  it("degrades when the docs server is down (turn still runs)", async () => {
    const res = await turnRequest(makeApp(), OK_BODY);
    expect(res.status).toBe(200);
    const prepareOpts = prepareChatV2Mock.mock.calls[0]![0];
    expect(prepareOpts.selectedServers).toEqual([]);
    expect(prepareOpts.skillsSource).toEqual({ kind: "none" });
  });

  it("selects the docs server when the preflight succeeds", async () => {
    managerListToolsMock.mockResolvedValue({ tools: [] });
    const res = await turnRequest(makeApp(), OK_BODY);
    expect(res.status).toBe(200);
    const prepareOpts = prepareChatV2Mock.mock.calls[0]![0];
    expect(prepareOpts.selectedServers).toEqual(["mcpjam-docs"]);
  });

  it("degrades when the docs preflight hangs (bounded, not stacked on the turn)", async () => {
    // Never settles — the 5s preflight deadline must fire, not the 30s
    // docs client timeout. Fake timers make that instant.
    vi.useFakeTimers();
    try {
      managerListToolsMock.mockImplementation(() => new Promise(() => {}));
      const pending = turnRequest(makeApp(), OK_BODY);
      await vi.advanceTimersByTimeAsync(6_000);
      const res = await pending;
      expect(res.status).toBe(200);
      const prepareOpts = prepareChatV2Mock.mock.calls[0]![0];
      expect(prepareOpts.selectedServers).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the aggregate history byte budget", async () => {
    // 20 messages × 7,000 ASCII bytes = 140,000 bytes: every message passes
    // the per-message caps, the total must still fail the 96 KB budget.
    const res = await turnRequest(makeApp(), {
      messages: Array.from({ length: 20 }, () => ({
        role: "user",
        content: "x".repeat(7_000),
      })),
    });
    expect(res.status).toBe(400);
  });

  it("aborts the turn when the caller disconnects", async () => {
    let sawAbort = false;
    runUnifiedAssistantTurnMock.mockImplementation(async (opts: any) => {
      opts.abortSignal?.addEventListener("abort", () => {
        sawAbort = true;
      });
      requestAbort.abort(); // caller hangs up mid-turn
      await new Promise((resolve) => setTimeout(resolve, 5));
      return okTurnResult();
    });
    const requestAbort = new AbortController();
    const app = makeApp();
    const res = await app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      body: JSON.stringify(OK_BODY),
      signal: requestAbort.signal,
    });
    expect(sawAbort).toBe(true);
    // The aborted branch responds TIMEOUT; nobody is listening anyway.
    expect(res.status).toBe(504);
  });

  it("enforces the byte cap on multibyte content", async () => {
    // 5,000 chars × 2 bytes = 10,000 bytes: passes the char cap, must
    // still fail the byte cap.
    const res = await turnRequest(makeApp(), {
      messages: [{ role: "user", content: "é".repeat(5_000) }],
    });
    expect(res.status).toBe(400);
  });

  it("surfaces already-created resources on a failed turn", async () => {
    const executeSpy = vi
      .spyOn(createEvalSuiteOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1" },
        suite: { id: "ts_9", name: "smoke" },
        servers: [],
      } as never);
    // The engine "runs" the create tool, then dies without a turn trace —
    // the suite is persisted, so the 500 must still reference it.
    runUnifiedAssistantTurnMock.mockImplementation(async (opts: any) => {
      await opts.tools[createEvalSuiteOperation.name].execute(
        { name: "smoke", servers: ["srv"], model: "m", cases: [] },
        {}
      );
      return okTurnResult({ turnTrace: undefined });
    });
    try {
      const res = await turnRequest(makeApp(), OK_BODY);
      expect(res.status).toBe(500);
      const body = (await res.json()) as {
        details?: { createdResources?: Array<{ id: string }> };
      };
      expect(body.details?.createdResources?.[0]?.id).toBe("ts_9");
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("maps engine spend-cap failures to RATE_LIMITED", async () => {
    runUnifiedAssistantTurnMock.mockImplementation(async (opts: any) => {
      opts.onEngineError?.({
        message: "Daily spend cap exceeded",
        httpStatus: 429,
      });
      return okTurnResult({ turnTrace: undefined });
    });
    const res = await turnRequest(makeApp(), OK_BODY);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("maps other engine failures to INTERNAL_ERROR", async () => {
    runUnifiedAssistantTurnMock.mockResolvedValue(
      okTurnResult({ turnTrace: undefined })
    );
    const res = await turnRequest(makeApp(), OK_BODY);
    expect(res.status).toBe(500);
  });

  it("caps concurrent turns per organization", async () => {
    const gate: Array<() => void> = [];
    runUnifiedAssistantTurnMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.push(() => resolve(okTurnResult()));
        })
    );
    const app = makeApp();
    const inflight = [1, 2, 3, 4].map(() => turnRequest(app, OK_BODY));
    // Let the four turns reach the engine before the fifth arrives.
    await vi.waitFor(() => {
      expect(gate.length).toBe(4);
    });
    const fifth = await turnRequest(app, OK_BODY);
    expect(fifth.status).toBe(429);
    gate.forEach((release) => release());
    const results = await Promise.all(inflight);
    for (const res of results) expect(res.status).toBe(200);
  });
});

describe("agent tool surface", () => {
  it("keeps spend ops out of the op list and the in-app gate unchanged", () => {
    const names = AGENT_API_OPERATIONS.map((op) => op.name);
    expect(names).toContain(createEvalSuiteOperation.name);
    expect(names).not.toContain(runEvalSuiteOperation.name);
    expect(names).not.toContain(generateEvalCasesOperation.name);
    expect(names).not.toContain("cancel_eval_run");
    // The in-app built-in gate must NOT widen to the create op.
    expect(isMcpjamToolId(createEvalSuiteOperation.name)).toBe(false);
  });

  it("clamps every operation to the route's project", async () => {
    const executeSpy = vi
      .spyOn(listProjectServersOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1", name: "P1" },
        items: [],
        otherProjects: [],
      } as never);
    const created: CreatedResource[] = [];
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created,
    });
    const tool = tools[listProjectServersOperation.name]! as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };

    // Explicit foreign project → rejected without touching the client.
    const denied = await tool.execute({ project: "p2" }, {});
    expect(denied).toMatchObject({ error: expect.stringContaining("scoped") });
    expect(executeSpy).not.toHaveBeenCalled();

    // Omitted project → clamped in.
    await tool.execute({}, {});
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ project: "p1" }),
      expect.anything()
    );
    executeSpy.mockRestore();
  });

  it("advertises `project` as optional even when the op requires it", () => {
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created: [],
    });
    const schema = (tools[getEvalRunOperation.name] as { inputSchema: any })
      .inputSchema;
    // The op's own schema REQUIRES project; the advertised one must not —
    // the prompt tells the model to omit it and the clamp fills it in.
    expect(schema.safeParse({ runId: "run_1" }).success).toBe(true);
  });

  it("strips otherProjects switching metadata from results", async () => {
    const executeSpy = vi
      .spyOn(listProjectServersOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1", name: "P1" },
        otherProjects: [{ id: "p2", name: "Secret Project" }],
        items: [],
      } as never);
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created: [],
    });
    const tool = tools[listProjectServersOperation.name]! as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute({}, {})) as Record<string, unknown>;
    expect(result.otherProjects).toBeUndefined();
    expect(result.items).toEqual([]);
    executeSpy.mockRestore();
  });

  it("collects created suites from raw op results (pre-truncation)", async () => {
    const bigDescription = "x".repeat(30_000); // would trip the model cap
    const executeSpy = vi
      .spyOn(createEvalSuiteOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1" },
        suite: { id: "ts_1", name: "smoke", description: bigDescription },
        servers: [],
      } as never);
    const created: CreatedResource[] = [];
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created,
    });
    const tool = tools[createEvalSuiteOperation.name]! as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute(
      { name: "smoke", servers: ["srv"], model: "m", cases: [] },
      {}
    )) as Record<string, unknown>;
    expect(created).toEqual([
      {
        type: "eval_suite",
        id: "ts_1",
        name: "smoke",
        url: expect.stringContaining("/evals/suite/ts_1"),
      },
    ]);
    // The model-facing result may be truncated; the collector must not be.
    expect(result.truncated).toBe(true);
    executeSpy.mockRestore();
  });
});
