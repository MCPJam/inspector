/**
 * A local quick run end to end through the route, with nothing between the
 * run's manager and the code that resolves its servers mocked away: the
 * manager keys project servers by their ids, and the case's own server names
 * have to reach discovery and execution as those ids.
 */
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockMcpClientManager } from "./helpers/index.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  streamTestCase: vi.fn(),
  managers: [] as Array<{
    configs: Record<string, unknown>;
    getToolsForAiSdk: ReturnType<typeof vi.fn>;
    disconnectAllServers: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = vi.fn();
    query = (...args: unknown[]) => mocks.query(...args);
    mutation = vi.fn(async () => null);
    action = vi.fn(async () => null);
  },
}));

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  class RecordingManager {
    configs: Record<string, unknown>;
    getToolsForAiSdk = vi.fn(async () => ({}));
    disconnectAllServers = vi.fn(async () => undefined);
    disconnectServer = vi.fn(async () => undefined);
    constructor(configs: Record<string, unknown>) {
      this.configs = configs;
      mocks.managers.push(this);
    }
    listServers() {
      return Object.keys(this.configs);
    }
    hasServer(id: string) {
      return id in this.configs;
    }
    getConnectionStatus() {
      return "connected";
    }
  }
  return { ...actual, MCPClientManager: RecordingManager };
});

vi.mock("../../../services/evals-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/evals-runner")>()),
  streamTestCase: (...args: unknown[]) => mocks.streamTestCase(...args),
}));

// The run brings its own model key; the organization's policy is not what
// these tests are about.
vi.mock(
  "../../../services/evals/org-policy-client-keys.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/evals/org-policy-client-keys.js")
    >()),
    prepareClientKeyRun: async (request: {
      modelApiKeys?: Record<string, string>;
    }) => ({ modelApiKeys: request.modelApiKeys, orgModelConfig: undefined }),
  }),
);

import evalsRoutes from "../evals";

const quickRun = {
  testCaseId: "case-1",
  model: "gpt-4",
  provider: "openai",
  // The case names its server; the project knows it by id.
  serverIds: ["Linear"],
  convexAuthToken: "token-123",
  modelApiKeys: { openai: "sk-test" },
};

/** Holds the case read inside `prepareSingleCaseExecution` until released. */
let preparing: { reached: boolean; release?: () => void };

function streamQuickRun(signal?: AbortSignal) {
  const app = new Hono();
  const uiManager = createMockMcpClientManager();
  app.use("/api/mcp/evals/*", async (c, next) => {
    (c as unknown as { mcpClientManager: unknown }).mcpClientManager =
      uiManager;
    await next();
  });
  app.route("/api/mcp/evals", evalsRoutes);
  return app.request("/api/mcp/evals/stream-test-case", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(quickRun),
    signal,
  });
}

describe("a local quick run's servers, through the route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.managers.length = 0;
    preparing = { reached: false };
    vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).endsWith("/web/authorize-batch")) {
          throw new Error(`Unexpected fetch ${String(input)}`);
        }
        return Response.json({
          results: {
            srv_linear: {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://mcp.linear.example/mcp",
                useOAuth: true,
                name: "Linear",
              },
              oauthAccessToken: "token-a",
              oauthCredentialId: "acct_a",
            },
          },
        });
      }),
    );
    mocks.query.mockImplementation(
      async (ref: string | Parameters<typeof getFunctionName>[0]) => {
        const testCase = {
          _id: "case-1",
          title: "Case",
          query: "Hello",
          evalTestSuiteId: "suite-1",
          testSuiteId: "suite-1",
          projectId: "project-1",
        };
        // The run's own lookups pass function references; preparation
        // reads the case by name.
        if (ref === "testSuites:getTestCase") {
          preparing.reached = true;
          if (preparing.release) return testCase;
          await new Promise<void>((resolve) => {
            preparing.release = resolve;
          });
          return testCase;
        }
        switch (typeof ref === "string" ? ref : getFunctionName(ref)) {
          case "testSuites:getTestCase":
            return testCase;
          case "testSuiteAccountSelections:getPersonalSuiteAccountChoices":
            return [];
          case "servers:getProjectServers":
            return [{ _id: "srv_linear", name: "Linear" }];
          default:
            return null;
        }
      },
    );
    mocks.streamTestCase.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolves the case's server name to the id the run's manager holds, for discovery and execution", async () => {
    preparing.release = () => undefined;

    const response = await streamQuickRun();
    const body = await response.text();

    expect(response.status, body).toBe(200);
    const [manager] = mocks.managers;
    expect(Object.keys(manager.configs)).toEqual(["srv_linear"]);
    expect(manager.getToolsForAiSdk.mock.calls[0][0]).toEqual(["srv_linear"]);
    expect(mocks.streamTestCase).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedServers: ["srv_linear"],
        mcpClientManager: manager,
      }),
    );
    expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1);
  });

  it("closes the run's connections when the client leaves while the case is being prepared", async () => {
    const client = new AbortController();

    const pending = streamQuickRun(client.signal);
    await vi.waitFor(() => expect(preparing.reached).toBe(true));
    const [manager] = mocks.managers;
    expect(manager.disconnectAllServers).not.toHaveBeenCalled();
    client.abort();
    preparing.release?.();
    await pending;

    await vi.waitFor(() =>
      expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1),
    );
    // Nothing ran for a client that had gone.
    const [{ abortSignal }] = mocks.streamTestCase.mock.calls[0];
    expect(abortSignal.aborted).toBe(true);
  });
});
