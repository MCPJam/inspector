import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ErrorCode, WebRouteError } from "../../web/errors.js";

/**
 * The session API's preparation runs independent steps side by side, and
 * still answers as the serial route did.
 *
 *   1. OVERLAP. A continuation's transcript and the project's capabilities
 *      are read while the lease is claimed; a harness turn's box is booked
 *      while the turn connects and prepares; the tool policy and the model's
 *      tool set share one `tools/list` per server.
 *   2. ORDER. Whatever the serial route reported first is still what the
 *      caller reads: an unreadable transcript before the brake and the
 *      lease, the lease's answer before a capability refusal, and anything
 *      before the box before a box refusal.
 *   3. COMPENSATION. A lease claimed for a turn that stops at its transcript
 *      is released, and a box that arrives after the turn stopped is too.
 */

const {
  queryMock,
  mutationMock,
  fetchHostRuntimeConfigMock,
  resolveEnvironmentForRuntimeMock,
  createManualHostedConnectionMock,
  prepareChatV2Mock,
  resolveTurnRuntimeMock,
  runUnifiedAssistantTurnMock,
  acquirePlaygroundHarnessBoxMock,
  releaseBoxMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  resolveEnvironmentForRuntimeMock: vi.fn(),
  createManualHostedConnectionMock: vi.fn(),
  prepareChatV2Mock: vi.fn(),
  resolveTurnRuntimeMock: vi.fn(),
  runUnifiedAssistantTurnMock: vi.fn(),
  acquirePlaygroundHarnessBoxMock: vi.fn(),
  releaseBoxMock: vi.fn(),
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
vi.mock("../../../services/environments/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/environments/runtime.js")
  >()),
  resolveEnvironmentForRuntime: (...args: unknown[]) =>
    resolveEnvironmentForRuntimeMock(...args),
  runtimeServerIds: (spec: { servers: { effectiveServerIds: string[] } }) =>
    spec.servers.effectiveServerIds,
  runtimeServerNames: () => [],
  runtimeSkills: () => [],
}));
vi.mock("../../web/auth.js", () => ({
  createManualHostedConnection: (...args: unknown[]) =>
    createManualHostedConnectionMock(...args),
}));
vi.mock("../../../utils/org-model-config.js", () => ({
  resolveHostModelDefinition: async () => ({ id: MODEL, provider: "anthropic" }),
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
  persistChatSessionToConvex: async () => ({
    outcome: "saved",
    sessionDocId: "cs_1",
    version: 4,
  }),
}));
vi.mock("../../../utils/harness/playground-box.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/harness/playground-box.js")
  >()),
  acquirePlaygroundHarnessBox: (...args: unknown[]) =>
    acquirePlaygroundHarnessBoxMock(...args),
}));
vi.mock("../../../services/environments/plugin-attribution.js", () => ({
  fetchPluginRuntimeAttribution: async () => null,
}));
vi.mock("../../../utils/analytics.js", () => ({
  captureServerEvent: () => {},
}));

import chatSessions from "../chat-sessions.js";
import { v1OnError } from "../envelope.js";
import {
  __resetHostedModelCatalogForTests,
  __setHostedCatalogForTests,
} from "../../../services/hosted-model-catalog.js";

const PROJECT = "proj_a";
const MODEL = "anthropic/claude-sonnet-5";
const TRANSCRIPT = "https://blob.test/messages";
const ORIGINAL_ENV = { ...process.env };

/** What happened, in order, across the route's steps. */
let events: string[];
/** How the lease claim answers. */
let claim: () => Promise<unknown>;
/** How the project's capabilities read answers. */
let capabilities: () => Promise<unknown>;
/** How the stored transcript answers. */
let transcript: () => Promise<Response>;

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function send(body: Record<string, unknown>) {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", chatSessions);
  return app.request("/api/v1/chat-sessions/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const continuation = (sessionId = "cs_1") => ({
  sessionId,
  idempotencyKey: `k-${Math.random()}`,
  message: "again",
});

const firstTurn = (overrides: Record<string, unknown> = {}) => ({
  projectId: PROJECT,
  idempotencyKey: `k-${Math.random()}`,
  message: "hi",
  modelId: MODEL,
  toolMode: "auto",
  environmentId: "env_1",
  ...overrides,
});

function environment(runtimeConfig: Record<string, unknown>, serverIds = ["srv_1"]) {
  return {
    environmentRef: { environmentId: "env_1", name: "prod", revision: 1 },
    host: { hostId: "host_1", runtimeConfig },
    servers: { effectiveServerIds: serverIds },
  };
}

function name(reference: unknown): string {
  return typeof reference === "string"
    ? reference
    : getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
}

