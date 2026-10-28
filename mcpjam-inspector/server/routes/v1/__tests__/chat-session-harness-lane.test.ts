import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * THE HARNESS LANE on `POST /v1/chat-sessions/messages`, across the real
 * persistence boundary.
 *
 * `persistChatSessionToConvex` and the session-state client are NOT mocked:
 * the route posts to `/ingest-chat` and `/web/harness/session-state/release`
 * over `fetch`, and a fake Convex answers with the lease semantics the backend
 * enforces (a commit or a release only touches the lease it names). Only the
 * harness itself is faked, as a turn that claims the lane and hands back its
 * commit, which is what `runHarnessTurn` does in caller-persist mode.
 *
 * The property: a saved turn settles the lane, an unsaved one releases it
 * without committing, and either way the caller's next turn runs.
 */

const {
  queryMock,
  mutationMock,
  fetchHostRuntimeConfigMock,
  runUnifiedAssistantTurnMock,
  finalizeUsageMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  runUnifiedAssistantTurnMock: vi.fn(),
  finalizeUsageMock: vi.fn(),
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
vi.mock("../../web/auth.js", () => ({
  createManualHostedConnection: async () => ({
    manager: { getTools: async () => [], disconnectAllServers: async () => {} },
  }),
}));
vi.mock("../../../utils/org-model-config.js", () => ({
  resolveHostModelDefinition: async () => ({
    id: MODEL,
    provider: "anthropic",
  }),
}));
vi.mock("../../../utils/chat-v2-orchestration.js", () => ({
  prepareChatV2: async () => ({ allTools: {}, enhancedSystemPrompt: "system" }),
}));
vi.mock("../../../utils/resolve-turn-runtime.js", () => ({
  resolveTurnRuntime: async () => ({
    runtime: { kind: "hosted", endpointPath: "/stream" },
    modelSource: "mcpjam",
    finalizeUsage: finalizeUsageMock,
    classifyFailure: () => "failed",
  }),
}));
vi.mock("../../../utils/turn-execution.js", () => ({
  runUnifiedAssistantTurn: (...args: unknown[]) =>
    runUnifiedAssistantTurnMock(...args),
}));
vi.mock("../../../utils/harness/playground-box.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/harness/playground-box.js")
  >()),
  acquirePlaygroundHarnessBox: async () => ({
    ok: true,
    box: {
      binding: { sandboxRowId: "row_v1", sandboxId: "sbx_v1" },
      release: async () => {},
    },
  }),
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
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";
import {
  __resetHostedModelCatalogForTests,
  __setHostedCatalogForTests,
} from "../../../services/hosted-model-catalog.js";

const PROJECT = "proj_a";
const MODEL = "anthropic/claude-sonnet-5";
const HOST = "host_claude_code";
const CONVEX = "https://convex.test";

/** This chat's harness lane, as the backend keeps it. */
let lane: { lease?: string; stateVersion: number };
let leaseCount = 0;
/** How the fake `/ingest-chat` answers this test's turns. */
let ingest: () => Response;
const ingestBodies: Array<Record<string, unknown>> = [];
const releaseBodies: Array<Record<string, unknown>> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

async function fakeConvex(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url === `${CONVEX}/ingest-chat`) {
    ingestBodies.push(body);
    const response = ingest();
    // The commit rides the transcript's mutation: it lands only if the write
    // does, and only against the lease it names.
    const commit = body.harnessSessionCommit as
      { leaseId?: string } | undefined;
    if (response.ok && commit?.leaseId && commit.leaseId === lane.lease) {
      lane = { stateVersion: lane.stateVersion + 1 };
    }
    return response;
  }
  if (url === `${CONVEX}/web/harness/session-state/release`) {
    releaseBodies.push(body);
    if (body.leaseId === lane.lease) lane = { stateVersion: lane.stateVersion };
    return json({ ok: true });
  }
  if (url === "https://blob.test/messages") return json([]);
  throw new Error(`unexpected fetch ${url}`);
}

