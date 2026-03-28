import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerAuthMiddleware } from "../../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../../middleware/guest-rate-limit.js";
import evalsRoutes from "../evals.js";
import { mapRuntimeError, webError } from "../errors.js";

const {
  runEvalsWithManagerMock,
  runEvalTestCaseWithManagerMock,
  generateEvalTestsWithManagerMock,
  generateNegativeEvalTestsWithManagerMock,
  disconnectAllServersMock,
} = vi.hoisted(() => ({
  runEvalsWithManagerMock: vi.fn(),
  runEvalTestCaseWithManagerMock: vi.fn(),
  generateEvalTestsWithManagerMock: vi.fn(),
  generateNegativeEvalTestsWithManagerMock: vi.fn(),
  disconnectAllServersMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@mcpjam/sdk", () => ({
  MCPClientManager: vi.fn().mockImplementation(() => ({
    disconnectAllServers: disconnectAllServersMock,
  })),
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js",
  );
  return {
    ...actual,
    runEvalsWithManager: (...args: unknown[]) =>
      runEvalsWithManagerMock(...args),
    runEvalTestCaseWithManager: (...args: unknown[]) =>
      runEvalTestCaseWithManagerMock(...args),
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
    path: "/api/web/evals/run",
    body: {
      workspaceId: "workspace-1",
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
        },
      ],
    },
    successBody: { success: true, suiteId: "suite-1", runId: "run-1" },
    successMock: runEvalsWithManagerMock,
  },
  {
    path: "/api/web/evals/run-test-case",
    body: {
      workspaceId: "workspace-1",
      serverIds: ["server-1"],
      testCaseId: "test-case-1",
      model: "openai/gpt-5-mini",
      provider: "openai",
    },
    successBody: { success: true, iteration: { _id: "iter-1" } },
    successMock: runEvalTestCaseWithManagerMock,
  },
  {
    path: "/api/web/evals/generate-tests",
    body: {
      workspaceId: "workspace-1",
      serverIds: ["server-1"],
    },
    successBody: { success: true, tests: [{ title: "Generated test" }] },
    successMock: generateEvalTestsWithManagerMock,
  },
  {
    path: "/api/web/evals/generate-negative-tests",
    body: {
      workspaceId: "workspace-1",
      serverIds: ["server-1"],
    },
    successBody: { success: true, tests: [{ title: "Negative test" }] },
    successMock: generateNegativeEvalTestsWithManagerMock,
  },
];

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
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          authorized: true,
          role: "member",
          accessLevel: "workspace_member",
          permissions: { chatOnly: false },
          serverConfig: {
            transportType: "http",
            url: "https://server.example.com/mcp",
            headers: {},
            useOAuth: options?.useOAuth ?? false,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );
}

describe("web routes — evals", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    stubAuthorizeResponse();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
});
