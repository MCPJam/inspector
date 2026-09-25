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
 * MJ-001: what the hosted doctor (web and v1) and hosted validate report about
 * a server's answers.
 *
 * These drive the real SDK doctor — probe, OAuth discovery and MCP connection —
 * and the real hosted connection factory, against an in-process upstream
 * behind the hosted transport factory. The upstream puts `UNEXPECTED_MARKER_*`
 * strings everywhere an answer can carry data outside the allowlist: bodies,
 * headers, status text, unknown and nested fields, JSON-RPC error text and
 * data, metadata extras. Each case serializes the WHOLE response and asserts
 * none of them is in it, then asserts the diagnostics a caller needs are.
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
const PRM_URL =
  "https://mcp.example.test/.well-known/oauth-protected-resource/mcp";
const ISSUER = "https://auth.example.test";
const ASM_URL = `${ISSUER}/.well-known/oauth-authorization-server`;
const MARKER = /UNEXPECTED_MARKER/;
const ALLOWED_HEADERS = new Set([
  "content-type",
  "www-authenticate",
  "mcp-session-id",
  "mcp-protocol-version",
  "allow",
  "retry-after",
]);

const serverUrlRef = { current: SERVER_URL };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

async function readMessage(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Every request answers with the same arbitrary, non-MCP response. */
function fixedAnswer(response: () => Response): Upstream {
  return () => response();
}

const htmlAnswer = fixedAnswer(
  () =>
    new Response("<html><body>UNEXPECTED_MARKER_1</body></html>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "x-extra": "UNEXPECTED_MARKER_2",
        "set-cookie": "sid=UNEXPECTED_MARKER_3",
      },
    }),
);

const jsonPayloadAnswer = fixedAnswer(() =>
  json(
    { jsonrpc: "2.0", payload: "UNEXPECTED_MARKER_4" },
    { headers: { "x-extra": "UNEXPECTED_MARKER_5" } },
  ),
);

const oversizedAnswer = fixedAnswer(
  () =>
    new Response(`<html>${"z".repeat(5000)}UNEXPECTED_MARKER_6</html>`, {
      status: 500,
      statusText: `Internal ${"x".repeat(80)}UNEXPECTED_MARKER_7`,
      headers: {
        "content-type": "text/html",
        "www-authenticate": `Bearer ${"a".repeat(4000)}UNEXPECTED_MARKER_8`,
      },
    }),
);

const initializeResult = (id: unknown) => ({
  jsonrpc: "2.0",
  id,
  result: {
    protocolVersion: "2025-06-18",
    capabilities: {
      tools: { listChanged: true, extra: "UNEXPECTED_MARKER_9" },
      experimental: { nested: { deep: "UNEXPECTED_MARKER_10" } },
    },
    serverInfo: {
      name: "fixture-server",
      version: "1.0.0",
      extra: "UNEXPECTED_MARKER_11",
    },
    instructions: "UNEXPECTED_MARKER_12",
    extra: { nested: ["UNEXPECTED_MARKER_13"] },
  },
});

/**
 * A working MCP server whose initialize result carries unknown and nested
 * fields. `toolsList` overrides the `tools/list` answer.
 */
