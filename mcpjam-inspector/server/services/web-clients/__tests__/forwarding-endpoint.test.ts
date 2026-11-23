import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createStaticConnectorResolver,
  type UpstreamTarget,
  type WebConnector,
} from "../connectors.js";
import {
  createWebConnectorEndpoint,
  mountWebConnectorEndpoint,
  type WebConnectorEndpointDeps,
} from "../forwarding-endpoint.js";
import {
  webClientScope,
  type WebClientRecorder,
} from "../forwarding-recorder.js";
import { createStreamingPinnedFetch } from "../../../utils/pinned-fetch.js";
import {
  createInMemoryToolCallLedger,
  hashPayload,
} from "../tool-call-ledger.js";
import {
  createInMemoryTurnWindowStore,
  type ToolCallRequest,
} from "../turn-windows.js";
import {
  ORIGIN,
  SESSION_ID,
  startFixtureServer,
  vendorClient,
} from "./forwarding-fixtures.js";

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await fixture.close();
});

const CONNECTOR_ID = "conn_9f3b2c7d1e";
const PATH = `/mcp/${CONNECTOR_ID}`;
const PROJECT_CREDENTIAL = "Bearer project-credential";

/** The Inspector's global stack, as far as the vendor could see it. */
function withGlobalHeaders(app: Hono) {
  app.use("*", async (c, next) => {
    c.header("X-Frame-Options", "SAMEORIGIN");
    c.header("X-Robots-Tag", "noindex");
    c.header("x-request-id", "req-1");
    await next();
  });
  app.use("*", cors({ origin: "http://localhost:6274" }));
  app.all("*", (c) => c.text("app shell"));
}

function setup(
  options: {
    auth?: WebConnector["auth"];
    upstreamUrl?: string;
    upstream?: Partial<UpstreamTarget>;
    /** Runs while the endpoint resolves the project's server. */
    resolving?: () => void;
    deps?: Partial<WebConnectorEndpointDeps>;
    mayUse?: boolean;
  } = {},
) {
  const connector: WebConnector = {
    connectorId: CONNECTOR_ID,
    projectId: "proj_1",
    organizationId: "org_1",
    serverId: "srv_1",
    auth: options.auth ?? "capability",
  };
  const base = createStaticConnectorResolver([
    {
      connector,
      upstream: {
        url: options.upstreamUrl ?? fixture.url,
        headers: { authorization: PROJECT_CREDENTIAL, "x-api-key": "project-key" },
        ...options.upstream,
      },
    },
  ]);
  const upstream: typeof base.upstream = async (...args) => {
    options.resolving?.();
    return base.upstream(...args);
  };
  const turns = createInMemoryTurnWindowStore();
  const ledger = createInMemoryToolCallLedger();
  const frames: Parameters<WebClientRecorder["frame"]>[0][] = [];
  const clients: Parameters<WebClientRecorder["client"]>[0][] = [];
  const endpoint = createWebConnectorEndpoint({
    resolver: { ...base, upstream, mayUse: async () => options.mayUse ?? true },
    turns,
    ledger,
    recorder: {
      frame: (frame) => frames.push(frame),
      client: (identity) => clients.push(identity),
    },
    authorizationServers: () => ["https://auth.example.test"],
    isEnabled: async () => true,
    ...options.deps,
  });
  const app = new Hono();
  mountWebConnectorEndpoint(app, endpoint);
  withGlobalHeaders(app);
  fixture.received.length = 0;
  const approvals: ToolCallRequest[] = [];
  const openTurn = (allow = true) =>
    turns.open({
      connectorId: CONNECTOR_ID,
      runId: "run_1",
      approve: async (call) => {
        approvals.push(call);
        return allow
          ? { allow: true as const }
          : {
              allow: false as const,
              reason:
                "The approval policy blocks echo. Allow it in MCPJam, then send the prompt again.",
            };
      },
    });
  return { app, turns, ledger, frames, clients, approvals, openTurn };
}

function headerNames(response: Response): string[] {
  const names: string[] = [];
  response.headers.forEach((_value, name) => names.push(name));
  return names.sort();
}

const toolCalls = () =>
  fixture.received.filter((request) =>
    request.body.toString("utf8").includes('"tools/call"'),
  );

