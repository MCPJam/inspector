import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 agent-turn surface: auth/guest gating, schema limits, the
// deployment guard, engine failure → code mapping, the per-org concurrency
// cap, the tool adapter's project clamp + created-resource collector, and the
// GATED proposal tier (validate → persist → return an opaque id, never run).

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
  resolveSlackActingUserMock,
  createProposedActionMock,
  getOrgAgentPolicyMock,
  verifyAuthKitTokenMock,
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
    resolveSlackActingUserMock: vi.fn(),
    createProposedActionMock: vi.fn(),
    getOrgAgentPolicyMock: vi.fn(),
    verifyAuthKitTokenMock: vi.fn(),
  };
});

// `GET /agent-ops` mounts `requireVerifiedAuth` — it never calls Convex, so
// nothing downstream would re-check the bearer. Tokens here are placeholder
// strings; the middleware's own branches are covered in
// server/middleware/__tests__/require-verified-auth.test.ts.
vi.mock("../../../services/authkit-jwt.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAuthKitToken: verifyAuthKitTokenMock,
}));

vi.mock("../../../services/slack-backend.js", () => ({
  resolveSlackActingUser: resolveSlackActingUserMock,
  createProposedAction: createProposedActionMock,
  getProposedAction: vi.fn(),
  beginProposedAction: vi.fn(),
  completeProposedAction: vi.fn(),
  releaseProposedAction: vi.fn(),
  getOrgAgentPolicy: getOrgAgentPolicyMock,
  // Carries `status`, which is what `isRouteMissing` reads. A bare Error
  // subclass would make the 404-as-empty-policy branch untestable here.
  SlackBackendUnavailable: class SlackBackendUnavailable extends Error {
    readonly status?: number;
    constructor(message: string, options?: { status?: number }) {
      super(message);
      if (options?.status !== undefined) this.status = options.status;
    }
  },
}));

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
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
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
import { clearOrgAgentPolicyCache } from "../../../utils/org-agent-policy.js";
import {
  AGENT_API_GATED_OPERATIONS,
  AGENT_API_OPERATIONS,
  buildAgentApiToolSet,
  type CreatedResource,
} from "../agent.js";
import { isMcpjamToolId } from "../../../utils/built-in-tools/mcpjam.js";
import { resetSlackRateLimitForTests } from "../../../middleware/slack-service-auth.js";
import {
  callServerToolOperation,
  cancelEvalRunOperation,
  createEvalSuiteOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  installRegistryDirectoryServerOperation,
  listProjectServersOperation,
  runEvalSuiteOperation,
  generateEvalCasesOperation,
  setEvalSuiteScheduleOperation,
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

// Schema-valid create input (the adapter pre-validates against the op's
// real schema before executing).
const VALID_CREATE_INPUT = {
  name: "smoke",
  servers: ["srv"],
  model: "anthropic/claude-haiku-4.5",
  cases: [
    {
      title: "t1",
      steps: [
        { id: "s1", kind: "prompt", prompt: "hello" },
        {
          id: "s2",
          kind: "assert",
          assertion: { type: "toolCalledAtLeastOnce", toolName: "echo" },
        },
      ],
    },
  ],
};

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
    // Process-global, 60 s TTL: a case that left an entry behind would
    // silently decide the next one's tool surface.
    clearOrgAgentPolicyCache();
    getOrgAgentPolicyMock.mockResolvedValue({ disabledOperations: [] });
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
        VALID_CREATE_INPUT,
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

  it("maps spend-precheck denial (200 OK + user_rate_limit code) to RATE_LIMITED (issue #3708)", async () => {
    // Issue #3708: /stream returns 200 OK with application/json when the
    // spend-precheck denies the call. The engine fires onEngineError with
    // httpStatus:200 and code:"user_rate_limit" — but the turn still
    // completes with a turnTrace (the per-step error exits the loop, the
    // safety epilogue runs, and onConversationComplete captures the trace).
    // The route must map this to RATE_LIMITED — not silently return an
    // empty-reply 200 envelope.
    //
    // Deliberately: turnTrace PRESENT (that's the bug — the old
    // `!result.turnTrace` check alone never fired) and a message that
    // classifyFailure's regex canNOT catch, so this test only passes if the
    // route branches on `lastEngineError` and its `code`.
    runUnifiedAssistantTurnMock.mockImplementation(async (opts: any) => {
      opts.onEngineError?.({
        message: "denied by precheck",
        code: "user_rate_limit",
        httpStatus: 200,
      });
      return okTurnResult();
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

  it("hands the model permalinks alongside a read's rows", async () => {
    // The system prompt tells the model to pass back a `permalinks` url
    // verbatim. This surface returned the raw result, so on the hosted agent
    // that rule named a field nothing produced and the model was left with
    // bare ids — which is how it came to invent app URLs in the first place.
    const executeSpy = vi
      .spyOn(listProjectServersOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1", name: "P1" },
        items: [
          { id: "srv_1", name: "Asana", projectId: "p1" },
          { id: "srv_2", name: "Linear", projectId: "p1" },
        ],
        otherProjects: [],
      } as never);
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created: [],
    });
    const tool = tools[listProjectServersOperation.name]! as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };

    const result = (await tool.execute({}, {})) as {
      permalinks?: Array<{ url: string; resource: { id: string } }>;
    };
    expect(result.permalinks?.map((permalink) => permalink.url)).toEqual([
      expect.stringContaining("/servers/srv_1?project=p1"),
      expect.stringContaining("/servers/srv_2?project=p1"),
    ]);
    executeSpy.mockRestore();
  });

  it("keeps the permalinks when the payload is truncated for the model", async () => {
    // The case they matter MOST in. `capForModel` replaces an over-cap value
    // wholesale with `{truncated, preview}`, so a permalink folded inside the
    // payload disappeared on exactly the long listings where the link is the
    // only thing the model can still act on.
    const executeSpy = vi
      .spyOn(listProjectServersOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1", name: "P1" },
        items: [
          {
            id: "srv_1",
            name: "Asana",
            projectId: "p1",
            // Comfortably past the 24k model-output cap on its own.
            notes: "x".repeat(30_000),
          },
        ],
        otherProjects: [],
      } as never);
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created: [],
    });
    const tool = tools[listProjectServersOperation.name]! as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };

    const result = (await tool.execute({}, {})) as {
      truncated?: boolean;
      permalinks?: Array<{ url: string }>;
    };
    expect(result.truncated).toBe(true);
    expect(result.permalinks?.[0]?.url).toContain("/servers/srv_1?project=p1");
    executeSpy.mockRestore();
  });

  it("leaves the result alone when nothing is addressable", async () => {
    // An empty listing has no resource to open. The envelope must not appear
    // as an empty array either: `permalinks: []` reads to the model as "this
    // surface offers links and there are none for you", which is a different
    // claim from a result that never carried links at all.
    const executeSpy = vi
      .spyOn(listProjectServersOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1", name: "P1" },
        items: [],
        otherProjects: [],
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
    expect(result).not.toHaveProperty("permalinks");
    expect(result.items).toEqual([]);
    executeSpy.mockRestore();
  });

  it("links the rows it can address and drops the ones it cannot", async () => {
    // Each ref is built independently. One row missing the id the route needs
    // must cost that row its link and nothing more — the failure mode worth
    // guarding is the one where a single bad row silently strips the links off
    // every row beside it.
    const executeSpy = vi
      .spyOn(listProjectServersOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1", name: "P1" },
        items: [
          { id: "", name: "Unaddressable", projectId: "p1" },
          { id: "srv_2", name: "Linear", projectId: "p1" },
        ],
        otherProjects: [],
      } as never);
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created: [],
    });
    const tool = tools[listProjectServersOperation.name]! as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };

    const result = (await tool.execute({}, {})) as {
      permalinks?: Array<{ url: string }>;
    };
    expect(result.permalinks?.map((permalink) => permalink.url)).toEqual([
      expect.stringContaining("/servers/srv_2?project=p1"),
    ]);
    executeSpy.mockRestore();
  });

  it("does not report an idempotent re-create as something the turn created", async () => {
    // `createdResourcesFrom` keys on a NAME PREFIX so the catalog's new
    // creates are adopted without editing that file. The cost of that rule is
    // that an idempotent create — one that succeeds by returning the row that
    // already existed, saying so with `created: false` — would be reported
    // under a heading that reads "created", which is the same lie the function
    // already refuses to tell about an edit.
    //
    // `publish_scenario` is the operation the flag was written for and it is
    // excluded from this surface entirely (who may talk to your servers is a
    // human call), so this drives the guard through a create-prefixed op that
    // IS on the surface. The model still sees the permalink either way; only
    // the host's created-resource block is withheld.
    const executeSpy = vi
      .spyOn(createEvalSuiteOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1" },
        suite: { id: "ts_1", name: "smoke", created: false },
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

    const result = (await tool.execute(VALID_CREATE_INPUT, {})) as {
      permalinks?: Array<{ url: string }>;
    };
    expect(created).toEqual([]);
    expect(result.permalinks?.[0]?.url).toContain("/evals/suite/ts_1");
    executeSpy.mockRestore();
  });

  it("still returns the read when the permalink policy cannot read it", async () => {
    // A policy reads a shape (`result.items.map`). A null result throws inside
    // it. Deriving a link is a convenience on top of the read; it must never
    // be what turns a successful read into a failed tool call.
    const executeSpy = vi
      .spyOn(listProjectServersOperation, "execute")
      .mockResolvedValue(null as never);
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created: [],
    });
    const tool = tools[listProjectServersOperation.name]! as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };

    await expect(tool.execute({}, {})).resolves.toBeNull();
    executeSpy.mockRestore();
  });

  it("returns field-addressed validation errors (not a bare 'Invalid input')", async () => {
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created: [],
    });
    const tool = tools[createEvalSuiteOperation.name]! as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };
    // Missing model + cases entirely — the model must learn WHICH fields.
    const result = (await tool.execute({ name: "x" }, {})) as {
      error?: string;
    };
    expect(result.error).toContain("fix these fields");
    expect(result.error).toMatch(/model|cases|servers/);
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

  it("clamps the trace read, whose op REQUIRES project, to the route's project", async () => {
    // `get_eval_iteration_trace` makes `project` mandatory in its own schema.
    // The advertised schema relaxes it (the prompt says to omit it) and the
    // clamp fills it in — if either half were missing, the model would be
    // told a field is required that it is also told never to send.
    const executeSpy = vi
      .spyOn(getEvalIterationTraceOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1" },
        runId: "run_1",
        iterationId: "it_1",
        trace: {},
      } as never);
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created: [],
    });
    const tool = tools[getEvalIterationTraceOperation.name]! as {
      inputSchema: any;
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };
    expect(
      tool.inputSchema.safeParse({ runId: "run_1", iterationId: "it_1" })
        .success
    ).toBe(true);
    await tool.execute({ runId: "run_1", iterationId: "it_1" }, {});
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ project: "p1" }),
      expect.anything()
    );

    const denied = (await tool.execute(
      { runId: "run_1", iterationId: "it_1", project: "p2" },
      {}
    )) as { error?: string };
    expect(denied.error).toMatch(/scoped/);
    executeSpy.mockRestore();
  });

  it("caps a large trace for the model without failing the read", async () => {
    // A full trace is the whole message history. The cap is what keeps one
    // read from crowding the rest of the turn out of the context window.
    const executeSpy = vi
      .spyOn(getEvalIterationTraceOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1" },
        runId: "run_1",
        iterationId: "it_1",
        trace: { messages: "x".repeat(200_000) },
      } as never);
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created: [],
    });
    const tool = tools[getEvalIterationTraceOperation.name]! as {
      execute: (input: unknown, ctx: unknown) => Promise<unknown>;
    };
    const result = (await tool.execute(
      { runId: "run_1", iterationId: "it_1" },
      {}
    )) as Record<string, unknown>;
    expect(result.truncated).toBe(true);
    executeSpy.mockRestore();
  });

  it("offers the new read tools with the project clamp applied", async () => {
    const tools = buildAgentApiToolSet({
      client: {} as PlatformApiClient,
      projectId: "p1",
      created: [],
    });
    for (const name of [
      "diagnose_server",
      "list_server_prompts",
      "list_server_resources",
      "get_server_prompt",
      "read_server_resource",
      "get_eval_iteration_trace",
      "get_project_environment",
    ]) {
      expect(tools[name], name).toBeDefined();
    }
    // The one deliberately left out: minutes of serial paging cannot fit a
    // 90-second synchronous turn.
    expect(tools.check_host_compatibility).toBeUndefined();
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
    const result = (await tool.execute(VALID_CREATE_INPUT, {})) as Record<
      string,
      unknown
    >;
    expect(created).toEqual([
      {
        type: "eval_suite",
        id: "ts_1",
        name: "smoke",
        // `?project=` makes the link land on the right project for viewers
        // parked elsewhere (eval routes carry no project segment).
        url: expect.stringContaining("/evals/suite/ts_1?project=p1"),
      },
    ]);
    // The model-facing result may be truncated; the collector must not be.
    expect(result.truncated).toBe(true);
    executeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// GATED proposal tools — the tier that cannot execute.
//
// The gated tools are only built when the turn has a surface that can render an
// approval button AND an org to attribute the spend to. These tests drive them
// through the real route (with `slk_` service auth) rather than a direct
// factory call, so the surface-context resolution is covered too — that is the
// seam the surface abstraction is about to move.
// ---------------------------------------------------------------------------

const SLACK_TOKEN = "slk_agent_gated_tools_test_token_0123456789";
const SLACK_TOKEN_HASH = createHash("sha256").update(SLACK_TOKEN).digest("hex");

type GatedTool = {
  description: string;
  inputSchema: { safeParse: (value: unknown) => { success: boolean } };
  execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>>;
};

/** Run a turn as a linked Slack user and hand back the tools it was given. */
async function toolsForSlackTurn(
  body: Record<string, unknown> = {}
): Promise<Record<string, GatedTool>> {
  const app = makeApp();
  const res = await app.request("/api/v1/projects/p1/agent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_TOKEN}`,
      "x-mcpjam-slack-team-id": "T1",
      "x-mcpjam-slack-user-id": "U1",
    },
    body: JSON.stringify({ ...OK_BODY, ...body }),
  });
  expect(res.status).toBe(200);
  const call = prepareChatV2Mock.mock.calls.at(-1)?.[0] as {
    builtInTools: Record<string, GatedTool>;
  };
  return call.builtInTools;
}