function mcpServer(toolsList?: () => Response): Upstream {
  return async (request) => {
    if (request.method === "GET") {
      return new Response("UNEXPECTED_MARKER_14", {
        status: 405,
        headers: { allow: "POST", "x-extra": "UNEXPECTED_MARKER_15" },
      });
    }
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    const message = await readMessage(request);
    if (message?.method === "initialize") {
      return json(initializeResult(message.id), {
        headers: { "mcp-session-id": "session-1" },
      });
    }
    if (typeof message?.method === "string" && message.id === undefined) {
      return new Response(null, { status: 202 });
    }
    if (message?.method === "tools/list" && toolsList) return toolsList();
    const results: Record<string, unknown> = {
      "tools/list": { tools: [] },
      "resources/list": { resources: [] },
      "resources/templates/list": { resourceTemplates: [] },
      "prompts/list": { prompts: [] },
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
}

const LISTED_TOOLS = [
  {
    name: "search",
    title: "Search",
    description: "Finds matching records.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, extra: "UNEXPECTED_MARKER_26" },
    icons: [{ src: "https://cdn.example.test/UNEXPECTED_MARKER_27.png" }],
    _meta: { note: "UNEXPECTED_MARKER_28" },
    extra: { nested: ["UNEXPECTED_MARKER_29"] },
  },
  {
    name: "large",
    description: `${"d".repeat(6000)}UNEXPECTED_MARKER_30`,
    inputSchema: {
      type: "object",
      properties: {
        blob: {
          type: "string",
          description: `${"x".repeat(20_000)}UNEXPECTED_MARKER_31`,
        },
      },
    },
  },
];

/**
 * A working MCP server with tools, resources, templates and prompts whose
 * list results carry fields outside the allowlist. `tools` replaces the tool
 * list.
 */
function listingServer(tools: unknown[] = LISTED_TOOLS): Upstream {
  const results: Record<string, unknown> = {
    "tools/list": { tools },
    "resources/list": {
      resources: [
        {
          uri: "file:///notes.txt",
          name: "notes",
          description: "Team notes.",
          mimeType: "text/plain",
          _meta: { note: "UNEXPECTED_MARKER_32" },
          extra: "UNEXPECTED_MARKER_33",
        },
      ],
    },
    "resources/templates/list": {
      resourceTemplates: [
        {
          uriTemplate: "file:///{path}",
          name: "file",
          description: "A file by path.",
          _meta: { note: "UNEXPECTED_MARKER_34" },
        },
      ],
    },
    "prompts/list": {
      prompts: [
        {
          name: "summarize",
          description: "Summarizes text.",
          arguments: [
            { name: "text", required: true, extra: "UNEXPECTED_MARKER_35" },
          ],
          _meta: { note: "UNEXPECTED_MARKER_36" },
        },
      ],
    },
  };
  return async (request) => {
    if (request.method === "GET") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
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
          serverInfo: { name: "listing-server", version: "1.0.0" },
        },
      });
    }
    if (typeof message?.method === "string" && message.id === undefined) {
      return new Response(null, { status: 202 });
    }
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
}

/** Answers every JSON-RPC request with an error carrying text and data. */
const jsonRpcErrorAnswer: Upstream = async (request) => {
  const message = await readMessage(request);
  return json({
    jsonrpc: "2.0",
    id: message?.id ?? null,
    error: {
      code: -32600,
      message: "UNEXPECTED_MARKER_16",
      data: { nested: { value: "UNEXPECTED_MARKER_17" } },
    },
  });
};

/** A server that requires OAuth, with metadata documents carrying extras. */
const oauthServer: Upstream = async (request) => {
  const url = new URL(request.url);
  if (url.href === SERVER_URL) {
    return json(
      { error: "UNEXPECTED_MARKER_18" },
      {
        status: 401,
        statusText: "Unauthorized",
        headers: {
          "www-authenticate": `Bearer resource_metadata="${PRM_URL}"`,
          "x-extra": "UNEXPECTED_MARKER_19",
        },
      },
    );
  }
  if (url.href === PRM_URL) {
    return json({
      resource: SERVER_URL,
      authorization_servers: [ISSUER],
      scopes_supported: ["read", "write"],
      resource_name: "UNEXPECTED_MARKER_20",
      extra: { nested: "UNEXPECTED_MARKER_21" },
    });
  }
  if (url.href === ASM_URL) {
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      code_challenge_methods_supported: ["S256"],
      extra: "UNEXPECTED_MARKER_22",
      nested: { list: ["UNEXPECTED_MARKER_23"] },
    });
  }
  return new Response("UNEXPECTED_MARKER_24", { status: 404 });
};

/**
 * A header the stored server config carries. Its value must never be
 * repeated by a hosted response; its name may be.
 */
const CONFIGURED_HEADERS = { "X-Tenant-Context": "UNEXPECTED_MARKER_38" };

function authorizeResponse(url: string): Response {
  return json({
    authorized: true,
    role: "member",
    accessLevel: "project_member",
    permissions: { chatOnly: false },
    serverConfig: {
      transportType: "http",
      url,
      useOAuth: false,
      headers: CONFIGURED_HEADERS,
    },
  });
}

function authorizeBatchResponse(url: string): Response {
  return json({
    results: {
      srv_1: {
        ok: true,
        role: "member",
        accessLevel: "project_member",
        permissions: { chatOnly: false },
        serverConfig: {
          transportType: "http",
          url,
          headers: CONFIGURED_HEADERS,
        },
      },
    },
  });
}

