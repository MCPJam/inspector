import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware } from "../../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../../middleware/guest-rate-limit.js";
import evalsRoutes from "../evals.js";
import { mapRuntimeError, webError } from "../errors.js";
import {
  initGuestTokenSecret,
  issueGuestToken,
} from "../../../services/guest-token.js";

const {
  runEvalsWithManagerMock,
  prepareEvalRunMock,
  runEvalTestCaseWithManagerMock,
  streamEvalTestCaseWithManagerMock,
  generateEvalTestsWithManagerMock,
  generateNegativeEvalTestsWithManagerMock,
  managerConfigsMock,
  disconnectAllServersMock,
} = vi.hoisted(() => ({
  runEvalsWithManagerMock: vi.fn(),
  prepareEvalRunMock: vi.fn(),
  runEvalTestCaseWithManagerMock: vi.fn(),
  streamEvalTestCaseWithManagerMock: vi.fn(),
  generateEvalTestsWithManagerMock: vi.fn(),
  generateNegativeEvalTestsWithManagerMock: vi.fn(),
  managerConfigsMock: vi.fn(),
  disconnectAllServersMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    MCPClientManager: vi.fn().mockImplementation((configs: unknown) => {
      managerConfigsMock(configs);
      return {
        disconnectAllServers: disconnectAllServersMock,
      };
    }),
  };
});

vi.mock("../../../utils/oauth-proxy.js", () => ({
  OAuthProxyError: class OAuthProxyError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  validateUrl: vi.fn().mockResolvedValue({
    url: new URL("https://guest.example.com/mcp"),
  }),
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js",
  );
  return {
    ...actual,
    runEvalsWithManager: (...args: unknown[]) =>
      runEvalsWithManagerMock(...args),
    prepareEvalRun: (...args: unknown[]) => prepareEvalRunMock(...args),
    runEvalTestCaseWithManager: (...args: unknown[]) =>
      runEvalTestCaseWithManagerMock(...args),
    streamEvalTestCaseWithManager: (...args: unknown[]) =>
      streamEvalTestCaseWithManagerMock(...args),
    generateEvalTestsWithManager: (...args: unknown[]) =>
      generateEvalTestsWithManagerMock(...args),
    generateNegativeEvalTestsWithManager: (...args: unknown[]) =>
      generateNegativeEvalTestsWithManagerMock(...args),
  };
});

type EndpointCase = {
  path: string;
  body: Record<string, unknown>;
  successBody: Record<string, unknown>;
  successMock: ReturnType<typeof vi.fn>;
};

const endpointCases: EndpointCase[] = [
  {
    path: "/api/web/evals/run-test-case",
    body: {
      projectId: "project-1",
      serverIds: ["server-1"],
      testCaseId: "test-case-1",
      model: "openai/gpt-5-mini",
      provider: "openai",
      compareRunId: "cmp_case",
      testCaseOverrides: {
        advancedConfig: {
          toolChoice: {
            type: "tool",
            toolName: "search_docs",
          },
        },
      },
    },
    successBody: { success: true, iteration: { _id: "iter-1" } },
    successMock: runEvalTestCaseWithManagerMock,
  },
  {
    path: "/api/web/evals/generate-tests",
    body: {
      projectId: "project-1",
      serverIds: ["server-1"],
    },
    successBody: { success: true, tests: [{ title: "Generated test" }] },
    successMock: generateEvalTestsWithManagerMock,
  },
  {
    path: "/api/web/evals/generate-negative-tests",
    body: {
      projectId: "project-1",
      serverIds: ["server-1"],
    },
    successBody: { success: true, tests: [{ title: "Negative test" }] },
    successMock: generateNegativeEvalTestsWithManagerMock,
  },
];