describe("forwarding endpoint: the turn gate", () => {
  it("lets initialize and tools/list through outside a turn but refuses a tool call, which never reaches the server", async () => {
    const { app, ledger, frames } = setup();
    const vendor = vendorClient(app, { path: PATH });
    expect((await vendor.initialize()).status).toBe(200);
    expect((await vendor.initialized()).status).toBe(202);
    expect(await (await vendor.listTools()).json()).toMatchObject({
      id: 2,
      result: { tools: [{ name: "echo" }] },
    });

    const refused = await vendor.post(vendor.callToolRaw(3, "echo", "hi"));
    expect(refused.status).toBe(200);
    const body = await refused.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 3, error: { code: -32000 } });
    expect(body.error.message).toMatch(/^No MCPJam run is using this connector/);
    expect(toolCalls()).toHaveLength(0);
    expect(fixture.received).toHaveLength(3);
    expect(ledger.find({ connectorId: CONNECTOR_ID })).toHaveLength(0);
    expect(new Set(frames.map((frame) => frame.scopeId))).toEqual(
      new Set([webClientScope(CONNECTOR_ID)]),
    );
  });

  it("forwards an approved call byte for byte with the project's credential and settles the ledger", async () => {
    const { app, ledger, frames, approvals, openTurn } = setup();
    const window = openTurn();
    const vendor = vendorClient(app, { path: PATH, token: "vendor-token" });
    // Frames are recorded as the vendor reads them, so read this one too.
    await (await vendor.initialize()).text();
    const raw = vendor.callToolRaw(3, "echo", "hi ☃");
    const response = await vendor.post(raw);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "echo: hi ☃" }] },
    });

    const [call] = toolCalls();
    expect(call?.body.equals(Buffer.from(raw, "utf8"))).toBe(true);
    expect(call?.headers).toMatchObject({
      authorization: PROJECT_CREDENTIAL,
      "x-api-key": "project-key",
      "user-agent": "Claude-User",
      "mcp-session-id": SESSION_ID,
      "mcp-protocol-version": "2025-11-25",
    });
    expect(approvals).toEqual([
      {
        connectorId: CONNECTOR_ID,
        turnId: window.turnId,
        jsonrpcId: 3,
        toolName: "echo",
        arguments: { message: "hi ☃" },
        toolUseId: "toolu_3",
      },
    ]);
    expect(ledger.forTurn(window.turnId)).toEqual([
      expect.objectContaining({
        runId: "run_1",
        toolName: "echo",
        toolUseId: "toolu_3",
        argsHash: hashPayload({ message: "hi ☃" }),
        state: "result",
        upstreamStatus: 200,
        resultHash: hashPayload({
          content: [{ type: "text", text: "echo: hi ☃" }],
        }),
      }),
    ]);
    const turnFrames = frames.filter(
      (frame) => frame.scopeId === `web-client:${window.turnId}`,
    );
    expect(turnFrames.map((frame) => frame.direction)).toEqual([
      "send",
      "receive",
      "send",
      "receive",
    ]);
  });

  it("refuses a denied call with the approval's reason, and the server receives nothing", async () => {
    const { app, ledger, openTurn } = setup();
    openTurn(false);
    const vendor = vendorClient(app, { path: PATH });
    const response = await vendor.post(vendor.callToolRaw(4, "echo", "no"));
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: {
        code: -32000,
        message:
          "The approval policy blocks echo. Allow it in MCPJam, then send the prompt again.",
      },
    });
    expect(fixture.received).toHaveLength(0);
    expect(ledger.find({ connectorId: CONNECTOR_ID })).toHaveLength(0);
  });

  it("holds a whole batch when one of its calls is refused, and forwards an approved batch unchanged", async () => {
    const { app, openTurn, turns } = setup();
    const vendor = vendorClient(app, { path: PATH, protocolVersion: "2025-03-26" });
    const batch = `[{"jsonrpc":"2.0","id":7,"method":"tools/list"},${vendor.callToolRaw(8, "echo", "b")}]`;
    const refused = await (await vendor.post(batch)).json();
    expect(refused.map((answer: { id: number }) => answer.id)).toEqual([7, 8]);
    expect(refused[0].error.message).toMatch(/same batch was refused/);
    expect(fixture.received).toHaveLength(0);

    const window = openTurn();
    const answered = await (await vendor.post(batch)).json();
    expect(answered).toMatchObject([{ id: 7, result: {} }, { id: 8, result: {} }]);
    expect(fixture.received[0]?.body.toString("utf8")).toBe(batch);
    turns.close(window.turnId);
  });

  it("refuses a body whose Mcp-Name header names another tool than it calls", async () => {
    const { app, openTurn } = setup();
    openTurn();
    const vendor = vendorClient(app, { path: PATH, protocolVersion: "2026-07-28" });
    const response = await vendor.post(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: {},
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      },
      { "mcp-method": "tools/call", "mcp-name": "harmless" },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32020);
    expect(fixture.received).toHaveLength(0);
  });

  it("refuses a tool call with an argument JSON.parse would round, so approval can't see another value", async () => {
    const { app, approvals, openTurn } = setup();
    openTurn();
    const response = await vendorClient(app, { path: PATH }).post(
      '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"echo","arguments":{"account":9007199254740993}}}',
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({
      code: -32602,
      message: expect.stringMatching(
        /^This tool call has a number MCPJam can't check exactly/,
      ),
    });
    expect(approvals).toHaveLength(0);
    expect(fixture.received).toHaveLength(0);
  });

  it("refuses a request from another site's page before it reaches the server, and takes the vendor's own", async () => {
    const { app, openTurn } = setup();
    openTurn();
    const vendor = vendorClient(app, { path: PATH });
    const refused = await vendor.post(vendor.callToolRaw(7, "echo", "o"), {
      origin: "https://attacker.example",
    });
    expect(refused.status).toBe(403);
    expect(fixture.received).toHaveLength(0);
    const fromVendor = await vendor.post(vendor.callToolRaw(8, "echo", "o"), {
      origin: "https://claude.ai",
    });
    expect(fromVendor.status).toBe(200);
    expect(toolCalls()).toHaveLength(1);
  });
});