type Routes = {
  web: Hono;
  v1: Hono;
};

/**
 * Import the routes under one mode. `HOSTED_MODE` is read when `server/config`
 * is first imported, so each mode needs a fresh module registry.
 */
async function loadRoutes(hosted: boolean): Promise<Routes> {
  process.env.VITE_MCPJAM_HOSTED_MODE = hosted ? "true" : "false";
  vi.resetModules();
  if (hosted) {
    // Fabricated test hostnames resolve nowhere; answer for them so the
    // hosted target check exercises its address rules.
    const guard = await import("../../../utils/hosted-egress-guard.js");
    guard.setEgressHostResolverForTests(async () => ["93.184.216.34"]);
  }
  const { default: serversRoutes } = await import("../servers.js");
  const { default: v1Routes } = await import("../../v1/index.js");
  const web = new Hono();
  web.route("/api/web/servers", serversRoutes);
  const v1 = new Hono();
  v1.route("/api/v1", v1Routes);
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

const webDoctor = (routes: Routes) =>
  post(routes.web, "/api/web/servers/doctor", {
    projectId: "prj_1",
    serverId: "srv_1",
  });
const v1Doctor = (routes: Routes) =>
  post(routes.v1, "/api/v1/projects/prj_1/servers/srv_1/doctor", {});
const webValidate = (routes: Routes) =>
  post(routes.web, "/api/web/servers/validate", {
    projectId: "prj_1",
    serverId: "srv_1",
  });
const v1Validate = (routes: Routes) =>
  post(routes.v1, "/api/v1/projects/prj_1/servers/srv_1/validate", {});

/** Every recorded probe answer: allowlisted headers, no body. */
function expectAnswersProjected(report: any) {
  const attempts = report.probe?.transport?.attempts ?? [];
  for (const attempt of attempts) {
    if (!attempt.response) continue;
    expect(attempt.response).not.toHaveProperty("body");
    expect(attempt.response.bodyOmitted).toBe(true);
    expect(attempt.response.statusText.length).toBeLessThanOrEqual(64);
    for (const header of Object.keys(attempt.response.headers)) {
      expect(ALLOWED_HEADERS.has(header)).toBe(true);
    }
  }
}

/** Every logged exchange in a hosted log envelope: allowlisted headers. */
function expectLogsProjected(body: any) {
  for (const event of body._httpLogs ?? []) {
    const response = event.exchange?.response;
    if (!response) continue;
    expect(response.statusText.length).toBeLessThanOrEqual(64);
    for (const header of Object.keys(response.headers)) {
      expect(ALLOWED_HEADERS.has(header)).toBe(true);
    }
  }
}

const originalFetch = global.fetch;
const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
const originalHostedMode = process.env.VITE_MCPJAM_HOSTED_MODE;

beforeEach(() => {
  vi.clearAllMocks();
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  serverUrlRef.current = SERVER_URL;
  process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/web/authorize")) {
      return authorizeResponse(serverUrlRef.current);
    }
    if (url.endsWith("/web/authorize-batch")) {
      return authorizeBatchResponse(serverUrlRef.current);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
  if (originalConvexHttpUrl === undefined) delete process.env.CONVEX_HTTP_URL;
  else process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
  if (originalHostedMode === undefined) {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
  } else {
    process.env.VITE_MCPJAM_HOSTED_MODE = originalHostedMode;
  }
  vi.resetModules();
});

describe("hosted doctor responses (web and v1)", () => {
  let routes: Routes;

  beforeAll(async () => {
    routes = await loadRoutes(true);
  }, 60_000);

  for (const [surface, run] of [
    ["web", webDoctor],
    ["v1", v1Doctor],
  ] as const) {
    it(`${surface}: omits arbitrary HTML and JSON answers`, async () => {
      for (const answer of [
        htmlAnswer,
        jsonPayloadAnswer,
        jsonRpcErrorAnswer,
      ]) {
        upstream.current = answer;
        const res = await run(routes);
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(JSON.stringify(body)).not.toMatch(MARKER);
        expect(body.probe.transport.attempts.length).toBeGreaterThan(0);
        expectAnswersProjected(body);
        expect(body).not.toHaveProperty("_rpcLogs");
      }
    });

    it(`${surface}: reports a valid MCP server's protocol version, identity and capabilities`, async () => {
      upstream.current = mcpServer();
      const res = await run(routes);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).not.toMatch(MARKER);
      expectAnswersProjected(body);

      expect(body.status).toBe("ready");
      expect(body.probe.status).toBe("ready");
      const initialize = body.probe.transport.attempts.find(
        (attempt: any) => attempt.name === "streamable_initialize",
      );
      expect(initialize.response.projection).toMatchObject({
        kind: "initialize_result",
        protocolVersion: "2025-06-18",
        serverInfo: { name: "fixture-server", version: "1.0.0" },
        capabilities: { tools: true },
      });
      expect(body.probe.initialize).toMatchObject({
        protocolVersion: "2025-06-18",
        serverInfo: { name: "fixture-server", version: "1.0.0" },
      });
      expect(body.connection.status).toBe("connected");
      expect(body.initInfo).toMatchObject({
        protocolVersion: "2025-06-18",
        serverVersion: { name: "fixture-server", version: "1.0.0" },
        serverCapabilities: { tools: { listChanged: true } },
      });
      expect(body.capabilities).toEqual({ tools: { listChanged: true } });
      expect(body.initInfo).not.toHaveProperty("instructions");
      for (const attempt of body.probe.transport.attempts) {
        expect(attempt.request.headers["x-tenant-context"]).toBe("<redacted>");
      }
      expect(body.checks.tools).toEqual({
        status: "ok",
        detail: "0 tools discovered.",
      });
    });

    it(`${surface}: reports OAuth discovery URLs and projected metadata`, async () => {
      upstream.current = oauthServer;
      const res = await run(routes);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).not.toMatch(MARKER);
      expectAnswersProjected(body);

      expect(body.status).toBe("oauth_required");
      expect(body.probe.oauth).toMatchObject({
        required: true,
        wwwAuthenticate: `Bearer resource_metadata="${PRM_URL}"`,
        resourceMetadataUrl: PRM_URL,
        resourceMetadata: {
          resource: SERVER_URL,
          authorization_servers: [ISSUER],
          scopes_supported: ["read", "write"],
        },
        authorizationServerMetadataUrl: ASM_URL,
        authorizationServerMetadata: {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          registration_endpoint: `${ISSUER}/register`,
          code_challenge_methods_supported: ["S256"],
        },
      });
      expect(body.probe.oauth.registrationStrategies).toContain("dcr");
      expect(body.error).toMatchObject({
        code: "OAUTH_REQUIRED",
        details: {
          authorizationServerMetadataUrl: ASM_URL,
          resourceMetadataUrl: PRM_URL,
        },
      });
    });

    it(`${surface}: reports MCP list results through their projection`, async () => {
      upstream.current = listingServer();
      const res = await run(routes);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).not.toMatch(MARKER);

      expect(body.tools).toEqual([
        {
          name: "search",
          title: "Search",
          description: "Finds matching records.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: "large",
          description: "d".repeat(4096),
          descriptionTruncated: true,
          inputSchemaOmitted: true,
        },
      ]);
      expect(body.toolsMetadata).toEqual({});
      expect(body.resources).toEqual([
        {
          uri: "file:///notes.txt",
          name: "notes",
          description: "Team notes.",
          mimeType: "text/plain",
        },
      ]);
      expect(body.resourceTemplates).toEqual([
        {
          uriTemplate: "file:///{path}",
          name: "file",
          description: "A file by path.",
        },
      ]);
      expect(body.prompts).toEqual([
        {
          name: "summarize",
          description: "Summarizes text.",
          arguments: [{ name: "text", required: true }],
        },
      ]);
      expect(body.checks.tools).toEqual({
        status: "ok",
        detail: "2 tools discovered.",
      });
      expect(body).not.toHaveProperty("truncated");
    });

    it(`${surface}: bounds an oversized answer's status text and headers`, async () => {
      upstream.current = oversizedAnswer;
      const res = await run(routes);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).not.toMatch(MARKER);
      expectAnswersProjected(body);
      const answered = body.probe.transport.attempts.find(
        (attempt: any) => attempt.response?.status === 500,
      );
      expect(answered.response.statusText).toMatch(/^Internal x+$/);
    });
  }

  it("web: caps a long tool list and says how much it left out", async () => {
    upstream.current = listingServer(
      Array.from({ length: 600 }, (_, index) => ({
        name: index >= 500 ? `UNEXPECTED_MARKER_${index}` : `tool${index}`,
        inputSchema: { type: "object" },
      })),
    );
    const res = await webDoctor(routes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(JSON.stringify(body)).not.toMatch(MARKER);
    expect(body.tools).toHaveLength(500);
    expect(body.truncated).toEqual({ tools: { returned: 500, omitted: 100 } });
    expect(body.checks.tools.detail).toBe("600 tools discovered.");
  });

  it("web: keeps the doctor's list failure out of its summary text", async () => {
    upstream.current = mcpServer(
      () =>
        new Response("<html>UNEXPECTED_MARKER_25</html>", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "content-type": "text/html" },
        }),
    );
    const res = await webDoctor(routes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(JSON.stringify(body)).not.toMatch(MARKER);
    expect(body.connection.status).toBe("connected");
    expect(body.checks.tools.status).toBe("error");
    expect(body.checks.tools.detail).toMatch(/^Listing tools failed\./);
  });
});

