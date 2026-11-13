import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { MCPClientManager } from "@mcpjam/sdk";

/**
 * WARM ADMISSION on `POST /v1/chat-sessions/messages`.
 *
 *   1. SAME TERMS AS THE PLAYGROUND. Behind `MCPJAM_HARNESS_API_WARM`, an API
 *      turn's manager is admitted exactly when `admitWarmChatManager` would
 *      admit the web route's: the organization's warm switch is on, and any
 *      servers the manager holds were authorized for that organization.
 *   2. THE BACKEND'S ORGANIZATION. The organization is the one the backend's
 *      capabilities read returned for the project, never the request's or the
 *      API key's own.
 *   3. NO SHARED CONVERSATION. An API turn never continues a Playground
 *      session and never names its conversation, so a warm API turn can only
 *      reach its own conversation's agent.
 */

const {
  queryMock,
  mutationMock,
  createManualHostedConnectionMock,
  runUnifiedAssistantTurnMock,
  acquirePlaygroundHarnessBoxMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  createManualHostedConnectionMock: vi.fn(),
  runUnifiedAssistantTurnMock: vi.fn(),
  acquirePlaygroundHarnessBoxMock: vi.fn(),
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
  fetchHostRuntimeConfig: async () => ({
    ok: true,
    config: { hostId: "host_1", harness: "claude-code", modelId: MODEL },
  }),
}));
vi.mock("../../../services/environments/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/environments/runtime.js")
  >()),
  resolveEnvironmentForRuntime: async () => ({
    environmentRef: { environmentId: "env_1", name: "prod", revision: 1 },
    host: { hostId: "host_1", runtimeConfig: { harness: "claude-code", modelId: MODEL } },
    servers: { effectiveServerIds: servers },
  }),
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
  prepareChatV2: async () => ({ allTools: {}, enhancedSystemPrompt: "system" }),
}));
vi.mock("../../../utils/resolve-turn-runtime.js", () => ({
  resolveTurnRuntime: async () => ({
    runtime: { kind: "hosted", endpointPath: "/stream" },
    modelSource: "mcpjam",
    finalizeUsage: async () => {},
    classifyFailure: () => "failed",
  }),
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
import { setManagerOrganization } from "../../../utils/mcp-connections.js";
import {
  admitWarmChatManager,
  isWarmChatManager,
} from "../../../utils/harness/warm-approval-binding.js";
import {
  __resetHostedModelCatalogForTests,
  __setHostedCatalogForTests,
} from "../../../services/hosted-model-catalog.js";

const PROJECT = "proj_a";
const MODEL = "anthropic/claude-sonnet-5";
const ORIGINAL_ENV = { ...process.env };

/** The organization the backend's capabilities read returns for the project. */
let projectOrganization: string | undefined;
/** The organization the backend authorized the manager's servers for. */
let serverOrganization: string | undefined;
/** The servers the environment resolves to. */
let servers: string[];
/** The session row a continuation names. */
let session: Record<string, unknown>;

/** A manager for one turn, as `createManualHostedConnection` builds it. */
function connectedManager() {
  const manager: MCPClientManager = {
    getTools: async () => [],
    disconnectAllServers: async () => {},
  } as never;
  setManagerOrganization(manager, serverOrganization);
  return manager;
}

function name(reference: unknown): string {
  return typeof reference === "string"
    ? reference
    : getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
}

function send(body: Record<string, unknown>, keyOrganization?: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (keyOrganization) c.set("mcpjamOrganizationId", keyOrganization);
    await next();
  });
  app.onError(v1OnError);
  app.route("/api/v1", chatSessions);
  return app.request("/api/v1/chat-sessions/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const firstTurn = (overrides: Record<string, unknown> = {}) => ({
  projectId: PROJECT,
  idempotencyKey: `k-${Math.random()}`,
  message: "hi",
  modelId: MODEL,
  toolMode: "auto",
  environmentId: "env_1",
  ...overrides,
});

/** Whether the manager the turn ran with may re-attach to a warm agent. */
function ranWarm(): boolean {
  const [options] = runUnifiedAssistantTurnMock.mock.calls.at(-1) as [
    { mcpClientManager: MCPClientManager },
  ];
  return isWarmChatManager(options.mcpClientManager);
}

/** What the web route's `admitWarmChatManager` call decides for these inputs. */
function webRouteAdmits(): boolean {
  const manager = connectedManager();
  admitWarmChatManager(manager, projectOrganization, servers.length > 0);
  return isWarmChatManager(manager);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.CONVEX_URL = "https://convex.test";
  process.env.CONVEX_HTTP_URL = "https://convex.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "svc";
  process.env.E2B_API_KEY = "e2b";
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "secret";
  process.env.MCPJAM_HARNESS_API_WARM = "true";
  delete process.env.MCPJAM_HOSTED_WARM_AGENT;
  delete process.env.MCPJAM_HOSTED_WARM_AGENT_ORG_IDS;
  __setHostedCatalogForTests([MODEL]);
  projectOrganization = "org_a";
  serverOrganization = "org_a";
  servers = ["srv_1"];
  session = {
    _id: "cs_api",
    chatSessionId: "api-conversation",
    projectId: PROJECT,
    origin: "api",
    version: 3,
    startedAt: 1_000,
    messagesBlobUrl: "https://blob.test/messages",
    resumeConfig: { modelId: MODEL, toolMode: "auto", environmentId: "env_1" },
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
  queryMock.mockImplementation(async (reference: unknown) => {
    if (name(reference) === "projects:getProjectCapabilities") {
      return {
        chatEnvironmentVersion: 1,
        ...(projectOrganization ? { organizationId: projectOrganization } : {}),
      };
    }
    return session;
  });
  mutationMock.mockImplementation(async (reference: unknown) => {
    switch (name(reference)) {
      case "chatSessions:claimTurnLease":
        return { status: "claimed", turnId: "turn_1" };
      case "projectClients:ensureProjectClient":
        return { hostId: "host_1" };
      case "projectEnvironments:ensureAdhocEnvironment":
        return { environment: { environmentId: "env_hidden" } };
      default:
        return null;
    }
  });
  createManualHostedConnectionMock.mockImplementation(async () => ({
    manager: connectedManager(),
  }));
  runUnifiedAssistantTurnMock.mockResolvedValue({
    messages: [],
    assistantMessages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
    toolCalls: [],
    toolResults: [],
    turnTrace: { turnId: "turn_1", spans: [] },
    usage: { inputTokens: 1, outputTokens: 2 },
    finishReason: "stop",
  });
  acquirePlaygroundHarnessBoxMock.mockResolvedValue({
    ok: true,
    box: {
      binding: { sandboxRowId: "row_1", sandboxId: "sbx_1", idleMs: 300_000 },
      release: async () => {},
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  __resetHostedModelCatalogForTests();
});

describe("an API turn is admitted on the Playground's terms", () => {
  it.each([
    ["admits servers authorized for the project's organization", () => {}, true],
    [
      "admits a turn with no servers",
      () => {
        servers = [];
        serverOrganization = undefined;
      },
      true,
    ],
    [
      "refuses with the API switch off",
      () => {
        delete process.env.MCPJAM_HARNESS_API_WARM;
      },
      false,
    ],
    [
      "refuses when warm reuse is off for every organization",
      () => {
        process.env.MCPJAM_HOSTED_WARM_AGENT = "false";
      },
      false,
    ],
    [
      "refuses an organization the warm switch leaves out",
      () => {
        process.env.MCPJAM_HOSTED_WARM_AGENT_ORG_IDS = "org_other";
      },
      false,
    ],
    [
      "refuses servers authorized for another organization",
      () => {
        serverOrganization = "org_b";
      },
      false,
    ],
    [
      "refuses when the backend names no organization",
      () => {
        projectOrganization = undefined;
      },
      false,
    ],
  ])("%s", async (_label, arrange, admitted) => {
    arrange();

    const response = await send(
      firstTurn(servers.length ? {} : { environmentId: undefined, serverIds: [] }),
    );

    expect(response.status).toBe(200);
    expect(ranWarm()).toBe(admitted);
    // The web route's own call gives the same answer, unless only the API's
    // switch is what refused.
    if (process.env.MCPJAM_HARNESS_API_WARM === "true") {
      expect(webRouteAdmits()).toBe(admitted);
    }
  });

  it("keys the organization on the backend's answer, not the API key's", async () => {
    process.env.MCPJAM_HOSTED_WARM_AGENT_ORG_IDS = "org_key";
    await send(firstTurn(), "org_key");
    expect(ranWarm()).toBe(false);

    process.env.MCPJAM_HOSTED_WARM_AGENT_ORG_IDS = "org_a";
    await send(firstTurn(), "org_key");
    expect(ranWarm()).toBe(true);
  });
});

describe("an API turn never reaches a Playground conversation's agent", () => {
  it("refuses to continue a Playground session before connecting or booking a box", async () => {
    session = { ...session, origin: "playground", chatSessionId: "web-conversation" };

    const response = await send({
      sessionId: "cs_web",
      idempotencyKey: "k-web",
      message: "again",
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.details.reason).toBe("CONTINUATION_NOT_ALLOWED");
    expect(createManualHostedConnectionMock).not.toHaveBeenCalled();
    expect(acquirePlaygroundHarnessBoxMock).not.toHaveBeenCalled();
    expect(runUnifiedAssistantTurnMock).not.toHaveBeenCalled();
  });

  it("cannot name the conversation it runs in", async () => {
    const response = await send(firstTurn({ chatSessionId: "web-conversation" }));

    expect(response.status).toBe(400);
    expect(createManualHostedConnectionMock).not.toHaveBeenCalled();
    expect(acquirePlaygroundHarnessBoxMock).not.toHaveBeenCalled();
  });

  it("runs a warm continuation on its own conversation's box", async () => {
    const response = await send({
      sessionId: "cs_api",
      idempotencyKey: "k-api",
      message: "again",
    });

    expect(response.status).toBe(200);
    expect(ranWarm()).toBe(true);
    expect(acquirePlaygroundHarnessBoxMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatSessionId: "api-conversation" }),
    );
    expect(runUnifiedAssistantTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSessionId: "api-conversation",
        harnessSandboxBinding: expect.objectContaining({ sandboxId: "sbx_1" }),
      }),
    );
  });
});