describe("gated proposal tools", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "http://convex.test";
    process.env.INSPECTOR_SERVICE_TOKEN = "svc";
    process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH = SLACK_TOKEN_HASH;
    resetSlackRateLimitForTests();
    clearOrgAgentPolicyCache();
    getOrgAgentPolicyMock.mockResolvedValue({ disabledOperations: [] });
    resolveSlackActingUserMock.mockResolvedValue({
      userId: "user_1",
      workosUserId: "workos|alice",
      organizationId: "org_1",
      defaultProjectId: null,
    });
    createProposedActionMock.mockResolvedValue({ created: true });
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
      classifyFailure: () => "failed",
    });
    runUnifiedAssistantTurnMock.mockResolvedValue(okTurnResult());
  });

  afterEach(() => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH;
    vi.clearAllMocks();
  });

  it("offers a gated tool per spend op ONLY when a surface is present", async () => {
    const withSurface = await toolsForSlackTurn({ slackChannelId: "C1" });
    for (const operation of AGENT_API_GATED_OPERATIONS) {
      expect(withSurface[operation.name]).toBeDefined();
    }

    // No channel ⇒ nowhere to render a button. The tools are OMITTED rather
    // than offered and then refused, so the model never plans around an action
    // it cannot take.
    const withoutSurface = await toolsForSlackTurn();
    for (const operation of AGENT_API_GATED_OPERATIONS) {
      expect(withoutSurface[operation.name]).toBeUndefined();
    }
  });

  it("tells the model in the tool description that calling it does not run it", async () => {
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    const description = tools[runEvalSuiteOperation.name]!.description;
    expect(description).toMatch(/REQUIRES HUMAN APPROVAL/);
    expect(description).toMatch(/never that it has run or started/i);
  });

  it("persists the VALIDATED, project-clamped input and returns only an id", async () => {
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    const result = await tools[runEvalSuiteOperation.name]!.execute(
      { suite: "smoke" },
      {}
    );
    expect(createProposedActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: runEvalSuiteOperation.name,
        input: expect.objectContaining({ suite: "smoke", project: "p1" }),
        // The SURFACE quad, resolved from the canonical auth-context vars —
        // the Slack auth branch is what filled them in, and a second wrapper
        // would fill in the same three names.
        surface: "slack",
        surfaceTenantId: "T1",
        surfaceConversationId: "C1",
        surfaceActorId: "U1",
        organizationId: "org_1",
        projectId: "p1",
      })
    );
    // The model gets an OPAQUE id and an explicit "not started" note — never
    // anything it could use to execute the action itself.
    expect(result).toMatchObject({ proposed: true });
    expect(typeof result.actionId).toBe("string");
    expect(result.note).toMatch(/Awaiting human approval/);
  });

  it("rejects an explicit foreign project without persisting anything", async () => {
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    const result = await tools[runEvalSuiteOperation.name]!.execute(
      { suite: "smoke", project: "p2" },
      {}
    );
    expect(result.error).toMatch(/scoped to a single project/);
    expect(createProposedActionMock).not.toHaveBeenCalled();
  });

  it("returns field-addressed validation errors against the op's REAL schema", async () => {
    // A proposal that would fail at execution time is a proposal that should
    // never have been offered — a human is about to be asked to approve it.
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    const result = await tools[runEvalSuiteOperation.name]!.execute({}, {});
    expect(result.error).toContain("fix these fields");
    expect(result.error).toMatch(/suite/);
    expect(createProposedActionMock).not.toHaveBeenCalled();
  });

  it("collapses a repeated identical proposal onto ONE action id and ONE entry", async () => {
    // Two identical buttons in a thread are two clicks away from being billed
    // twice. The derived id collapses the backend row; the response dedupe
    // collapses the button.
    const app = makeApp();
    let captured: Record<string, GatedTool> | undefined;
    prepareChatV2Mock.mockImplementation(async (opts: any) => {
      captured = opts.builtInTools;
      return {
        allTools: opts.builtInTools ?? {},
        enhancedSystemPrompt: opts.systemPrompt,
      };
    });
    runUnifiedAssistantTurnMock.mockImplementation(async () => {
      const tool = captured![runEvalSuiteOperation.name]!;
      await tool.execute({ suite: "smoke" }, {});
      await tool.execute({ suite: "smoke" }, {});
      return okTurnResult();
    });

    const res = await app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "x-mcpjam-slack-team-id": "T1",
        "x-mcpjam-slack-user-id": "U1",
      },
      body: JSON.stringify({
        ...OK_BODY,
        slackChannelId: "C1",
        idempotencyKey: "T1:Ev1",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposedActions: Array<{ actionId: string; operation: string }>;
    };
    expect(body.proposedActions).toHaveLength(1);
    const ids = createProposedActionMock.mock.calls.map(
      (call) => (call[0] as { actionId: string }).actionId
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("returns a retryable tool error when the proposal cannot be persisted", async () => {
    createProposedActionMock.mockRejectedValue(new Error("backend down"));
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    const result = await tools[runEvalSuiteOperation.name]!.execute(
      { suite: "smoke" },
      {}
    );
    // Not "proposed": the model must not tell the user a button exists.
    expect(result.proposed).toBeUndefined();
    expect(result.error).toMatch(/Try again in a moment/);
  });

  it("REFUSES to mint an install proposal the freeze could not pin", async () => {
    // The default self-fetch answers `{}`: the mint-time directory lookup
    // resolves a row with no endpoint and no content hash, so the freeze has
    // nothing to pin. The tool must refuse rather than persist — an unpinned
    // install proposal is exactly the TOCTOU hole the pin exists to close: an
    // approver shown "install cs_1" with no endpoint, and a click that
    // installs whatever the row resolves to an hour later.
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    const result = await tools[
      installRegistryDirectoryServerOperation.name
    ]!.execute({ catalogServerId: "cs_1" }, {});
    expect(result.proposed).toBeUndefined();
    expect(result.error).toMatch(/Could not pin/);
    expect(createProposedActionMock).not.toHaveBeenCalled();
  });

  it("persists an install proposal WITH its pins when the row resolves", async () => {
    getSelfFetchMock.mockReturnValue(async (request: Request) => {
      const { pathname } = new URL(request.url);
      if (pathname.includes("/registry/directory-servers/")) {
        return new Response(
          JSON.stringify({
            id: "cs_1",
            source: "claude",
            serverName: "linear",
            remoteUrl: "https://mcp.linear.app/mcp",
            latestContentHash: "hash_now",
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}");
    });
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    const result = await tools[
      installRegistryDirectoryServerOperation.name
    ]!.execute({ catalogServerId: "cs_1" }, {});
    expect(result).toMatchObject({ proposed: true });
    // The FROZEN description — the endpoint host the approval control shows.
    expect(result.description).toBe(
      "Install directory server cs_1 at mcp.linear.app"
    );
    expect(createProposedActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: installRegistryDirectoryServerOperation.name,
        input: expect.objectContaining({
          endpointUrl: "https://mcp.linear.app/mcp",
          expectedContentHash: "hash_now",
        }),
      })
    );
  });

  it("does not persist a proposal for an aborted turn", async () => {
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    const result = await tools[runEvalSuiteOperation.name]!.execute(
      { suite: "smoke" },
      { abortSignal: { aborted: true } }
    );
    expect(result.error).toMatch(/cancelled/i);
    expect(createProposedActionMock).not.toHaveBeenCalled();
  });

  it("surfaces proposals in the envelope with a description a human can read", async () => {
    const app = makeApp();
    let captured: Record<string, GatedTool> | undefined;
    prepareChatV2Mock.mockImplementation(async (opts: any) => {
      captured = opts.builtInTools;
      return {
        allTools: opts.builtInTools ?? {},
        enhancedSystemPrompt: opts.systemPrompt,
      };
    });
    runUnifiedAssistantTurnMock.mockImplementation(async () => {
      await captured![cancelEvalRunOperation.name]!.execute(
        { runId: "run_1" },
        {}
      );
      return okTurnResult();
    });

    const res = await app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "x-mcpjam-slack-team-id": "T1",
        "x-mcpjam-slack-user-id": "U1",
      },
      body: JSON.stringify({ ...OK_BODY, slackChannelId: "C1" }),
    });
    const body = (await res.json()) as {
      proposedActions: Array<Record<string, unknown>>;
    };
    expect(body.proposedActions).toHaveLength(1);
    expect(body.proposedActions[0]).toMatchObject({
      operation: cancelEvalRunOperation.name,
      description: "Cancel run run_1",
      // Rendering metadata travels with the proposal so a host words the
      // button and the announcement from what the server decided.
      buttonLabel: "Cancel the run",
      kind: "cancel",
    });
    // The PERSISTED input never leaves the server: a host that received it
    // might send it back, and then the click would be saying what it does.
    expect(body.proposedActions[0]).not.toHaveProperty("input");
  });

  it("accepts `conversationId`, and keeps `slackChannelId` working forever", async () => {
    // The bot is a separately deployed service, so at any moment one version
    // sends one name and another sends the other. Both must work; neither is
    // on a deprecation clock.
    const viaGeneric = await toolsForSlackTurn({ conversationId: "C_NEW" });
    expect(viaGeneric[runEvalSuiteOperation.name]).toBeDefined();
    await viaGeneric[runEvalSuiteOperation.name]!.execute(
      { suite: "smoke" },
      {}
    );
    expect(createProposedActionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ surfaceConversationId: "C_NEW" })
    );

    const viaLegacy = await toolsForSlackTurn({ slackChannelId: "C_OLD" });
    await viaLegacy[runEvalSuiteOperation.name]!.execute(
      { suite: "smoke" },
      {}
    );
    expect(createProposedActionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ surfaceConversationId: "C_OLD" })
    );
  });

  it("prefers `conversationId` when a caller sends both", async () => {
    const tools = await toolsForSlackTurn({
      conversationId: "C_NEW",
      slackChannelId: "C_OLD",
    });
    await tools[runEvalSuiteOperation.name]!.execute({ suite: "smoke" }, {});
    expect(createProposedActionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ surfaceConversationId: "C_NEW" })
    );
  });

  it("offers to RUN a suite the turn created, as an ordinary proposal", async () => {
    // Retires the legacy Run-it button, which was wired straight to
    // POST /eval-runs and shared none of the proposal path's properties.
    const app = makeApp();
    const executeSpy = vi
      .spyOn(createEvalSuiteOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1" },
        suite: { id: "ts_1", name: "smoke" },
        servers: [],
      } as never);
    let captured: Record<string, GatedTool> | undefined;
    prepareChatV2Mock.mockImplementation(async (opts: any) => {
      captured = opts.builtInTools;
      return {
        allTools: opts.builtInTools ?? {},
        enhancedSystemPrompt: opts.systemPrompt,
      };
    });
    runUnifiedAssistantTurnMock.mockImplementation(async () => {
      await captured![createEvalSuiteOperation.name]!.execute(
        VALID_CREATE_INPUT,
        {}
      );
      return okTurnResult();
    });

    const res = await app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "x-mcpjam-slack-team-id": "T1",
        "x-mcpjam-slack-user-id": "U1",
      },
      body: JSON.stringify({ ...OK_BODY, conversationId: "C1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      createdResources: Array<{ id: string }>;
      proposedActions: Array<Record<string, unknown>>;
    };
    expect(body.createdResources).toHaveLength(1);
    expect(body.proposedActions).toHaveLength(1);
    expect(body.proposedActions[0]).toMatchObject({
      operation: runEvalSuiteOperation.name,
      kind: "start",
      buttonLabel: "Run it",
    });
    // The proposal names the suite by ID, not by whatever the model called it.
    expect(createProposedActionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: runEvalSuiteOperation.name,
        input: expect.objectContaining({ suite: "ts_1", project: "p1" }),
      })
    );
    executeSpy.mockRestore();
  });

  it("does not offer a SECOND run button when the model already proposed one", async () => {
    // The derived action id collapses byte-identical inputs, but the model
    // proposes by whatever selector it used while the offer uses the id — so
    // the ids differ and the user would see two buttons for one run.
    const app = makeApp();
    const executeSpy = vi
      .spyOn(createEvalSuiteOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1" },
        suite: { id: "ts_1", name: "smoke" },
        servers: [],
      } as never);
    let captured: Record<string, GatedTool> | undefined;
    prepareChatV2Mock.mockImplementation(async (opts: any) => {
      captured = opts.builtInTools;
      return {
        allTools: opts.builtInTools ?? {},
        enhancedSystemPrompt: opts.systemPrompt,
      };
    });
    runUnifiedAssistantTurnMock.mockImplementation(async () => {
      await captured![createEvalSuiteOperation.name]!.execute(
        VALID_CREATE_INPUT,
        {}
      );
      // The model proposes running it BY NAME.
      await captured![runEvalSuiteOperation.name]!.execute(
        { suite: "smoke" },
        {}
      );
      return okTurnResult();
    });

    const res = await app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "x-mcpjam-slack-team-id": "T1",
        "x-mcpjam-slack-user-id": "U1",
      },
      body: JSON.stringify({ ...OK_BODY, conversationId: "C1" }),
    });
    const body = (await res.json()) as {
      proposedActions: Array<{ description: string }>;
    };
    expect(body.proposedActions).toHaveLength(1);
    expect(body.proposedActions[0]!.description).toBe("Run eval suite smoke");
    executeSpy.mockRestore();
  });

  it("keeps the turn's answer when the run offer cannot be persisted", async () => {
    // The suite exists and its link is already in the envelope; a proposal
    // that will not persist costs one click of convenience, and failing the
    // turn over it would cost the user their answer.
    const app = makeApp();
    createProposedActionMock.mockRejectedValue(new Error("backend down"));
    const executeSpy = vi
      .spyOn(createEvalSuiteOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1" },
        suite: { id: "ts_1", name: "smoke" },
        servers: [],
      } as never);
    let captured: Record<string, GatedTool> | undefined;
    prepareChatV2Mock.mockImplementation(async (opts: any) => {
      captured = opts.builtInTools;
      return {
        allTools: opts.builtInTools ?? {},
        enhancedSystemPrompt: opts.systemPrompt,
      };
    });
    runUnifiedAssistantTurnMock.mockImplementation(async () => {
      await captured![createEvalSuiteOperation.name]!.execute(
        VALID_CREATE_INPUT,
        {}
      );
      return okTurnResult();
    });

    const res = await app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "x-mcpjam-slack-team-id": "T1",
        "x-mcpjam-slack-user-id": "U1",
      },
      body: JSON.stringify({ ...OK_BODY, conversationId: "C1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      createdResources: unknown[];
      proposedActions: unknown[];
    };
    expect(body.createdResources).toHaveLength(1);
    expect(body.proposedActions).toEqual([]);
    executeSpy.mockRestore();
  });

  it("does not offer a run when the caller has no surface at all", async () => {
    const app = makeApp();
    const executeSpy = vi
      .spyOn(createEvalSuiteOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1" },
        suite: { id: "ts_1", name: "smoke" },
        servers: [],
      } as never);
    let captured: Record<string, GatedTool> | undefined;
    prepareChatV2Mock.mockImplementation(async (opts: any) => {
      captured = opts.builtInTools;
      return {
        allTools: opts.builtInTools ?? {},
        enhancedSystemPrompt: opts.systemPrompt,
      };
    });
    runUnifiedAssistantTurnMock.mockImplementation(async () => {
      await captured![createEvalSuiteOperation.name]!.execute(
        VALID_CREATE_INPUT,
        {}
      );
      return okTurnResult();
    });

    const res = await app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "x-mcpjam-slack-team-id": "T1",
        "x-mcpjam-slack-user-id": "U1",
      },
      body: JSON.stringify(OK_BODY),
    });
    const body = (await res.json()) as { proposedActions: unknown[] };
    expect(body.proposedActions).toEqual([]);
    expect(createProposedActionMock).not.toHaveBeenCalled();
    executeSpy.mockRestore();
  });

  it("PROPOSES a third-party tool call instead of making it", async () => {
    // The one gated op that is not gated for spend: it runs arbitrary code on
    // someone else's server, as the approver, with effects MCPJam cannot undo.
    const executeSpy = vi.spyOn(callServerToolOperation, "execute");
    const tools = await toolsForSlackTurn({ conversationId: "C1" });
    const result = await tools[callServerToolOperation.name]!.execute(
      {
        server: "mailer",
        toolName: "send_email",
        parameters: { to: "alice@example.com" },
      },
      {}
    );
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ proposed: true });
    // The approver is shown the call, not just the fact of one.
    expect(result.description).toContain("send_email");
    expect(result.description).toContain('to: "alice@example.com"');
    expect(createProposedActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ operation: callServerToolOperation.name })
    );
    executeSpy.mockRestore();
  });

  it("carries the external severity out to the host on the wire", async () => {
    const app = makeApp();
    let captured: Record<string, GatedTool> | undefined;
    prepareChatV2Mock.mockImplementation(async (opts: any) => {
      captured = opts.builtInTools;
      return {
        allTools: opts.builtInTools ?? {},
        enhancedSystemPrompt: opts.systemPrompt,
      };
    });
    runUnifiedAssistantTurnMock.mockImplementation(async () => {
      await captured![callServerToolOperation.name]!.execute(
        { server: "mailer", toolName: "send_email", parameters: {} },
        {}
      );
      return okTurnResult();
    });
    const res = await app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "x-mcpjam-slack-team-id": "T1",
        "x-mcpjam-slack-user-id": "U1",
      },
      body: JSON.stringify({ ...OK_BODY, conversationId: "C1" }),
    });
    const body = (await res.json()) as {
      proposedActions: Array<Record<string, unknown>>;
    };
    expect(body.proposedActions[0]).toMatchObject({
      operation: callServerToolOperation.name,
      kind: "external",
      confirmSeverity: "external",
      buttonLabel: "Call the tool",
    });
  });

  it("advertises `project` as optional on gated tools too", async () => {
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    const schema = tools[cancelEvalRunOperation.name]!.inputSchema;
    expect(schema.safeParse({ runId: "run_1" }).success).toBe(true);
  });
});