const mutationNames = () => mutationMock.mock.calls.map(([ref]) => name(ref));

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  process.env.CONVEX_URL = "https://convex.test";
  process.env.CONVEX_HTTP_URL = "https://convex.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "svc";
  process.env.E2B_API_KEY = "e2b";
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "secret";
  __setHostedCatalogForTests([MODEL]);
  claim = async () => ({ status: "claimed", turnId: "turn_1" });
  capabilities = async () => ({ chatEnvironmentVersion: 1 });
  transcript = async () => new Response("[]", { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      if (String(input) !== TRANSCRIPT) throw new Error(`unexpected ${input}`);
      events.push("transcript:start");
      const response = await transcript();
      events.push("transcript:end");
      return response;
    }),
  );
  queryMock.mockImplementation(async (reference: unknown) => {
    if (name(reference) === "projects:getProjectCapabilities") {
      events.push("capabilities");
      return capabilities();
    }
    return {
      _id: "cs_1",
      chatSessionId: "runtime-uuid",
      projectId: PROJECT,
      origin: "api",
      version: 3,
      startedAt: 1_000,
      messagesBlobUrl: TRANSCRIPT,
      resumeConfig: { modelId: MODEL, toolMode: "auto", environmentId: "env_1" },
    };
  });
  mutationMock.mockImplementation(async (reference: unknown) => {
    if (name(reference) === "chatSessions:claimTurnLease") {
      events.push("claim:start");
      const answer = await claim();
      events.push("claim:end");
      return answer;
    }
    return null;
  });
  resolveEnvironmentForRuntimeMock.mockResolvedValue(environment({}));
  createManualHostedConnectionMock.mockResolvedValue({
    manager: { getTools: async () => [], disconnectAllServers: async () => {} },
  });
  prepareChatV2Mock.mockResolvedValue({ allTools: {}, enhancedSystemPrompt: "system" });
  resolveTurnRuntimeMock.mockResolvedValue({
    runtime: { kind: "hosted", endpointPath: "/stream" },
    modelSource: "mcpjam",
    finalizeUsage: async () => {},
    classifyFailure: () => "failed",
  });
  runUnifiedAssistantTurnMock.mockResolvedValue({
    messages: [],
    assistantMessages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
    toolCalls: [],
    toolResults: [],
    turnTrace: { turnId: "turn_1", spans: [] },
    usage: { inputTokens: 1, outputTokens: 2 },
    finishReason: "stop",
  });
  releaseBoxMock.mockResolvedValue(undefined);
  acquirePlaygroundHarnessBoxMock.mockImplementation(async () => {
    events.push("box");
    return {
      ok: true,
      box: { binding: { sandboxRowId: "row_1", sandboxId: "sbx_1" }, release: releaseBoxMock },
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __resetHostedModelCatalogForTests();
});

describe("a continuation's transcript is read while the lease is claimed", () => {
  it("claims before the transcript has answered", async () => {
    transcript = async () => {
      await tick();
      return new Response("[]", { status: 200 });
    };

    const response = await send(continuation());

    expect(response.status).toBe(200);
    expect(events.indexOf("claim:start")).toBeLessThan(
      events.indexOf("transcript:end"),
    );
  });

  it.each([
    ["is taken", async () => ({ status: "claimed", turnId: "turn_1" })],
    ["is held by another turn", async () => ({ status: "in_progress", retryAfterMs: 50 })],
    ["already completed", async () => ({ status: "completed", turnId: "turn_0", sessionId: "cs_1" })],
    ["cannot be claimed", async () => Promise.reject(new Error("convex down"))],
  ])("still reports an unreadable transcript first when the lease %s", async (_label, answer) => {
    claim = answer;
    transcript = async () => new Response("gone", { status: 500 });

    const response = await send(continuation());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.code).toBe("SERVER_UNREACHABLE");
    expect(body.message).toMatch(/stored transcript/);
    expect(resolveEnvironmentForRuntimeMock).not.toHaveBeenCalled();
    expect(createManualHostedConnectionMock).not.toHaveBeenCalled();
  });

  it("releases the lease it claimed for a transcript it cannot read", async () => {
    transcript = async () => new Response("gone", { status: 500 });

    await send(continuation());

    expect(mutationMock).toHaveBeenCalledWith(
      "chatSessions:releaseTurnLease",
      expect.objectContaining({ turnId: "turn_1" }),
    );
  });

  it("reports an unreadable transcript before the organization's turn cap", async () => {
    // Four turns hold the in-process cap while their claims wait.
    let releaseClaims!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    claim = async () => {
      await held;
      return { status: "in_progress", retryAfterMs: 50 };
    };
    const holding = Array.from({ length: 4 }, () => send(firstTurn()));
    await vi.waitFor(() =>
      expect(events.filter((event) => event === "claim:start")).toHaveLength(4),
    );
    transcript = async () => new Response("gone", { status: 500 });

    const response = await send(continuation());

    releaseClaims();
    await Promise.all(holding);
    expect(response.status).toBe(502);
    expect((await response.json()).message).toMatch(/stored transcript/);
  });
});