const runSuiteBody = {
  projectId: "project-1",
  serverIds: ["server-1"],
  suiteName: "Hosted Suite",
  tests: [
    {
      title: "Test",
      query: "Hello",
      runs: 1,
      model: "openai/gpt-5-mini",
      provider: "openai",
      expectedToolCalls: [],
      advancedConfig: {
        toolChoice: {
          type: "tool",
          toolName: "search_docs",
        },
      },
    },
  ],
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function createEvalsTestApp(options?: { bearerToken?: string }) {
  const app = new Hono();

  app.use("/api/web/evals/*", bearerAuthMiddleware, guestRateLimitMiddleware);
  app.route("/api/web/evals", evalsRoutes);
  app.onError((error, c) => {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
    );
  });

  const token = options?.bearerToken ?? "test-token-123";

  return { app, token };
}

async function postJson(
  app: Hono,
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function expectJson<T = unknown>(
  response: Response,
): Promise<{ status: number; data: T }> {
  return {
    status: response.status,
    data: (await response.json()) as T,
  };
}

function stubAuthorizeResponse(options?: { useOAuth?: boolean }) {
  const serverConfig = {
    transportType: "http" as const,
    url: "https://server.example.com/mcp",
    headers: {},
    useOAuth: options?.useOAuth ?? false,
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.endsWith("/web/authorize-batch")) {
        const rawBody =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as { serverIds?: string[] })
            : null;
        const serverIds = Array.isArray(rawBody?.serverIds)
          ? rawBody.serverIds
          : [];
        return new Response(
          JSON.stringify({
            results: Object.fromEntries(
              serverIds.map((serverId) => [
                serverId,
                {
                  ok: true,
                  role: "member",
                  accessLevel: "project_member",
                  permissions: { chatOnly: false },
                  serverConfig,
                },
              ]),
            ),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          authorized: true,
          role: "member",
          accessLevel: "project_member",
          permissions: { chatOnly: false },
          serverConfig,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }),
  );
}

describe("web routes — evals", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalGuestJwtKeyDir = process.env.GUEST_JWT_KEY_DIR;
  let testGuestKeyDir: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    testGuestKeyDir = mkdtempSync(path.join(os.tmpdir(), "evals-guest-test-"));
    process.env.GUEST_JWT_KEY_DIR = testGuestKeyDir;
    initGuestTokenSecret();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    stubAuthorizeResponse();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (testGuestKeyDir) {
      rmSync(testGuestKeyDir, { recursive: true, force: true });
      testGuestKeyDir = null;
    }
    if (originalGuestJwtKeyDir === undefined) {
      delete process.env.GUEST_JWT_KEY_DIR;
    } else {
      process.env.GUEST_JWT_KEY_DIR = originalGuestJwtKeyDir;
    }
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it.each(endpointCases)(
    "requires a bearer token for $path",
    async ({ path, body }) => {
      const { app } = createEvalsTestApp();
      const response = await postJson(app, path, body);
      const { status, data } = await expectJson<{
        code: string;
        message: string;
      }>(response);

      expect(status).toBe(401);
      expect(data).toEqual({
        code: "UNAUTHORIZED",
        message: "Bearer token required",
      });
    },
  );

  it.each(endpointCases)(
    "validates hosted request bodies for $path",
    async ({ path }) => {
      const { app, token } = createEvalsTestApp();
      const response = await postJson(app, path, {}, token);
      const { status, data } = await expectJson<{
        code: string;
        message: string;
      }>(response);

      expect(status).toBe(400);
      expect(data.code).toBe("VALIDATION_ERROR");
    },
  );

  it.each(endpointCases)(
    "surfaces missing OAuth requirements for $path",
    async ({ path, body }) => {
      stubAuthorizeResponse({ useOAuth: true });
      const { app, token } = createEvalsTestApp();
      const response = await postJson(app, path, body, token);
      const { status, data } = await expectJson<{
        code: string;
        message: string;
      }>(response);

      expect(status).toBe(401);
      expect(data.code).toBe("UNAUTHORIZED");
      expect(data.message).toContain("requires OAuth authentication");
    },
  );

  it.each(endpointCases)(
    "handles successful hosted requests for $path",
    async ({ path, body, successBody, successMock }) => {
      successMock.mockResolvedValueOnce(successBody);
      const { app, token } = createEvalsTestApp();
      const response = await postJson(app, path, body, token);
      const { status, data } = await expectJson(response);

      expect(status).toBe(200);
      expect(data).toEqual(successBody);
      expect(successMock).toHaveBeenCalledTimes(1);
      expect(successMock.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          ...body,
          convexAuthToken: token,
        }),
      );
      expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
    },
  );

  it("starts hosted suite runs asynchronously and keeps MCP connections until execution settles", async () => {
    const execution = deferred();
    const execute = vi.fn(() => execution.promise);
    const finalize = vi.fn().mockResolvedValue(undefined);
    prepareEvalRunMock.mockResolvedValueOnce({
      suiteId: "suite-1",
      runId: "run-1",
      caseUpsert: { committed: [], failed: [] },
      recorder: { finalize },
      execute,
    });

    const { app, token } = createEvalsTestApp();
    const response = await postJson(
      app,
      "/api/web/evals/run",
      {
        ...runSuiteBody,
        serverNames: ["Server One"],
        clientInfo: { name: "Pinned Client", version: "1.0.0" },
        supportedProtocolVersions: ["2025-11-25"],
        mcpProtocolVersionsByServerId: { "server-1": "2025-11-25" },
      },
      token,
    );
    const { status, data } = await expectJson<{
      success: true;
      suiteId: string;
      runId: string;
      status: string;
      message: string;
    }>(response);

    expect(status).toBe(202);
    expect(data).toMatchObject({
      success: true,
      suiteId: "suite-1",
      runId: "run-1",
      status: "running",
      message: "Eval run started. Results will appear shortly.",
    });
    expect(prepareEvalRunMock).toHaveBeenCalledTimes(1);
    expect(prepareEvalRunMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        ...runSuiteBody,
        // The wire transform projects this legacy body (query/expectedToolCalls,
        // no `steps`) onto the steps-first contract before prepareEvalRun runs.
        tests: [
          expect.objectContaining({
            ...runSuiteBody.tests[0],
            steps: [{ id: "step-1-prompt", kind: "prompt", prompt: "Hello" }],
          }),
        ],
        serverNames: ["Server One"],
        convexAuthToken: token,
      }),
    );
    expect(managerConfigsMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        "server-1": expect.objectContaining({
          clientInfo: { name: "Pinned Client", version: "1.0.0" },
          supportedProtocolVersions: ["2025-11-25"],
          mcpProtocolVersion: "2025-11-25",
        }),
      }),
    );
    expect(disconnectAllServersMock).not.toHaveBeenCalled();

    execution.resolve(undefined);
    await flushPromises();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
  });

  it("marks hosted suite runs failed when detached execution rejects", async () => {
    const execution = deferred();
    const finalize = vi.fn().mockResolvedValue(undefined);
    prepareEvalRunMock.mockResolvedValueOnce({
      suiteId: "suite-1",
      runId: "run-1",
      caseUpsert: { committed: [], failed: [] },
      recorder: { finalize },
      execute: vi.fn(() => execution.promise),
    });

    const { app, token } = createEvalsTestApp();
    const response = await postJson(
      app,
      "/api/web/evals/run",
      runSuiteBody,
      token,
    );

    expect(response.status).toBe(202);
    execution.reject(new Error("model provider unavailable"));
    await flushPromises();

    expect(finalize).toHaveBeenCalledWith({
      status: "failed",
      notes: "model provider unavailable",
    });
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
  });

  it("disconnects immediately when hosted suite run setup fails before detaching", async () => {
    prepareEvalRunMock.mockRejectedValueOnce(new Error("quota exceeded"));

    const { app, token } = createEvalsTestApp();
    const response = await postJson(
      app,
      "/api/web/evals/run",
      runSuiteBody,
      token,
    );
    const { status, data } = await expectJson<{ code: string; message: string }>(
      response,
    );

    expect(status).toBe(500);
    expect(data.message).toContain("quota exceeded");
    expect(disconnectAllServersMock).toHaveBeenCalledTimes(1);
  });

  it("passes hosted server names through to eval suite runs", async () => {
    prepareEvalRunMock.mockResolvedValueOnce({
      suiteId: "suite-1",
      runId: "run-1",
      caseUpsert: { committed: [], failed: [] },
      recorder: { finalize: vi.fn().mockResolvedValue(undefined) },
      execute: vi.fn().mockResolvedValue(undefined),
    });

    const { app, token } = createEvalsTestApp();
    const response = await postJson(
      app,
      "/api/web/evals/run",
      {
        projectId: "project-1",
        serverIds: ["srv-1"],
        serverNames: ["server-1"],
        suiteName: "Hosted Suite",
        tests: [
          {
            title: "Test",
            query: "Hello",
            runs: 1,
            model: "openai/gpt-5-mini",
            provider: "openai",
            expectedToolCalls: [],
          },
        ],
      },
      token,
    );

    expect(response.status).toBe(202);
    expect(prepareEvalRunMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        projectId: "project-1",
        serverIds: ["srv-1"],
        serverNames: ["server-1"],
        convexAuthToken: token,
      }),
    );
    await flushPromises();
  });

  it("streams hosted compare quick runs from /api/web/evals/stream-test-case", async () => {
    const encoder = new TextEncoder();
    streamEvalTestCaseWithManagerMock.mockResolvedValueOnce(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"trace_snapshot","turnIndex":0,"snapshotKind":"step_finish","trace":{"traceVersion":1,"messages":[{"role":"user","content":"Hello"}]},"actualToolCalls":[],"usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}\n\n',
            ),
          );
          controller.close();
        },
      }),
    );

    const { app, token } = createEvalsTestApp();
    const response = await postJson(
      app,
      "/api/web/evals/stream-test-case",
      {
        projectId: "project-1",
        serverIds: ["server-1"],
        testCaseId: "test-case-1",
        model: "openai/gpt-5-mini",
        provider: "openai",
        compareRunId: "cmp_stream",
      },
      token,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await expect(response.text()).resolves.toContain('"type":"trace_snapshot"');
    expect(streamEvalTestCaseWithManagerMock).toHaveBeenCalledTimes(1);
    expect(streamEvalTestCaseWithManagerMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        projectId: "project-1",
        serverIds: ["server-1"],
        testCaseId: "test-case-1",
        model: "openai/gpt-5-mini",
        provider: "openai",
        compareRunId: "cmp_stream",
        convexAuthToken: token,
      }),
    );
  });

  it("rejects direct guest compare quick run bodies", async () => {
    const { app } = createEvalsTestApp();
    const { token } = issueGuestToken();

    const response = await postJson(
      app,
      "/api/web/evals/stream-test-case",
      {
        serverUrl: "https://guest.example.com/mcp",
        serverName: "Guest Server",
        testCaseId: "guest-case-1",
        model: "openai/gpt-5-mini",
        provider: "openai",
        compareRunId: "cmp_guest",
      },
      token,
    );

    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(response);

    expect(status).toBe(400);
    expect(data.code).toBe("VALIDATION_ERROR");
    expect(streamEvalTestCaseWithManagerMock).not.toHaveBeenCalled();
  });

  it("allows guests to run full eval suites", async () => {
    prepareEvalRunMock.mockResolvedValueOnce({
      suiteId: "guest-suite-1",
      runId: "guest-run-1",
      caseUpsert: { committed: [], failed: [] },
      recorder: { finalize: vi.fn().mockResolvedValue(undefined) },
      execute: vi.fn().mockResolvedValue(undefined),
    });

    const { app } = createEvalsTestApp();
    const { token } = issueGuestToken();

    const response = await postJson(
      app,
      "/api/web/evals/run",
      {
        projectId: "guest-project-1",
        serverIds: ["guest-srv-1"],
        serverNames: ["guest-server-1"],
        suiteName: "Guest Suite",
        tests: [
          {
            title: "Test",
            query: "Hello",
            runs: 1,
            model: "openai/gpt-5-mini",
            provider: "openai",
            expectedToolCalls: [],
          },
        ],
      },
      token,
    );

    expect(response.status).toBe(202);
    expect(prepareEvalRunMock).toHaveBeenCalledTimes(1);
    expect(prepareEvalRunMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        projectId: "guest-project-1",
        serverIds: ["guest-srv-1"],
        convexAuthToken: token,
      }),
    );
    await flushPromises();
  });
});
