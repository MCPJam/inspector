import { Hono } from "hono";
import { cors } from "hono/cors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createStaticConnectorResolver,
  type WebConnector,
} from "../connectors.js";
import {
  createWebConnectorEndpoint,
  mountWebConnectorEndpoint,
  type WebConnectorEndpointDeps,
} from "../forwarding-endpoint.js";
import type { WebClientRecorder } from "../forwarding-recorder.js";
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
      },
    },
  ]);
  const turns = createInMemoryTurnWindowStore();
  const ledger = createInMemoryToolCallLedger();
  const frames: Parameters<WebClientRecorder["frame"]>[0][] = [];
  const clients: Parameters<WebClientRecorder["client"]>[0][] = [];
  const endpoint = createWebConnectorEndpoint({
    resolver: { ...base, mayUse: async () => options.mayUse ?? true },
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
      new Set([`web-client:outside-turn:${CONNECTOR_ID}`]),
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
    expect(await response.json()).toMatchObject({ id: 11, error: { code: -32000 } });
    expect(down.ledger.forTurn(downWindow.turnId)).toEqual([
      expect.objectContaining({ toolUseId: "toolu_11", state: "lost" }),
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

    const broken = setup({
      deps: {
        recorder: {
          frame: () => {
            throw new Error("sink down");
          },
          client: () => {
            throw new Error("sink down");
          },
        },
      },
    });
    const response = await vendorClient(broken.app, { path: PATH }).listTools();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 2, result: {} });
  });

  it("answers 404 for an unknown connector or with the flag off, and the server receives nothing", async () => {
    const { app } = setup();
    expect((await vendorClient(app, { path: "/mcp/nope" }).initialize()).status).toBe(404);
    const off = setup({ deps: { isEnabled: async () => false } });
    expect((await vendorClient(off.app, { path: PATH }).initialize()).status).toBe(404);
    expect(fixture.received).toHaveLength(0);
  });
});

describe("forwarding endpoint: OAuth", () => {
  const verifyBearer = vi.fn(async (token: string) =>
    token === "good-token" ? { userId: "user_01" } : undefined,
  );

  it("answers 401 with the protected-resource metadata URL, and serves that metadata", async () => {
    const { app } = setup({ auth: "oauth", deps: { verifyBearer } });
    const bare = await vendorClient(app, { path: PATH }).initialize();
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource${PATH}"`,
    );
    const invalid = await vendorClient(app, { path: PATH, token: "bad" }).initialize();
    expect(invalid.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const metadata = await app.request(
      `http://inspector.example.test/.well-known/oauth-protected-resource${PATH}`,
      { headers: { "x-forwarded-proto": "https" } },
    );
    expect(await metadata.json()).toEqual({
      resource: `${ORIGIN}${PATH}`,
      authorization_servers: ["https://auth.example.test"],
      bearer_methods_supported: ["header"],
    });
    expect(headerNames(metadata)).toEqual(["content-type"]);
    const root = await app.request(`${ORIGIN}/.well-known/oauth-protected-resource`);
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
});