/** The harness: refused while the lane is held, else claims it and commits. */
async function harnessTurn() {
  if (lane.lease) {
    return {
      messages: [],
      toolCalls: [],
      toolResults: [],
      finishReason: "error",
      engineError: "harness_turn_in_progress",
    };
  }
  lane.lease = `lease_${++leaseCount}`;
  return {
    messages: [{ role: "assistant", content: "ok" }],
    assistantMessages: [
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
    toolCalls: [],
    toolResults: [],
    turnTrace: { turnId: "turn_1", spans: [] },
    usage: { inputTokens: 1, outputTokens: 2 },
    finishReason: "stop",
    harnessSessionCommit: {
      ownerType: "direct-chat",
      chatSessionId: "runtime-uuid",
      leaseId: lane.lease,
      expectedStateVersion: lane.stateVersion,
      harnessId: "claude-code",
      harnessSessionId: "native",
      resumeState: {},
      computerId: "sbx_v1",
      runtimeFingerprint: "fingerprint",
    },
  };
}

function send(body: Record<string, unknown>) {
  const app = new Hono();
  app.use("*", requestLogContextMiddleware);
  app.onError(v1OnError);
  app.route("/api/v1", chatSessions);
  return app.request("/api/v1/chat-sessions/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const firstTurn = (idempotencyKey = `k-${Math.random()}`) => ({
  projectId: PROJECT,
  idempotencyKey,
  message: "hi",
  modelId: MODEL,
  toolMode: "auto",
  hostId: HOST,
});
const nextTurn = () => ({
  sessionId: "cs_1",
  idempotencyKey: `k-${Math.random()}`,
  message: "again",
  hostId: HOST,
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  lane = { stateVersion: 0 };
  leaseCount = 0;
  ingestBodies.length = 0;
  releaseBodies.length = 0;
  ingest = () => json({ version: 1, sessionId: "cs_1" });
  process.env.CONVEX_URL = CONVEX;
  process.env.CONVEX_HTTP_URL = CONVEX;
  process.env.INSPECTOR_SERVICE_TOKEN = "svc";
  process.env.E2B_API_KEY = "e2b";
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "secret";
  __setHostedCatalogForTests([MODEL]);
  vi.stubGlobal("fetch", vi.fn(fakeConvex));
  fetchHostRuntimeConfigMock.mockResolvedValue({
    ok: true,
    config: {
      hostId: HOST,
      harness: "claude-code",
      selectedServerIds: ["srv_1"],
    },
  });
  queryMock.mockImplementation(async (name) => name === "projectEnvironments:resolveEnvironmentForRuntime" ? {
    environmentRef: { environmentId: "chat-env", name: "Chat", revision: 1 },
    host: { hostId: HOST, runtimeConfig: { hostId: HOST, harness: "claude-code", selectedServerIds: ["srv_1"] } },
    servers: { effectiveServerIds: ["srv_1"] }, skills: [], pluginVersions: [],
  } : {
    _id: "cs_1",
    chatSessionId: "runtime-uuid",
    projectId: PROJECT,
    origin: "api",
    version: 1,
    startedAt: 1_000,
    messagesBlobUrl: "https://blob.test/messages",
    resumeConfig: { modelId: MODEL, toolMode: "auto" },
  });
  mutationMock.mockImplementation(async (reference) => {
    const name = typeof reference === "string" ? reference : getFunctionName(reference);
    if (name === "chatSessions:claimTurnLease") return { status: "claimed", turnId: "turn_1" };
    if (name === "projectEnvironments:ensureAdhocEnvironment") return { environment: { environmentId: "chat-env" } };
    return null;
  });
  finalizeUsageMock.mockResolvedValue(undefined);
  runUnifiedAssistantTurnMock.mockImplementation(
    async (opts: { onEngineError?: (e: { message: string }) => void }) => {
      const result = await harnessTurn();
      if ("engineError" in result) {
        opts.onEngineError?.({ message: String(result.engineError) });
      }
      return result;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __resetHostedModelCatalogForTests();
});

/** The caller's next turn on the same chat ran the harness. */
async function expectNextTurnRuns() {
  ingest = () => json({ version: 2, sessionId: "cs_1" });
  const next = await send(nextTurn());
  expect(next.status).toBe(200);
  expect((await next.json()).engine).toBe("harness:claude-code");
}

describe("a saved turn settles the harness lane", () => {
  it("commits the lane with the transcript, and the next turn runs", async () => {
    const response = await send(firstTurn());

    expect(response.status).toBe(200);
    expect(ingestBodies[0]?.harnessSessionCommit).toMatchObject({
      leaseId: "lease_1",
      expectedStateVersion: 0,
    });
    expect(lane).toEqual({ stateVersion: 1 });
    expect(releaseBodies).toEqual([]);
    await expectNextTurnRuns();
  });
});

describe("an unsaved turn releases the lane without committing", () => {
  it.each([
    ["a rejected write (4xx)", () => json({ error: "bad" }, 400)],
    [
      "an unreachable backend",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])(
    "%s",
    async (_label, answer) => {
      ingest = answer;

      const response = await send(firstTurn());
      const body = await response.json();

      // The turn ran and spent, so the caller is told it did not land rather
      // than that it failed; a retry with the same key must not run again.
      expect(response.status).toBe(200);
      expect(body.persisted.outcome).toBe("failed");
      expect(releaseBodies).toEqual([
        expect.objectContaining({
          leaseId: "lease_1",
          ownerType: "direct-chat",
          chatSessionId: "runtime-uuid",
          harnessId: "claude-code",
          projectId: PROJECT,
        }),
      ]);
      expect(lane).toEqual({ stateVersion: 0 });
      await expectNextTurnRuns();
    },
    10_000,
  );

  it("an exception after the turn ran, before it was saved", async () => {
    finalizeUsageMock.mockRejectedValueOnce(new Error("usage write failed"));

    const response = await send(firstTurn());

    expect(response.status).toBe(500);
    expect(ingestBodies).toEqual([]);
    expect(releaseBodies).toHaveLength(1);
    expect(lane).toEqual({ stateVersion: 0 });
    await expectNextTurnRuns();
  });
});