describe("the project's capabilities are read while the lease is claimed", () => {
  it("asks before the claim has answered", async () => {
    claim = async () => {
      await tick();
      return { status: "claimed", turnId: "turn_1" };
    };

    const response = await send(firstTurn());

    expect(response.status).toBe(200);
    expect(events.indexOf("capabilities")).toBeLessThan(
      events.indexOf("claim:end"),
    );
  });

  it("answers with the lease when the project cannot be read either", async () => {
    capabilities = async () => null;
    claim = async () => ({ status: "in_progress", retryAfterMs: 50 });

    const response = await send(firstTurn());

    expect(response.status).toBe(409);
    expect((await response.json()).details.reason).toBe("TURN_IN_PROGRESS");
  });

  it("refuses a project it cannot read after claiming, and releases the lease", async () => {
    capabilities = async () => null;

    const response = await send(firstTurn());

    expect(response.status).toBe(404);
    expect((await response.json()).message).toBe("Project not found.");
    expect(mutationNames()).toContain("chatSessions:releaseTurnLease");
    expect(mutationNames()).not.toContain("projectEnvironments:ensureAdhocEnvironment");
  });

  it("refuses an older backend before composing anything", async () => {
    capabilities = async () => ({});

    const response = await send(firstTurn({ environmentId: undefined, hostId: "host_1" }));

    expect(response.status).toBe(422);
    expect(fetchHostRuntimeConfigMock).not.toHaveBeenCalled();
    expect(mutationNames()).not.toContain("projectClients:ensureProjectClient");
  });
});

describe("a harness turn's box is booked while the turn connects and prepares", () => {
  beforeEach(() => {
    resolveEnvironmentForRuntimeMock.mockResolvedValue(
      environment({ harness: "claude-code", modelId: MODEL }),
    );
  });

  it("books the box before connecting has finished", async () => {
    createManualHostedConnectionMock.mockImplementation(async () => {
      events.push("connect:start");
      await tick();
      events.push("connect:end");
      return { manager: { getTools: async () => [], disconnectAllServers: async () => {} } };
    });

    const response = await send(firstTurn());

    expect(response.status).toBe(200);
    expect(events.indexOf("box")).toBeLessThan(events.indexOf("connect:end"));
    expect(releaseBoxMock).toHaveBeenCalledTimes(1);
  });

  it("reports a preparation failure over a box refusal", async () => {
    acquirePlaygroundHarnessBoxMock.mockResolvedValue({
      ok: false,
      refusal: { status: 429, error: "limit reached", code: "user_terminal_cap" },
    });
    prepareChatV2Mock.mockRejectedValue(
      new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE, "listing failed"),
    );

    const response = await send(firstTurn());

    expect(response.status).toBe(502);
    expect((await response.json()).message).toBe("listing failed");
    expect(resolveTurnRuntimeMock).not.toHaveBeenCalled();
  });

  it("releases a box that arrives after the turn stopped", async () => {
    let deliver!: () => void;
    acquirePlaygroundHarnessBoxMock.mockReturnValue(
      new Promise((resolve) => {
        deliver = () =>
          resolve({
            ok: true,
            box: {
              binding: { sandboxRowId: "row_1", sandboxId: "sbx_1" },
              release: releaseBoxMock,
            },
          });
      }),
    );
    prepareChatV2Mock.mockRejectedValue(
      new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE, "listing failed"),
    );

    const response = await send(firstTurn());
    expect(response.status).toBe(502);
    expect(releaseBoxMock).not.toHaveBeenCalled();

    deliver();
    await vi.waitFor(() => expect(releaseBoxMock).toHaveBeenCalledTimes(1));
    expect(runUnifiedAssistantTurnMock).not.toHaveBeenCalled();
  });
});

describe("one tools/list per server per turn", () => {
  it("decides the tool policy on the listing the model's tools are built from", async () => {
    resolveEnvironmentForRuntimeMock.mockResolvedValue(
      environment({}, ["srv_1", "srv_2"]),
    );
    const listTools = vi.fn(async (serverId: string) => ({
      tools: [{ name: `${serverId}_read`, annotations: { readOnlyHint: true } }],
    }));
    const manager = {
      listTools,
      // The SDK's `getTools` and `getToolsForAiSdkByServer` both list through
      // `this.listTools`.
      async getTools(this: { listTools: typeof listTools }, ids: string[]) {
        const listed = await Promise.all(ids.map((id) => this.listTools(id)));
        return listed.flatMap((result) => result.tools);
      },
      disconnectAllServers: async () => {},
    };
    createManualHostedConnectionMock.mockResolvedValue({ manager });
    prepareChatV2Mock.mockImplementation(
      async (options: {
        selectedServers: string[];
        mcpClientManager: { listTools: (id: string) => Promise<unknown> };
      }) => {
        for (const id of options.selectedServers) {
          await options.mcpClientManager.listTools(id);
        }
        return { allTools: {}, enhancedSystemPrompt: "system" };
      },
    );

    const response = await send(firstTurn({ toolMode: "read_only" }));

    expect(response.status).toBe(200);
    expect(listTools.mock.calls.map(([id]) => id).sort()).toEqual([
      "srv_1",
      "srv_2",
    ]);
    // The turn's engine lists afresh: the sharing ends with preparation.
    expect(manager.listTools).toBe(listTools);
  });
});