describe("org capability policy", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "http://convex.test";
    process.env.INSPECTOR_SERVICE_TOKEN = "svc";
    process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH = SLACK_TOKEN_HASH;
    resetSlackRateLimitForTests();
    clearOrgAgentPolicyCache();
    getOrgAgentPolicyMock.mockResolvedValue({ disabledOperations: [] });
    resolveSlackActingUserMock.mockResolvedValue({
      userId: "user_1",
      workosUserId: "workos|alice",
      organizationId: "org_1",
      defaultProjectId: null,
    });
    createProposedActionMock.mockResolvedValue({ created: true });
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
      classifyFailure: () => "failed",
    });
    runUnifiedAssistantTurnMock.mockResolvedValue(okTurnResult());
  });

  afterEach(() => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH;
    vi.clearAllMocks();
  });

  it("omits a disabled GATED op from the turn's tools", async () => {
    // Omitted, not refused: a tool the model can see is a tool it plans
    // around, and announcing an action it then reports as blocked is worse
    // than never offering it.
    getOrgAgentPolicyMock.mockResolvedValue({
      disabledOperations: [runEvalSuiteOperation.name],
    });
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    expect(tools[runEvalSuiteOperation.name]).toBeUndefined();
    // Every other gated op is untouched — the policy is a filter, not a switch.
    expect(tools[cancelEvalRunOperation.name]).toBeDefined();
  });

  it("omits a disabled DIRECT op too", async () => {
    getOrgAgentPolicyMock.mockResolvedValue({
      disabledOperations: [listProjectServersOperation.name],
    });
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    expect(tools[listProjectServersOperation.name]).toBeUndefined();
  });

  it("is a NO-OP when the org has disabled nothing", async () => {
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    for (const operation of [
      ...AGENT_API_OPERATIONS,
      ...AGENT_API_GATED_OPERATIONS,
    ]) {
      expect(tools[operation.name], operation.name).toBeDefined();
    }
  });

  it("ignores an operation name the registry does not know", async () => {
    // Tighten-only: a stale or bogus entry can never GRANT anything, and must
    // not take anything away either.
    getOrgAgentPolicyMock.mockResolvedValue({
      disabledOperations: ["not_a_real_operation"],
    });
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    expect(tools[runEvalSuiteOperation.name]).toBeDefined();
  });

  it("treats a route-missing backend as an empty policy, and stops asking", async () => {
    // Deployable ahead of the backend. The empty answer is CACHED, so an old
    // deployment does not cost a round trip on every turn.
    const { SlackBackendUnavailable } = (await import(
      "../../../services/slack-backend.js"
    )) as {
      SlackBackendUnavailable: new (
        m: string,
        o?: { status?: number }
      ) => Error;
    };
    getOrgAgentPolicyMock.mockRejectedValue(
      new SlackBackendUnavailable("404", { status: 404 })
    );
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    expect(tools[runEvalSuiteOperation.name]).toBeDefined();

    await toolsForSlackTurn({ slackChannelId: "C1" });
    expect(getOrgAgentPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("FAILS OPEN when the policy cannot be read", async () => {
    // Tool assembly runs on every turn. A Convex blip that stripped every tool
    // would turn a transient outage into an agent that answers "I can't do
    // that" for a minute — and the policy is a tightening over an already
    // authorized surface, not the authorization itself.
    getOrgAgentPolicyMock.mockRejectedValue(new Error("convex down"));
    const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
    expect(tools[runEvalSuiteOperation.name]).toBeDefined();
  });

  it("serves a STALE policy rather than an empty one after a failure", async () => {
    getOrgAgentPolicyMock.mockResolvedValue({
      disabledOperations: [runEvalSuiteOperation.name],
    });
    await toolsForSlackTurn({ slackChannelId: "C1" });

    // Expire the entry, then fail the refresh. The org's own most recent
    // decision beats the pre-feature default.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      getOrgAgentPolicyMock.mockRejectedValue(new Error("convex down"));
      const tools = await toolsForSlackTurn({ slackChannelId: "C1" });
      expect(tools[runEvalSuiteOperation.name]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches for 60s, then re-reads", async () => {
    await toolsForSlackTurn({ slackChannelId: "C1" });
    await toolsForSlackTurn({ slackChannelId: "C1" });
    expect(getOrgAgentPolicyMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      await toolsForSlackTurn({ slackChannelId: "C1" });
      expect(getOrgAgentPolicyMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT mint a post-create run offer when run_eval_suite is disabled", async () => {
    // `offerRunsForCreatedSuites` bypasses the tool array entirely, so
    // filtering the tools is not enough: the org would still be handed a
    // Run-it button for every suite the turn created.
    getOrgAgentPolicyMock.mockResolvedValue({
      disabledOperations: [runEvalSuiteOperation.name],
    });
    const app = makeApp();
    const executeSpy = vi
      .spyOn(createEvalSuiteOperation, "execute")
      .mockResolvedValue({
        project: { id: "p1" },
        suite: { id: "ts_1", name: "smoke" },
        servers: [],
      } as never);
    let captured: Record<string, GatedTool> | undefined;
    prepareChatV2Mock.mockImplementation(async (opts: any) => {
      captured = opts.builtInTools;
      return {
        allTools: opts.builtInTools ?? {},
        enhancedSystemPrompt: opts.systemPrompt,
      };
    });
    runUnifiedAssistantTurnMock.mockImplementation(async () => {
      await captured![createEvalSuiteOperation.name]!.execute(
        VALID_CREATE_INPUT,
        {}
      );
      return okTurnResult();
    });

    const res = await app.request("/api/v1/projects/p1/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "x-mcpjam-slack-team-id": "T1",
        "x-mcpjam-slack-user-id": "U1",
      },
      body: JSON.stringify({ ...OK_BODY, conversationId: "C1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      createdResources: Array<{ id: string }>;
      proposedActions?: Array<Record<string, unknown>>;
    };
    // The suite was still created and is still surfaced — only the offer is
    // withheld.
    expect(body.createdResources).toHaveLength(1);
    expect(body.proposedActions ?? []).toHaveLength(0);
    expect(createProposedActionMock).not.toHaveBeenCalled();
    executeSpy.mockRestore();
  });
});

describe("GET /api/v1/agent-ops", () => {
  /**
   * A signed-in user's bearer — the org-settings page, not the bot. The `slk_`
   * credential deliberately CANNOT reach this route: it is not on
   * SLACK_ALLOWED_PATHS, and the bot has no business reading the catalog.
   */
  function catalogRequest(token: string | null = "workos-user-token") {
    return makeApp().request("/api/v1/agent-ops", {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
  }

  beforeEach(() => {
    process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH = SLACK_TOKEN_HASH;
    resetSlackRateLimitForTests();
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    verifyAuthKitTokenMock.mockResolvedValue({ sub: "workos|alice" });
  });

  afterEach(() => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH;
    vi.clearAllMocks();
  });

  it("is unreachable with the Slack bot's credential", async () => {
    resolveSlackActingUserMock.mockResolvedValue({
      userId: "user_1",
      workosUserId: "workos|alice",
      organizationId: "org_1",
      defaultProjectId: null,
    });
    const res = await makeApp().request("/api/v1/agent-ops", {
      headers: {
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "x-mcpjam-slack-team-id": "T1",
        "x-mcpjam-slack-user-id": "U1",
      },
    });
    expect(res.status).toBe(401);
  });

  it("requires a bearer token", async () => {
    const res = await catalogRequest(null);
    expect(res.status).toBe(401);
  });

  it("serializes the registry so the settings UI cannot drift from it", async () => {
    const res = await catalogRequest();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      operations: Array<{
        name: string;
        tier: string;
        gatedKind?: string;
        confirmSeverity?: string;
      }>;
    };
    const names = body.operations.map((op) => op.name);
    // Both tiers, in full — a missing entry is a tool nobody can switch off.
    for (const operation of [
      ...AGENT_API_OPERATIONS,
      ...AGENT_API_GATED_OPERATIONS,
    ]) {
      expect(names, operation.name).toContain(operation.name);
    }

    const gated = body.operations.find(
      (op) => op.name === runEvalSuiteOperation.name
    );
    expect(gated).toMatchObject({ tier: "gated", gatedKind: "start" });

    const direct = body.operations.find(
      (op) => op.name === listProjectServersOperation.name
    );
    expect(direct).toMatchObject({ tier: "direct" });
    expect(direct).not.toHaveProperty("gatedKind");

    const external = body.operations.find(
      (op) => op.name === callServerToolOperation.name
    );
    expect(external).toMatchObject({ confirmSeverity: "external" });
  });

  it("omits a severity that depends on the arguments", async () => {
    // `set_eval_suite_schedule` is `spend` when enabling and `none` when
    // clearing; a catalog cannot honestly summarize a per-call decision.
    const res = await catalogRequest();
    const body = (await res.json()) as {
      operations: Array<{ name: string; confirmSeverity?: string }>;
    };
    const scheduled = body.operations.find(
      (op) => op.name === setEvalSuiteScheduleOperation.name
    );
    expect(scheduled).toBeDefined();
    expect(scheduled).not.toHaveProperty("confirmSeverity");
  });
});
