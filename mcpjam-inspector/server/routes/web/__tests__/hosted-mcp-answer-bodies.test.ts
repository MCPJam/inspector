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
 * MJ-001: hosted MCP connections read an answer as MCP and nothing else.
 *
 * Covers the transport rule itself, a client manager built on the hosted
 * transport (the one chat turns, eval runs and agent surfaces use), and the
 * hosted conformance routes, against an in-process upstream in place of the
 * pinned socket. `UNEXPECTED_MARKER_*` strings sit in every body and header the
 * upstream sends, and in a header of the stored server config.
 */

type Upstream = (request: Request) => Response | Promise<Response>;

const { upstream } = vi.hoisted(() => ({
  upstream: { current: undefined as Upstream | undefined },
}));

vi.mock("../../../utils/pinned-fetch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/pinned-fetch.js")>();
  return {
    ...actual,
    createStreamingPinnedFetch: () =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!upstream.current) throw new Error("No upstream configured.");
        return upstream.current(new Request(input, init));
      }) as typeof fetch,
  };
});

const MARKER = /UNEXPECTED_MARKER/;
const SERVER_URL = "https://mcp.example.test/mcp";
const CONFIGURED_HEADERS = { "X-Tenant-Secret": "UNEXPECTED_MARKER_CONFIG" };

function htmlPage(): Response {
  return new Response("<html><body>UNEXPECTED_MARKER_BODY</body></html>", {
    status: 405,
    headers: {
      "content-type": "text/html",
      "x-upstream-trace": "UNEXPECTED_MARKER_HEADER",
    },
  });
}

const htmlRejection: Upstream = () => htmlPage();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A working MCP server whose `tools/call` answers `toolCall`. */
function mcpServer(toolCall: () => Response): Upstream {
  return async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = (await request.json().catch(() => undefined)) as any;
    if (message?.method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        },
      });
    }
    if (message?.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{ name: "search", inputSchema: { type: "object" } }],
        },
      });
    }
    if (message.method === "tools/call") return toolCall();
    return json({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  };
}

const originalHostedMode = process.env.VITE_MCPJAM_HOSTED_MODE;
const originalFetch = global.fetch;
const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

async function loadHosted() {
  process.env.VITE_MCPJAM_HOSTED_MODE = "true";
  vi.resetModules();
  const guard = await import("../../../utils/hosted-egress-guard.js");
  guard.setEgressHostResolverForTests(async () => ["93.184.216.34"]);
  return {
    baseFetch: await import("../../../utils/hosted-mcp-base-fetch.js"),
    sdk: await import("@mcpjam/sdk"),
  };
}

afterAll(() => {
  global.fetch = originalFetch;
  if (originalHostedMode === undefined) {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
  } else {
    process.env.VITE_MCPJAM_HOSTED_MODE = originalHostedMode;
  }
  if (originalConvexHttpUrl === undefined) delete process.env.CONVEX_HTTP_URL;
  else process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
  vi.resetModules();
});

describe("withHostedMcpAnswerBodies", () => {
  let wrap: (fetchFn: typeof fetch) => typeof fetch;

  beforeAll(async () => {
    ({ withHostedMcpAnswerBodies: wrap } = (await loadHosted()).baseFetch);
  }, 60_000);

  const answer = (response: Response) =>
    wrap((async () => response) as typeof fetch)(SERVER_URL, {
      method: "POST",
    });

  it.each([
    ["an HTML error page", htmlPage()],
    [
      "a JSON error that is not JSON-RPC",
      json({ detail: "UNEXPECTED_MARKER_DETAIL" }, 500),
    ],
    [
      "a successful JSON answer that does not parse",
      new Response("<html>UNEXPECTED_MARKER_JSON</html>", {
        headers: { "content-type": "application/json" },
      }),
    ],
  ])("empties %s and keeps its status line", async (_kind, response) => {
    const status = response.status;
    const answered = await answer(response);
    expect(answered.status).toBe(status);
    expect(await answered.text()).toBe("");
  });

  it("keeps a JSON-RPC error answer", async () => {
    const error = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32020, message: "Header mismatch" },
    };
    const answered = await answer(json(error, 400));
    expect(answered.status).toBe(400);
    expect(await answered.json()).toEqual(error);
  });

  it("keeps a successful JSON answer and an event stream as they are", async () => {
    const result = { jsonrpc: "2.0", id: 1, result: {} };
    expect(await (await answer(json(result))).json()).toEqual(result);
    const stream = new Response("event: message\ndata: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    expect(await answer(stream)).toBe(stream);
  });

  it("answers a bodiless status without failing", async () => {
    const answered = await answer(
      new Response(null, {
        status: 204,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(answered.status).toBe(204);
  });

  it("keeps the answer's URL", async () => {
    const response = htmlPage();
    Object.defineProperty(response, "url", { value: SERVER_URL });
    expect((await answer(response)).url).toBe(SERVER_URL);
  });
});

describe("a client manager on the hosted transport", () => {
  let hosted: Awaited<ReturnType<typeof loadHosted>>;

  beforeAll(async () => {
    hosted = await loadHosted();
  }, 60_000);

  const manager = () =>
    new hosted.sdk.MCPClientManager(
      {
        srv: {
          url: SERVER_URL,
          requestInit: { headers: CONFIGURED_HEADERS },
        } as any,
      },
      {
        baseFetch: hosted.baseFetch.hostedMcpBaseFetch(),
        defaultTimeout: 5000,
      },
    );

  async function failure(
    run: (m: ReturnType<typeof manager>) => Promise<unknown>,
  ) {
    const m = manager();
    try {
      await run(m);
    } catch (error) {
      return error;
    } finally {
      await m.disconnectAllServers().catch(() => undefined);
    }
    throw new Error("expected a failure");
  }

  function chainText(error: unknown): string {
    const texts: string[] = [];
    let current: any = error;
    for (let depth = 0; current && depth < 8; depth += 1) {
      texts.push(String(current.message));
      if (current.streamableCause)
        texts.push(String(current.streamableCause.message));
      current = current.cause;
    }
    return texts.join("\n");
  }

  it("fails a connection to a server that is not MCP without its answer", async () => {
    upstream.current = htmlRejection;
    const error = await failure((m) => m.getToolsForAiSdk(["srv"]));
    expect(chainText(error)).not.toMatch(MARKER);
  });

  it.each([
    ["an HTML error page", htmlPage],
    [
      // Short enough that a JSON parse error would quote all of it.
      "a JSON body that does not parse",
      () =>
        new Response("SECRET_7", {
          headers: { "content-type": "application/json" },
        }),
    ],
  ])(
    "fails a tool call answered with %s without its answer",
    async (_kind, toolCall) => {
      upstream.current = mcpServer(toolCall);
      const error = await failure((m) => m.executeTool("srv", "search", {}));
      expect(chainText(error)).not.toMatch(MARKER);
      expect(chainText(error)).not.toContain("SECRET_7");
    },
  );
});

describe("hosted conformance routes", () => {
  let app: Hono;

  beforeAll(async () => {
    await loadHosted();
    const { default: conformance } = await import("../conformance.js");
    app = new Hono();
    app.route("/api/web/conformance", conformance);
  }, 60_000);

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/web/authorize")) {
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
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  });

  it.each(["protocol", "apps"])(
    "%s: reports a server that is not MCP without its answer",
    async (suite) => {
      upstream.current = htmlRejection;
      const response = await app.request(`/api/web/conformance/${suite}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({ projectId: "prj_1", serverId: "srv_1" }),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(text).result).toBeDefined();
      expect(text).not.toMatch(MARKER);
    },
  );
});
