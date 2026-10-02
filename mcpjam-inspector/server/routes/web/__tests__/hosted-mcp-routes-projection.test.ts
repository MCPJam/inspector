import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";

/**
 * MJ-001: what the hosted MCP routes — web and v1 — report about a server's
 * answers, on success and on failure.
 *
 * These drive the real routes and the real hosted connection factory against
 * an in-process upstream behind the hosted transport factory. The upstream
 * puts `UNEXPECTED_MARKER_*` strings in its response bodies and headers, and
 * the stored server config carries a custom header whose value is a marker.
 * Each case serializes the WHOLE response and asserts none of them is in it.
 */

type Upstream = (request: Request) => Response | Promise<Response>;

const { upstream, validateGuestTokenMock } = vi.hoisted(() => ({
  upstream: { current: undefined as Upstream | undefined },
  validateGuestTokenMock: vi.fn(),
}));

vi.mock("../../../utils/hosted-mcp-base-fetch.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../utils/hosted-mcp-base-fetch.js")
    >();
  return {
    ...actual,
    hostedMcpBaseFetch: () =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!upstream.current) throw new Error("No upstream configured.");
        return upstream.current(new Request(input, init));
      }) as typeof fetch,
  };
});

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    async mutation() {
      return null;
    }
  },
}));

const SERVER_URL = "https://mcp.example.test/mcp";
const MARKER = /UNEXPECTED_MARKER/;
const ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "www-authenticate",
  "mcp-session-id",
  "mcp-protocol-version",
  "allow",
  "retry-after",
]);

/** A header the stored server config carries, with a value to keep private. */
const CONFIGURED_HEADERS = { "X-Tenant-Secret": "UNEXPECTED_MARKER_CONFIG" };

/** Response headers every upstream answer carries outside the allowlist. */
const EXTRA_RESPONSE_HEADERS = {
  "x-upstream-trace": "UNEXPECTED_MARKER_HEADER",
  "set-cookie": "session=UNEXPECTED_MARKER_COOKIE",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...EXTRA_RESPONSE_HEADERS,
      ...init.headers,
    },
  });
}

async function readMessage(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Every request answers 405 with an HTML page. */
const htmlRejection: Upstream = () =>
  new Response("<html><body>UNEXPECTED_MARKER_BODY</body></html>", {
    status: 405,
    headers: { "content-type": "text/html", ...EXTRA_RESPONSE_HEADERS },
  });

/** A working MCP server whose results carry nothing outside the protocol. */
const mcpServer: Upstream = async (request) => {
  if (request.method === "GET") {
    return new Response(null, {
      status: 405,
      headers: { allow: "POST", ...EXTRA_RESPONSE_HEADERS },
    });
  }
  if (request.method === "DELETE") return new Response(null, { status: 200 });
  const message = await readMessage(request);
  if (message?.method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "fixture-server", version: "1.0.0" },
      },
    });
  }
  if (typeof message?.method === "string" && message.id === undefined) {
    return new Response(null, { status: 202, headers: EXTRA_RESPONSE_HEADERS });
  }
  const results: Record<string, unknown> = {
    "tools/list": {
      tools: [{ name: "search", inputSchema: { type: "object" } }],
    },
    "resources/list": {
      resources: [{ uri: "file:///notes.txt", name: "notes" }],
    },
    "resources/templates/list": { resourceTemplates: [] },
    "prompts/list": { prompts: [{ name: "summarize" }] },
  };
  if (message?.method in results) {
    return json({
      jsonrpc: "2.0",
      id: message.id,
      result: results[message.method],
    });
  }
  return json({
    jsonrpc: "2.0",
    id: message?.id ?? null,
    error: { code: -32601, message: "Method not found" },
  });
};

function authorizeResponse(): Response {
  return json({
    authorized: true,
    role: "member",
    accessLevel: "project_member",
    permissions: { chatOnly: false },
    serverConfig: {
      transportType: "http",
      url: SERVER_URL,
      useOAuth: false,
      headers: CONFIGURED_HEADERS,
    },
  });
}