describe("hosted validate responses (web and v1)", () => {
  let routes: Routes;

  beforeAll(async () => {
    routes = await loadRoutes(true);
  }, 60_000);

  it("web: reports the status line of an arbitrary HTML or JSON answer", async () => {
    for (const answer of [htmlAnswer, jsonPayloadAnswer]) {
      upstream.current = answer;
      const res = await webValidate(routes);
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).not.toMatch(MARKER);
      expect(body.message).toBe(
        "The MCP server responded with HTTP 200, but not with a valid MCP response.",
      );
      expect(body.normalized?.rawMessage).toBe(body.message);
      expectLogsProjected(body);
      const requestHeaders = (body._httpLogs ?? []).map(
        (event: any) => event.exchange.request.headers,
      );
      expect(requestHeaders.length).toBeGreaterThan(0);
      for (const headers of requestHeaders) {
        expect(headers["x-tenant-context"]).toBe("<redacted>");
      }
    }
  });

  it("web: keeps JSON-RPC error text and data out of the error and its logs", async () => {
    upstream.current = jsonRpcErrorAnswer;
    const res = await webValidate(routes);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as any;
    expect(JSON.stringify(body)).not.toMatch(MARKER);
    expect(body.message).toMatch(/^The MCP server responded with HTTP \d{3}/);
    expectLogsProjected(body);
  });

  it("web: reports a failure after initialize by its status line", async () => {
    upstream.current = mcpServer(
      () =>
        new Response("<html>UNEXPECTED_MARKER_25</html>", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "content-type": "text/html" },
        }),
    );
    const res = await webValidate(routes);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as any;
    // The initialize result that preceded the failure is in the frame log
    // only as its envelope.
    expect(JSON.stringify(body)).not.toMatch(MARKER);
    expect(body.message).toBe(
      "The MCP server responded with HTTP 500 Internal Server Error.",
    );
    const received = (body._rpcLogs ?? []).filter(
      (event: any) => event.direction === "receive",
    );
    for (const event of received) {
      expect(event.message).not.toHaveProperty("result");
    }
  });

  it("web: bounds an oversized answer's status text", async () => {
    upstream.current = oversizedAnswer;
    const res = await webValidate(routes);
    const body = (await res.json()) as any;
    expect(JSON.stringify(body)).not.toMatch(MARKER);
    expect(body.message).toMatch(
      /^The MCP server responded with HTTP 500 Internal x+\.$/,
    );
    expectLogsProjected(body);
  });

  it("web: answers 400 for a target the hosted inspector will not dial", async () => {
    serverUrlRef.current = "http://10.0.0.5/mcp";
    upstream.current = htmlAnswer;
    const res = await webValidate(routes);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toMatch(/private or internal address/);
  });

  it("v1: reports the status line in place of the answer", async () => {
    upstream.current = oversizedAnswer;
    const res = await v1Validate(routes);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as any;
    expect(JSON.stringify(body)).not.toMatch(MARKER);
    expect(body.message).toMatch(
      /^The MCP server responded with HTTP 500(?: Internal x+)?\.$/,
    );
  });

  it.each([
    ["HTML", htmlAnswer],
    ["non-JSON-RPC JSON", jsonPayloadAnswer],
    [
      "malformed JSON",
      fixedAnswer(
        () =>
          new Response("{UNEXPECTED_MARKER_60", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    ],
    [
      "malformed event stream",
      fixedAnswer(
        () =>
          new Response("data: {UNEXPECTED_MARKER_61\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    ],
  ])(
    "v1: reports a non-MCP HTTP 200 %s answer by its status line",
    async (_kind, answer) => {
      upstream.current = answer;
      const res = await v1Validate(routes);
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).not.toMatch(MARKER);
      expect(body.message).toBe(
        "The MCP server responded with HTTP 200, but not with a valid MCP response.",
      );
    },
  );

  it.each([
    ["web", webValidate],
    ["v1", v1Validate],
  ])(
    "%s: returns a successful connection's initialization info through its projection",
    async (_surface, validate) => {
      upstream.current = async (request) => {
        const message = await readMessage(request.clone());
        if (message?.method === "initialize") {
          return json(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {
                  tools: { listChanged: true, extra: "UNEXPECTED_MARKER_50" },
                  experimental: { nested: { deep: "UNEXPECTED_MARKER_51" } },
                },
                serverInfo: {
                  name: "fixture-server",
                  version: "1.0.0",
                  websiteUrl: "https://mcp.example.test/about",
                  extra: "UNEXPECTED_MARKER_52",
                },
                instructions: `Use search first.${"i".repeat(10_000)}`,
              },
            },
            { headers: { "mcp-session-id": "session-1" } },
          );
        }
        return mcpServer()(request);
      };
      const res = await validate(routes);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const initInfo = body.initInfo;
      expect(JSON.stringify(body)).not.toMatch(MARKER);
      expect(initInfo).toMatchObject({
        protocolVersion: "2025-06-18",
        serverCapabilities: { tools: { listChanged: true } },
        serverVersion: {
          name: "fixture-server",
          version: "1.0.0",
          websiteUrl: "https://mcp.example.test/about",
        },
      });
      expect(initInfo.instructions).toMatch(/^Use search first\.i+$/);
      expect(initInfo.instructions).toHaveLength(8192);
    },
  );

  it("v1: answers 400 for a target the hosted inspector will not dial", async () => {
    serverUrlRef.current = "http://10.0.0.5/mcp";
    upstream.current = htmlAnswer;
    const res = await v1Validate(routes);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

describe("local doctor and validate responses", () => {
  let routes: Routes;

  beforeAll(async () => {
    routes = await loadRoutes(false);
  }, 60_000);

  it("doctor: returns the probe's recorded answers unchanged", async () => {
    upstream.current = jsonPayloadAnswer;
    const res = await webDoctor(routes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const initialize = body.probe.transport.attempts.find(
      (attempt: any) => attempt.name === "streamable_initialize",
    );
    expect(initialize.response.body).toEqual({
      jsonrpc: "2.0",
      payload: "UNEXPECTED_MARKER_4",
    });
    expect(initialize.response.headers["x-extra"]).toBe("UNEXPECTED_MARKER_5");
    expect(initialize.response).not.toHaveProperty("bodyOmitted");
    expect(initialize.request.headers["x-tenant-context"]).toBe(
      "UNEXPECTED_MARKER_38",
    );
  });

  it("doctor: returns MCP list results unchanged", async () => {
    upstream.current = listingServer();
    const res = await webDoctor(routes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.toolsMetadata).toEqual({
      search: { note: "UNEXPECTED_MARKER_28" },
    });
    const large = body.tools.find((tool: any) => tool.name === "large");
    expect(large.description).toBe(`${"d".repeat(6000)}UNEXPECTED_MARKER_30`);
    expect(large.inputSchema.properties.blob.description).toContain(
      "UNEXPECTED_MARKER_31",
    );
    expect(body).not.toHaveProperty("truncated");
  });

  it("validate: keeps the connection failure's own text", async () => {
    upstream.current = mcpServer(
      () =>
        new Response("<html>UNEXPECTED_MARKER_25</html>", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "content-type": "text/html" },
        }),
    );
    const res = await webValidate(routes);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as any;
    expect(body.message).toContain("UNEXPECTED_MARKER_25");
  });
});