describe("forwarding endpoint: answers", () => {
  it("streams an SSE answer through unchanged and settles the ledger from inside the stream", async () => {
    const { app, ledger, openTurn } = setup();
    const window = openTurn();
    const vendor = vendorClient(app, { path: PATH });
    const response = await vendor.post(vendor.callToolRaw(9, "stream", "s"));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(fixture.lastStream());
    expect(ledger.forTurn(window.turnId)).toEqual([
      expect.objectContaining({ toolUseId: "toolu_9", state: "result" }),
    ]);
  });

  it("settles a call as lost when the stream ends before the answer, or the server can't be reached", async () => {
    const cut = setup();
    const cutWindow = cut.openTurn();
    const vendor = vendorClient(cut.app, { path: PATH });
    await (await vendor.post(vendor.callToolRaw(10, "cut", "c"))).text();
    expect(cut.ledger.forTurn(cutWindow.turnId)[0]?.state).toBe("lost");

    const down = setup({ upstreamUrl: "http://127.0.0.1:9/mcp" });
    const downWindow = down.openTurn();
    const response = await vendorClient(down.app, { path: PATH }).post(
      vendor.callToolRaw(11, "echo", "d"),
    );
    expect(response.status).toBe(502);
    // Lost means it may have run, so the vendor is not told to just send it again.
    expect(await response.json()).toMatchObject({
      id: 11,
      error: {
        code: -32000,
        message: expect.stringMatching(/^MCPJam could not tell whether/),
      },
    });
    expect(down.ledger.forTurn(downWindow.turnId)).toEqual([
      expect.objectContaining({ toolUseId: "toolu_11", state: "lost" }),
    ]);
  });

  it("still relays an answer it can't record, and the call ends lost rather than open", async () => {
    // Nested deeper than the ledger's canonical hash can walk.
    const answer = `{"jsonrpc":"2.0","id":27,"result":${"[".repeat(20_000)}${"]".repeat(20_000)}}`;
    const { app, ledger, openTurn } = setup({
      upstream: {
        fetch: async () =>
          new Response(answer, {
            headers: { "content-type": "application/json" },
          }),
      },
    });
    const window = openTurn();
    const vendor = vendorClient(app, { path: PATH });
    const response = await vendor.post(vendor.callToolRaw(27, "echo", "deep"));
    expect(await response.text()).toBe(answer);
    expect(ledger.forTurn(window.turnId)).toEqual([
      expect.objectContaining({ state: "lost", upstreamStatus: 200 }),
    ]);
  });

  it("answers with only the upstream server's MCP headers, none of the Inspector's", async () => {
    const { app } = setup();
    const response = await vendorClient(app, { path: PATH }).initialize();
    expect(headerNames(response)).toEqual([
      "content-type",
      "mcp-session-id",
    ]);
    // The same app answers everything else with its own stack.
    const shell = await app.request(`${ORIGIN}/projects`);
    expect(shell.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("passes the 2026-07-28 shape unchanged: server/discover and per-request _meta, no initialize", async () => {
    const { app, clients, openTurn } = setup();
    const window = openTurn();
    const vendor = vendorClient(app, { path: PATH, protocolVersion: "2026-07-28" });
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.0" },
      "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
    };
    const discover = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: meta },
    });
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "m" }, _meta: meta },
    });
    expect(
      await (await vendor.post(discover, { "mcp-method": "server/discover" })).json(),
    ).toMatchObject({ id: 1, result: { supportedVersions: ["2026-07-28"] } });
    expect(
      await (
        await vendor.post(call, { "mcp-method": "tools/call", "mcp-name": "echo" })
      ).json(),
    ).toMatchObject({ id: 2, result: { content: [{ text: "echo: m" }] } });

    expect(fixture.received.map((request) => request.body.toString("utf8"))).toEqual([
      discover,
      call,
    ]);
    expect(fixture.received[1]?.headers).toMatchObject({
      "mcp-method": "tools/call",
      "mcp-name": "echo",
      "mcp-protocol-version": "2026-07-28",
    });
    expect(clients).toEqual([
      {
        connectorId: CONNECTOR_ID,
        scopeId: `web-client:${window.turnId}`,
        source: "request_meta",
        userAgent: "Claude-User",
        protocolVersion: "2026-07-28",
        clientInfo: { name: "claude-code", version: "2.1.0" },
        clientCapabilities: { elicitation: {} },
      },
      expect.objectContaining({ source: "request_meta" }),
    ]);
  });

  it("records the client from initialize, and a recording failure never fails the request", async () => {
    const { app, clients } = setup();
    await vendorClient(app, { path: PATH }).initialize();
    expect(clients).toEqual([
      expect.objectContaining({
        source: "initialize",
        userAgent: "Claude-User",
        clientInfo: { name: "claude-ai", version: "0.1.0" },
      }),
    ]);

    const client = vi.fn(() => {
      throw new Error("sink down");
    });
    const broken = setup({
      deps: {
        recorder: {
          frame: () => {
            throw new Error("sink down");
          },
          client,
        },
      },
    });
    const response = await vendorClient(broken.app, {
      path: PATH,
    }).initialize();
    expect(client).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 1, result: {} });
  });

  it("answers 404 for an unknown connector or with the flag off, and the server receives nothing", async () => {
    const { app } = setup();
    expect((await vendorClient(app, { path: "/mcp/nope" }).initialize()).status).toBe(404);
    expect(fixture.received).toHaveLength(0);
    const off = setup({ deps: { isEnabled: async () => false } });
    expect((await vendorClient(off.app, { path: PATH }).initialize()).status).toBe(404);
    expect(fixture.received).toHaveLength(0);
  });
});