function authorizeBatchResponse(serverIds: string[]): Response {
  return json({
    results: Object.fromEntries(
      serverIds.map((serverId) => [
        serverId,
        {
          ok: true,
          role: "member",
          accessLevel: "project_member",
          permissions: { chatOnly: false },
          serverConfig: {
            transportType: "http",
            url: SERVER_URL,
            headers: CONFIGURED_HEADERS,
          },
        },
      ]),
    ),
  });
}

type Routes = { web: Hono; v1: Hono };

/**
 * Import the routes under one mode. `HOSTED_MODE` is read when `server/config`
 * is first imported, so each mode needs a fresh module registry.
 */
async function loadRoutes(hosted: boolean): Promise<Routes> {
  process.env.VITE_MCPJAM_HOSTED_MODE = hosted ? "true" : "false";
  vi.resetModules();
  if (hosted) {
    const guard = await import("../../../utils/hosted-egress-guard.js");
    guard.setEgressHostResolverForTests(async () => ["93.184.216.34"]);
  }
  const { requestLogContextMiddleware } =
    await import("../../../middleware/request-log-context.js");
  const web = new Hono();
  web.use("/api/*", requestLogContextMiddleware);
  web.route("/api/web/servers", (await import("../servers.js")).default);
  web.route("/api/web/tools", (await import("../tools.js")).default);
  web.route("/api/web/resources", (await import("../resources.js")).default);
  web.route("/api/web/prompts", (await import("../prompts.js")).default);
  web.route("/api/web/export", (await import("../export.js")).default);
  const v1 = new Hono();
  v1.route("/api/v1", (await import("../../v1/index.js")).default);
  return { web, v1 };
}

function post(app: Hono, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
}

const target = { projectId: "prj_1", serverId: "srv_1" };
const v1Base = "/api/v1/projects/prj_1/servers/srv_1";

type RouteCase = [
  name: string,
  surface: keyof Routes,
  path: string,
  body: Record<string, unknown>,
];

const WEB_LIST_ROUTES: RouteCase[] = [
  ["web tools/list", "web", "/api/web/tools/list", target],
  ["web resources/list", "web", "/api/web/resources/list", target],
  ["web prompts/list", "web", "/api/web/prompts/list", target],
];

const ROUTES: RouteCase[] = [
  ...WEB_LIST_ROUTES,
  [
    "web tools/execute",
    "web",
    "/api/web/tools/execute",
    { ...target, toolName: "search", parameters: {} },
  ],
  [
    "web resources/read",
    "web",
    "/api/web/resources/read",
    { ...target, uri: "file:///notes.txt" },
  ],
  [
    "web prompts/get",
    "web",
    "/api/web/prompts/get",
    { ...target, promptName: "summarize" },
  ],
  ["web export", "web", "/api/web/export/server", target],
  ["web validate", "web", "/api/web/servers/validate", target],
  ["v1 tools", "v1", `${v1Base}/tools`, {}],
  [
    "v1 tools/call",
    "v1",
    `${v1Base}/tools/call`,
    { toolName: "search", parameters: {} },
  ],
  ["v1 resources", "v1", `${v1Base}/resources`, {}],
  [
    "v1 resources/read",
    "v1",
    `${v1Base}/resources/read`,
    { uri: "file:///notes.txt" },
  ],
  ["v1 prompts", "v1", `${v1Base}/prompts`, {}],
  [
    "v1 prompts/get",
    "v1",
    `${v1Base}/prompts/get`,
    { promptName: "summarize" },
  ],
  ["v1 export", "v1", `${v1Base}/export`, {}],
  ["v1 validate", "v1", `${v1Base}/validate`, {}],
];

const originalFetch = global.fetch;
const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
const originalHostedMode = process.env.VITE_MCPJAM_HOSTED_MODE;
const originalServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;

beforeEach(() => {
  vi.clearAllMocks();
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  process.env.INSPECTOR_SERVICE_TOKEN = "test-inspector-service-token";
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://example.convex.site/internal/server-check-queue") {
      const { operation } = JSON.parse(String(init?.body));
      return json({
        state: operation === "release" ? "released" : "active",
        expiresAt: Date.now() + 30_000,
        active: operation === "release" ? 0 : 1,
        waiting: 0,
      });
    }
    if (url.endsWith("/web/authorize")) return authorizeResponse();
    if (url.endsWith("/web/authorize-batch")) {
      const { serverIds } = JSON.parse(String(init?.body ?? "{}"));
      return authorizeBatchResponse(
        Array.isArray(serverIds) ? serverIds : ["srv_1"],
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
  if (originalServiceToken === undefined) {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
  } else {
    process.env.INSPECTOR_SERVICE_TOKEN = originalServiceToken;
  }
  if (originalConvexHttpUrl === undefined) delete process.env.CONVEX_HTTP_URL;
  else process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
  if (originalHostedMode === undefined) {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
  } else {
    process.env.VITE_MCPJAM_HOSTED_MODE = originalHostedMode;
  }
  vi.resetModules();
});

/** Every logged exchange: allowlisted response headers, no configured value. */
function expectHttpLogsProjected(body: any) {
  for (const event of body._httpLogs ?? []) {
    const request = event.exchange?.request;
    if (request?.headers?.["x-tenant-secret"] !== undefined) {
      expect(request.headers["x-tenant-secret"]).toBe("<redacted>");
    }
    const response = event.exchange?.response;
    if (!response) continue;
    for (const header of Object.keys(response.headers)) {
      expect(ALLOWED_RESPONSE_HEADERS.has(header)).toBe(true);
    }
  }
}

describe("hosted MCP routes (web and v1)", () => {
  let routes: Routes;

  beforeAll(async () => {
    routes = await loadRoutes(true);
  }, 60_000);

  it.each(ROUTES)(
    "%s: reports a failing server by its status line",
    async (_name, surface, path, body) => {
      upstream.current = htmlRejection;
      const res = await post(routes[surface], path, body);
      expect(res.status).toBeGreaterThanOrEqual(400);
      const payload = (await res.json()) as any;
      expect(JSON.stringify(payload)).not.toMatch(MARKER);
      expect(payload.message).toBe("The MCP server responded with HTTP 405.");
      if (payload.normalized) {
        expect(payload.normalized.rawMessage).toBe(payload.message);
      }
      expectHttpLogsProjected(payload);
    },
  );

  it.each(ROUTES)(
    "%s: answers 400 for a target the hosted inspector will not dial",
    async (_name, surface, path, body) => {
      const { assertAllowedHostedTargetUrl } =
        await import("../../../utils/hosted-egress-guard.js");
      upstream.current = async () => {
        await assertAllowedHostedTargetUrl("http://10.0.0.5/mcp", "Server URL");
        throw new Error("The guard allowed a private address.");
      };
      const res = await post(routes[surface], path, body);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as any;
      expect(payload.code).toBe("VALIDATION_ERROR");
      expect(payload.message).toMatch(/private or internal address/);
    },
  );

  it.each(WEB_LIST_ROUTES)(
    "%s: reduces the exchange log of a successful call",
    async (_name, surface, path, body) => {
      upstream.current = mcpServer;
      const res = await post(routes[surface], path, body);
      expect(res.status).toBe(200);
      const payload = (await res.json()) as any;
      expect(JSON.stringify(payload)).not.toMatch(MARKER);
      expect(payload._httpLogs.length).toBeGreaterThan(0);
      expectHttpLogsProjected(payload);
      const requestHeaders = payload._httpLogs.map(
        (event: any) => event.exchange.request.headers,
      );
      for (const headers of requestHeaders) {
        expect(headers["x-tenant-secret"]).toBe("<redacted>");
      }
      // The operation's own frames are its result and are returned whole.
      expect(
        payload._rpcLogs.some(
          (event: any) =>
            event.direction === "receive" && event.message.result !== undefined,
        ),
      ).toBe(true);
    },
  );
});

describe("hosted failures this server wrote", () => {
  let web: Hono;
  let v1: Hono;
  let failure: () => unknown;

  beforeAll(async () => {
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
    vi.resetModules();
    const guard = await import("../../../utils/hosted-egress-guard.js");
    guard.setEgressHostResolverForTests(async () => ["93.184.216.34"]);
    const { projectServerSchema, withEphemeralConnection } =
      await import("../auth.js");
    const { runV1ServerOp } = await import("../../v1/adapter.js");
    web = new Hono();
    web.post("/api/web/testing/op", (c) =>
      withEphemeralConnection(c, projectServerSchema, async () => {
        throw failure();
      }),
    );
    v1 = new Hono();
    v1.post("/api/v1/projects/:projectId/servers/:serverId/op", (c) =>
      runV1ServerOp(
        c,
        projectServerSchema,
        async () => {
          throw failure();
        },
        (ctx, result) => ctx.json(result as Record<string, unknown>),
      ),
    );
  }, 60_000);

  const call = (surface: "web" | "v1") =>
    surface === "web"
      ? post(web, "/api/web/testing/op", target)
      : post(v1, `${v1Base}/op`, {});

  it.each(["web", "v1"] as const)(
    "%s: reports a Cross-App Access rejection by its HTTP status",
    async (surface) => {
      const { ErrorCode, WebRouteError } = await import("../errors.js");
      const { toXaaConnectFailure } =
        await import("../../../services/xaa-connect-error.js");
      upstream.current = mcpServer;
      failure = () =>
        toXaaConnectFailure(
          new WebRouteError(
            502,
            ErrorCode.SERVER_UNREACHABLE,
            "XAA token exchange (jwt-bearer grant) was rejected by the authorization server at https://as.example.test/token (HTTP 401) — <html>UNEXPECTED_MARKER_XAA</html>",
            { status: 401 },
          ),
          { serverId: "srv_1", serverName: "Fixture" },
        );
      const res = await call(surface);
      expect(res.status).toBe(502);
      const payload = (await res.json()) as any;
      expect(JSON.stringify(payload)).not.toMatch(MARKER);
      expect(payload.message).toBe(
        `The authorization server for "Fixture" rejected MCPJam's access request (HTTP 401) — check the server's XAA client credentials and issuer in its auth settings.`,
      );
      expect(payload.details.reason).toBe("xaa_authorization_rejected");
    },
  );

  it.each(["web", "v1"] as const)(
    "%s: keeps an authorization server's recorded failure to its URL and status",
    async (surface) => {
      const { ErrorCode, WebRouteError } = await import("../errors.js");
      upstream.current = mcpServer;
      failure = () =>
        new WebRouteError(
          503,
          ErrorCode.SERVER_UNREACHABLE,
          "The authorization server did not answer.",
          {
            authorizationServerUnreachable: true,
            serverId: "srv_1",
            failure: {
              url: "https://as.example.test/token",
              status: 502,
              body: "<html>UNEXPECTED_MARKER_REFRESH</html>",
            },
          },
        );
      const res = await call(surface);
      const payload = (await res.json()) as any;
      expect(JSON.stringify(payload)).not.toMatch(MARKER);
      expect(payload.message).toBe("The authorization server did not answer.");
      expect(payload.details.failure).toEqual({
        url: "https://as.example.test/token",
        status: 502,
      });
      expect(payload.details.authorizationServerUnreachable).toBe(true);
    },
  );
});

describe("local MCP routes", () => {
  let routes: Routes;

  beforeAll(async () => {
    routes = await loadRoutes(false);
  }, 60_000);

  it("web tools/list: keeps the failure's own text", async () => {
    upstream.current = htmlRejection;
    const res = await post(routes.web, "/api/web/tools/list", target);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const payload = (await res.json()) as any;
    expect(payload.message).toContain("UNEXPECTED_MARKER_BODY");
  });

  it("web tools/list: returns the exchange log as recorded", async () => {
    upstream.current = mcpServer;
    const res = await post(routes.web, "/api/web/tools/list", target);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    const headers = payload._httpLogs.map(
      (event: any) => event.exchange.request.headers,
    );
    expect(headers).toContainEqual(
      expect.objectContaining({
        "x-tenant-secret": "UNEXPECTED_MARKER_CONFIG",
      }),
    );
  });
});