describe("forwarding endpoint: sending", () => {
  const refused = () => new Response(null, { status: 401 });

  it("sends a call again with a refreshed credential after the server's own 401", async () => {
    const sent: Array<string | null> = [];
    const { app, ledger, openTurn } = setup({
      upstream: {
        fetch: async (input, init) => {
          const credential = new Headers(init?.headers).get("authorization");
          sent.push(credential);
          return credential === "Bearer fresh" ? fetch(input, init) : refused();
        },
        onUnauthorized: async () => "fresh",
      },
    });
    const window = openTurn();
    const vendor = vendorClient(app, { path: PATH });
    const response = await vendor.post(vendor.callToolRaw(20, "echo", "r"));
    expect(await response.json()).toMatchObject({ id: 20, result: {} });
    expect(sent).toEqual([PROJECT_CREDENTIAL, "Bearer fresh"]);
    expect(ledger.forTurn(window.turnId)[0]?.state).toBe("result");
  });

  it.each([
    ["fetch followed it", { redirected: { value: true } }],
    ["a guarded fetch followed it", { url: { value: `${ORIGIN}/status/21` } }],
  ])(
    "never sends a call again after a 401 behind a redirect (%s), and records it lost",
    async (_how, followed: PropertyDescriptorMap) => {
      const upstreamFetch = vi.fn(async () =>
        Object.defineProperties(refused(), followed),
      );
      const onUnauthorized = vi.fn(async () => "fresh");
      const { app, ledger, openTurn } = setup({
        upstream: { fetch: upstreamFetch, onUnauthorized },
      });
      const window = openTurn();
      const vendor = vendorClient(app, { path: PATH });
      const response = await vendor.post(vendor.callToolRaw(21, "echo", "x"));
      expect(response.status).toBe(502);
      expect((await response.json()).error.message).toMatch(
        /^MCPJam could not tell whether/,
      );
      expect(upstreamFetch).toHaveBeenCalledOnce();
      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(ledger.forTurn(window.turnId)).toEqual([
        expect.objectContaining({ state: "lost", upstreamStatus: 401 }),
      ]);
    },
  );

  it("refuses an approved call whose turn ended while the server was resolved, and releases it", async () => {
    const release = vi.fn(async () => undefined);
    let endTurn = () => {};
    const { app, ledger, openTurn, turns } = setup({
      upstream: { release },
      resolving: () => endTurn(),
    });
    const window = openTurn();
    endTurn = () => turns.close(window.turnId);
    const vendor = vendorClient(app, { path: PATH });
    const response = await vendor.post(vendor.callToolRaw(22, "echo", "late"));
    expect((await response.json()).error.message).toMatch(
      /^No MCPJam run is using this connector/,
    );
    expect(fixture.received).toHaveLength(0);
    expect(ledger.find({ connectorId: CONNECTOR_ID })).toHaveLength(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not send a call again when its turn ended during the credential refresh", async () => {
    const upstreamFetch = vi.fn(async () => refused());
    let endTurn = () => {};
    const { app, ledger, openTurn, turns } = setup({
      upstream: {
        fetch: upstreamFetch,
        onUnauthorized: async () => {
          endTurn();
          return "fresh";
        },
      },
    });
    const window = openTurn();
    endTurn = () => turns.close(window.turnId);
    const vendor = vendorClient(app, { path: PATH });
    const response = await vendor.post(vendor.callToolRaw(23, "echo", "r"));
    expect(response.status).toBe(200);
    expect((await response.json()).error.message).toMatch(
      /^No MCPJam run is using this connector/,
    );
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(ledger.forTurn(window.turnId)).toEqual([
      expect.objectContaining({ state: "error", upstreamStatus: 401 }),
    ]);
  });

  it("leaves a call unsent, not unknown, when the credential refresh fails", async () => {
    const upstreamFetch = vi.fn(async () => refused());
    const { app, ledger, openTurn } = setup({
      upstream: {
        fetch: upstreamFetch,
        onUnauthorized: async () => {
          throw new Error("The token endpoint did not answer.");
        },
      },
    });
    const window = openTurn();
    const vendor = vendorClient(app, { path: PATH });
    const response = await vendor.post(vendor.callToolRaw(24, "echo", "r"));
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toMatch(
      /^This project's MCP server refused MCPJam's saved credential/,
    );
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(ledger.forTurn(window.turnId)).toEqual([
      expect.objectContaining({ state: "error", upstreamStatus: 401 }),
    ]);
  });

  /** The hosted transport, which follows a redirect itself unless asked not to. */
  const hostedFetch = () =>
    createStreamingPinnedFetch({ hosted: true, allowLoopback: true });

  it("does not send a tool call on through a redirect once its turn has closed, and records it lost", async () => {
    const { app, ledger, openTurn, turns } = setup({
      upstreamUrl: fixture.redirectUrl(307),
      upstream: { fetch: hostedFetch() },
    });
    const window = openTurn();
    fixture.hooks.onRedirect = () => turns.close(window.turnId);
    try {
      const vendor = vendorClient(app, { path: PATH });
      const response = await vendor.post(
        vendor.callToolRaw(27, "echo", "moved"),
      );
      expect((await response.json()).error.message).toMatch(
        /^MCPJam could not tell whether/,
      );
    } finally {
      fixture.hooks.onRedirect = undefined;
    }
    expect(fixture.received.map((request) => request.url)).toEqual([
      "/redirect/307",
    ]);
    expect(ledger.forTurn(window.turnId)).toEqual([
      expect.objectContaining({ state: "lost", upstreamStatus: 307 }),
    ]);
  });

  it("follows a redirect with a tool call while its turn is open", async () => {
    const { app, ledger, openTurn } = setup({
      upstreamUrl: fixture.redirectUrl(308),
      upstream: { fetch: hostedFetch() },
    });
    const window = openTurn();
    const vendor = vendorClient(app, { path: PATH });
    const response = await vendor.post(vendor.callToolRaw(28, "echo", "moved"));
    expect(await response.json()).toMatchObject({
      id: 28,
      result: { content: [{ text: "echo: moved" }] },
    });
    expect(fixture.received.map((request) => request.url)).toEqual([
      "/redirect/308",
      "/mcp",
    ]);
    expect(fixture.received[1]?.headers.authorization).toBe(PROJECT_CREDENTIAL);
    expect(ledger.forTurn(window.turnId)[0]?.state).toBe("result");
  });

  it("keeps the server's own headers from another origin a redirect sends a request to", async () => {
    const other = await startFixtureServer();
    const { app } = setup({
      upstreamUrl: fixture.redirectUrl(307),
      upstream: { fetch: hostedFetch() },
    });
    fixture.hooks.redirectTo = other.url;
    try {
      const vendor = vendorClient(app, { path: PATH });
      const response = await vendor.listTools();
      expect(await response.json()).toMatchObject({ id: 2, result: {} });
      expect(other.received).toHaveLength(1);
      const { headers } = other.received[0]!;
      expect(headers["x-api-key"]).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers["content-type"]).toBe("application/json");
    } finally {
      fixture.hooks.redirectTo = undefined;
      await other.close();
    }
  });

  it("settles a call from the server's answer when the ledger refused it the first time", async () => {
    const inner = createInMemoryToolCallLedger();
    let attempts = 0;
    const { app, openTurn } = setup({
      deps: {
        ledger: {
          ...inner,
          settle: (id, outcome) => {
            attempts += 1;
            if (attempts === 1) throw new Error("ledger unavailable");
            inner.settle(id, outcome);
          },
        },
      },
    });
    const window = openTurn();
    const vendor = vendorClient(app, { path: PATH });
    const answer = await (
      await vendor.post(vendor.callToolRaw(29, "echo", "kept"))
    ).json();
    expect(answer).toMatchObject({ id: 29, result: {} });
    expect(inner.forTurn(window.turnId)).toEqual([
      expect.objectContaining({
        state: "result",
        upstreamStatus: 200,
        resultHash: hashPayload(answer.result),
      }),
    ]);
  });

  it("sends nothing, settles what it wrote and releases the server when the ledger fails partway through a batch", async () => {
    const release = vi.fn(async () => undefined);
    const ledger = createInMemoryToolCallLedger();
    let writes = 0;
    const { app, openTurn } = setup({
      upstream: { release },
      deps: {
        ledger: {
          ...ledger,
          forwarded: (entry) => {
            writes += 1;
            if (writes === 2) throw new Error("ledger unavailable");
            return ledger.forwarded(entry);
          },
        },
      },
    });
    const window = openTurn();
    const vendor = vendorClient(app, {
      path: PATH,
      protocolVersion: "2025-03-26",
    });
    const batch = `[${vendor.callToolRaw(24, "echo", "a")},${vendor.callToolRaw(25, "echo", "b")}]`;
    const answers = await (await vendor.post(batch)).json();
    expect(
      answers.map(
        (answer: { error: { message: string } }) => answer.error.message,
      ),
    ).toEqual([
      expect.stringMatching(/^MCPJam could not record this tool call/),
      expect.stringMatching(/^MCPJam could not record this tool call/),
    ]);
    expect(fixture.received).toHaveLength(0);
    expect(ledger.forTurn(window.turnId)).toEqual([
      expect.objectContaining({ jsonrpcId: 24, state: "error" }),
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("answers the server's 401 and settles the call even when its body already failed", async () => {
    const release = vi.fn(async () => undefined);
    const { app, ledger, openTurn } = setup({
      upstream: {
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection reset"));
              },
            }),
            { status: 401 },
          ),
        release,
      },
    });
    const window = openTurn();
    const vendor = vendorClient(app, { path: PATH });
    const response = await vendor.post(vendor.callToolRaw(26, "echo", "e"));
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toMatch(
      /refused MCPJam's saved credential/,
    );
    expect(ledger.forTurn(window.turnId)).toEqual([
      expect.objectContaining({ state: "error", upstreamStatus: 401 }),
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("forwarding endpoint: OAuth", () => {
  const verifyBearer = vi.fn(async (token: string) =>
    token === "good-token" ? { userId: "user_01" } : undefined,
  );
  // Connector URLs are published on ORIGIN, whatever Host a request names.
  beforeEach(() => {
    vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", ORIGIN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers 401 with the protected-resource metadata URL, and serves that metadata", async () => {
    const { app } = setup({ auth: "oauth", deps: { verifyBearer } });
    const bare = await vendorClient(app, { path: PATH }).initialize();
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource${PATH}"`,
    );
    const invalid = await vendorClient(app, { path: PATH, token: "bad" }).initialize();
    expect(invalid.headers.get("www-authenticate")).toContain('error="invalid_token"');

    // Both documents name the configured origin, not the Host asked for.
    const metadata = await app.request(
      `http://mcp.example.test/.well-known/oauth-protected-resource${PATH}`,
      { headers: { "x-forwarded-proto": "https" } },
    );
    expect(await metadata.json()).toEqual({
      resource: `${ORIGIN}${PATH}`,
      authorization_servers: ["https://auth.example.test"],
      bearer_methods_supported: ["header"],
    });
    expect(headerNames(metadata)).toEqual(["content-type"]);
    const root = await app.request(
      "https://mcp.example.test/.well-known/oauth-protected-resource",
    );
    expect((await root.json()).resource).toBe(`${ORIGIN}/mcp`);
    expect(fixture.received).toHaveLength(0);
  });

  it("accepts a valid bearer for this resource, forwards without it, and refuses a user who may not use the project", async () => {
    const { app } = setup({ auth: "oauth", deps: { verifyBearer } });
    const response = await vendorClient(app, { path: PATH, token: "good-token" }).initialize();
    expect(response.status).toBe(200);
    expect(verifyBearer).toHaveBeenCalledWith("good-token", {
      audiences: [`${ORIGIN}${PATH}`, `${ORIGIN}/mcp`],
    });
    expect(fixture.received[0]?.headers.authorization).toBe(PROJECT_CREDENTIAL);

    const outsider = setup({ auth: "oauth", mayUse: false, deps: { verifyBearer } });
    const refused = await vendorClient(outsider.app, {
      path: PATH,
      token: "good-token",
    }).initialize();
    expect(refused.status).toBe(403);
    expect(fixture.received).toHaveLength(0);
  });

  it("tells the approval and the ledger which member's token made each call", async () => {
    const { app, approvals, ledger, openTurn } = setup({
      auth: "oauth",
      deps: { verifyBearer: async (token) => ({ userId: `user_${token}` }) },
    });
    const window = openTurn();
    // Any member's token passes the gate, so a call under this run need not
    // be its owner's: the approval and the ledger see whose it was.
    for (const [id, member] of [
      [5, "a"],
      [6, "b"],
    ] as const) {
      const vendor = vendorClient(app, { path: PATH, token: member });
      const response = await vendor.post(
        vendor.callToolRaw(id, "echo", member),
      );
      expect(await response.json()).toMatchObject({ id, result: {} });
    }
    expect(approvals.map((call) => call.userId)).toEqual(["user_a", "user_b"]);
    const recorded = ledger.forTurn(window.turnId);
    expect(recorded.map((entry) => entry.userId)).toEqual(["user_a", "user_b"]);
  });

  it("serves no OAuth connector without a usable public URL, and capability connectors still forward", async () => {
    verifyBearer.mockClear();
    vi.stubEnv("BASE_URL", "");
    const status = async (app: Hono, token?: string) =>
      (await vendorClient(app, { path: PATH, token }).initialize()).status;
    // Unset, a bare host and a host with a port all give no http(s) origin.
    for (const configured of [
      "",
      "inspector.example.test",
      "inspector.example.test:443",
    ]) {
      vi.stubEnv("MCPJAM_INSPECTOR_PUBLIC_URL", configured);
      const { app } = setup({ auth: "oauth", deps: { verifyBearer } });
      expect(await status(app)).toBe(404);
      expect(await status(app, "good-token")).toBe(404);
      for (const metadata of [PATH, ""]) {
        const url = `${ORIGIN}/.well-known/oauth-protected-resource${metadata}`;
        expect((await app.request(url)).status).toBe(404);
      }
      expect(fixture.received).toHaveLength(0);
    }
    expect(verifyBearer).not.toHaveBeenCalled();
    expect(await status(setup().app)).toBe(200);
  });
});
