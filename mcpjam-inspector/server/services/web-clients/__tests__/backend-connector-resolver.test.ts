import { Hono } from "hono";
import { ConvexError } from "convex/values";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createBackendConnectorResolver,
  createBackendToolCallLedger,
  webClientService,
  type WebClientService,
} from "../backend-connector-resolver.js";
import {
  createStaticConnectorResolver,
  type WebConnector,
} from "../connectors.js";
import {
  createWebConnectorEndpoint,
  mountWebConnectorEndpoint,
} from "../forwarding-endpoint.js";
import {
  createInMemoryToolCallLedger,
  hashPayload,
} from "../tool-call-ledger.js";
import { createInMemoryTurnWindowStore } from "../turn-windows.js";
import { startFixtureServer, vendorClient } from "./forwarding-fixtures.js";

const authorize = vi.hoisted(() => vi.fn());
vi.mock("../../../routes/web/auth.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAuthorizedManager: authorize,
}));

const ROW = {
  connectorId: "5f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f",
  projectId: "proj_1",
  organizationId: "org_1",
  serverId: "srv_1",
  webAccountId: "acct_1",
  vendor: "claude",
  auth: "oauth",
} as const;
const HASH = "a".repeat(64);

type Command = Record<string, unknown>;

/** The backend's two service functions, answering from the test. */
function stubService(answers: {
  read?: (command: Command) => unknown;
  apply?: (command: Command) => unknown;
}) {
  const applied: Command[] = [];
  const service = {
    read: vi.fn(async (command: Command) => answers.read?.(command)),
    apply: vi.fn(async (command: Command) => {
      applied.push(command);
      return answers.apply?.(command);
    }),
  } satisfies WebClientService;
  return { service, applied };
}

const refusal = (code: string) => new ConvexError({ code });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("backend connector resolver", () => {
  it("maps resolveWebConnector to a connector and remembers an unknown id for a while", async () => {
    const { service } = stubService({
      read: (command) => (command.connectorId === ROW.connectorId ? ROW : null),
    });
    const resolver = createBackendConnectorResolver(service);
    expect(await resolver.resolve(ROW.connectorId)).toEqual(ROW);
    expect(service.read).toHaveBeenCalledWith({
      action: "resolveWebConnector",
      connectorId: ROW.connectorId,
    });
    expect(await resolver.resolve("nope")).toBeUndefined();
    expect(await resolver.resolve("nope")).toBeUndefined();
    expect(service.read).toHaveBeenCalledTimes(2);
  });

  it("keeps no unknown id longer than a connector id, so anonymous callers can't fill the cache with long ones", async () => {
    const { service } = stubService({ read: () => null });
    const resolver = createBackendConnectorResolver(service);
    const long = "x".repeat(4096);
    expect(await resolver.resolve(long)).toBeUndefined();
    expect(await resolver.resolve(long)).toBeUndefined();
    expect(service.read).toHaveBeenCalledTimes(2);
  });

  it("reads an id the backend refuses to parse as unknown, and any other failure as a failure", async () => {
    const invalid = createBackendConnectorResolver(
      stubService({
        read: () => {
          throw refusal("INVALID_WEB_CLIENT_REQUEST");
        },
      }).service,
    );
    expect(await invalid.resolve("x".repeat(600))).toBeUndefined();
    const unauthorized = createBackendConnectorResolver(
      stubService({
        read: () => {
          throw refusal("UNAUTHORIZED");
        },
      }).service,
    );
    await expect(unauthorized.resolve(ROW.connectorId)).rejects.toThrow();
  });

  it("asks may-use for the token's user and reads its refusals as not allowed", async () => {
    const { service } = stubService({
      read: (command) => command.actorExternalId === "user_01",
    });
    const resolver = createBackendConnectorResolver(service);
    expect(await resolver.mayUse?.(ROW, "user_01")).toBe(true);
    expect(service.read).toHaveBeenCalledWith({
      action: "mayUseWebConnector",
      connectorId: ROW.connectorId,
      actorExternalId: "user_01",
    });
    expect(await resolver.mayUse?.(ROW, "user_02")).toBe(false);
    for (const code of ["UNKNOWN_ACTOR", "FORBIDDEN", "NOT_FOUND"]) {
      const refused = createBackendConnectorResolver(
        stubService({
          read: () => {
            throw refusal(code);
          },
        }).service,
      );
      expect(await refused.mayUse?.(ROW, "user_01")).toBe(false);
    }
    const down = createBackendConnectorResolver(
      stubService({
        read: () => {
          throw new Error("network down");
        },
      }).service,
    );
    await expect(down.mayUse?.(ROW, "user_01")).rejects.toThrow("network down");
  });

  it("records and settles calls with the backend's commands, leaving out absent fields", async () => {
    const { service, applied } = stubService({
      apply: (command) =>
        command.action === "recordWebToolCallForwarded"
          ? { id: "ledger_1", state: "forwarded" }
          : { settled: true },
    });
    const ledger = createBackendToolCallLedger(service);
    const id = await ledger.record({
      connectorId: ROW.connectorId,
      turnId: "turn_1",
      runId: undefined,
      jsonrpcId: 3,
      toolName: "echo",
      toolUseId: "toolu_3",
      argsHash: HASH,
    });
    expect(id).toBe("ledger_1");
    await ledger.settle("ledger_1", { state: "lost" });
    expect(applied).toStrictEqual([
      {
        action: "recordWebToolCallForwarded",
        connectorId: ROW.connectorId,
        turnId: "turn_1",
        jsonrpcId: "3",
        toolName: "echo",
        toolUseId: "toolu_3",
        argsHash: HASH,
      },
      { action: "settleWebToolCall", id: "ledger_1", state: "lost" },
    ]);
  });

  it("calls the service functions through the Convex client with the service token", async () => {
    const posted: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      posted.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ status: "success", value: null, logLines: [] });
    });
    const service = webClientService({
      INSPECTOR_SERVICE_TOKEN: "service-token",
      CONVEX_URL: "https://quiet-otter-123.convex.cloud",
    });
    await service?.read({ action: "resolveWebConnector", connectorId: "c1" });
    await service?.apply({ action: "settleWebToolCall", id: "l1", state: "lost" });
    expect(posted).toEqual([
      {
        url: "https://quiet-otter-123.convex.cloud/api/query",
        body: expect.objectContaining({
          path: "webClientService:read",
          args: [
            {
              serviceToken: "service-token",
              requestId: expect.any(String),
              command: { action: "resolveWebConnector", connectorId: "c1" },
            },
          ],
        }),
      },
      {
        url: "https://quiet-otter-123.convex.cloud/api/mutation",
        body: expect.objectContaining({
          path: "webClientService:apply",
          args: [
            {
              serviceToken: "service-token",
              command: { action: "settleWebToolCall", id: "l1", state: "lost" },
            },
          ],
        }),
      },
    ]);
    expect(webClientService({ CONVEX_URL: "https://quiet-otter-123.convex.cloud" })).toBeUndefined();
  });
});

describe("backend service transport", () => {
  it("doesn't follow a redirect, so the service credential stays with the deployment", async () => {
    const { createServer } = await import("node:http");
    const received: string[] = [];
    const elsewhere = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push(body);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "success", value: null, logLines: [] }));
      });
    });
    const listen = (server: ReturnType<typeof createServer>) =>
      new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : 0);
        }),
      );
    const elsewherePort = await listen(elsewhere);
    // A deployment that answers every call by pointing it at another origin.
    const deployment = createServer((request, response) => {
      response.statusCode = 307;
      response.setHeader("location", `http://127.0.0.1:${elsewherePort}${request.url}`);
      response.end();
    });
    const deploymentPort = await listen(deployment);
    try {
      const service = webClientService({
        INSPECTOR_SERVICE_TOKEN: "service-token",
        CONVEX_URL: `http://127.0.0.1:${deploymentPort}`,
      });
      await expect(
        service?.read({ action: "resolveWebConnector", connectorId: "c1" }),
      ).rejects.toThrow();
      expect(received).toEqual([]);
    } finally {
      deployment.close();
      elsewhere.close();
    }
  });
});

describe("backend connector upstream", () => {
  const baseFetch = vi.fn<typeof fetch>();
  const disconnectAllServers = vi.fn(async () => {});
  /** The acting-as authorization's answer: the project server's config. */
  function authorizeWith(config: Record<string, unknown>) {
    authorize.mockResolvedValue({
      manager: { disconnectAllServers },
      authorizedServerConfigs: { [ROW.serverId]: config },
    });
  }
  const upstream = (connector: WebConnector, userId?: string) =>
    createBackendConnectorResolver(stubService({}).service).upstream(
      connector,
      { userId },
    );

  afterEach(() => {
    authorize.mockReset();
    disconnectAllServers.mockClear();
  });

  it("forwards as the token's user, through the server's egress-guarded fetch and credential", async () => {
    const refresh = vi.fn(async () => ({ accessToken: "fresh-token" }));
    authorizeWith({
      url: new URL("https://upstream.example.com/mcp"),
      requestInit: { headers: { "x-api-key": "server-key" } },
      accessToken: "server-token",
      baseFetch,
      onUnauthorized: refresh,
    });
    const target = await upstream(ROW, "user_01");

    expect(authorize).toHaveBeenCalledWith(
      {
        authMethod: "workos_api_key",
        workosUserId: "user_01",
        mcpjamOrganizationId: ROW.organizationId,
      },
      "",
      ROW.projectId,
      [ROW.serverId],
      expect.any(Number),
      undefined,
      undefined,
      expect.objectContaining({ lazyConnect: true }),
    );
    expect(target).toMatchObject({
      url: "https://upstream.example.com/mcp",
      headers: {
        "x-api-key": "server-key",
        authorization: "Bearer server-token",
      },
    });
    expect(target.fetch).toBe(baseFetch);
    expect(await target.onUnauthorized?.()).toBe("fresh-token");
    expect(refresh).toHaveBeenCalledWith({
      serverId: ROW.serverId,
      error: expect.any(Error),
    });
    await target.release?.();
    expect(disconnectAllServers).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "has no egress-guarded fetch",
      { url: "https://upstream.example.com/mcp" },
    ],
    [
      "prefers SSE",
      { url: "https://upstream.example.com/sse", preferSSE: true, baseFetch },
    ],
  ])(
    "refuses a server that %s and releases its manager",
    async (_label, config) => {
      authorizeWith(config);
      await expect(upstream(ROW, "user_01")).rejects.toThrow(
        "The project's server has no Streamable HTTP endpoint.",
      );
      expect(disconnectAllServers).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses a request with no signed-in user, which is every capability connector's", async () => {
    const capability = { ...ROW, auth: "capability" as const };
    await expect(upstream(capability)).rejects.toThrow(
      "A backend connector forwards only for a signed-in user.",
    );
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe("durable ledger write-through", () => {
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  beforeAll(async () => {
    fixture = await startFixtureServer();
  });
  afterAll(async () => {
    await fixture.close();
  });

  function setup(apply: (command: Command) => unknown) {
    const stub = stubService({ apply });
    const connector = { ...ROW, auth: "capability" as const };
    const turns = createInMemoryTurnWindowStore();
    const ledger = createInMemoryToolCallLedger();
    const app = new Hono();
    mountWebConnectorEndpoint(
      app,
      createWebConnectorEndpoint({
        resolver: createStaticConnectorResolver([
          { connector, upstream: { url: fixture.url, headers: {} } },
        ]),
        turns,
        ledger,
        durableLedger: createBackendToolCallLedger(stub.service),
        recorder: { frame: () => undefined, client: () => undefined },
        isEnabled: async () => true,
      }),
    );
    const window = turns.open({
      connectorId: connector.connectorId,
      runId: "run_1",
      approve: async () => ({ allow: true }),
    });
    fixture.received.length = 0;
    const vendor = vendorClient(app, { path: `/mcp/${connector.connectorId}` });
    return { ...stub, ledger, turns, window, vendor };
  }
  const callsReceived = () =>
    fixture.received.filter((request) =>
      request.body.toString("utf8").includes('"tools/call"'),
    ).length;

  it("records a call before it goes upstream, keeps the durable id and settles it from the answer", async () => {
    let receivedWhenRecorded = -1;
    const { applied, ledger, window, vendor } = setup((command) => {
      if (command.action !== "recordWebToolCallForwarded") return { settled: true };
      receivedWhenRecorded = callsReceived();
      return { id: "ledger_1", state: "forwarded" };
    });
    const answer = await (await vendor.post(vendor.callToolRaw(3, "echo", "d"))).json();
    expect(answer).toMatchObject({ id: 3, result: { content: [{ text: "echo: d" }] } });
    expect(receivedWhenRecorded).toBe(0);
    expect(callsReceived()).toBe(1);
    expect(applied[0]).toStrictEqual({
      action: "recordWebToolCallForwarded",
      connectorId: ROW.connectorId,
      turnId: window.turnId,
      runId: "run_1",
      jsonrpcId: "3",
      toolName: "echo",
      toolUseId: "toolu_3",
      argsHash: hashPayload({ message: "d" }),
    });
    await vi.waitFor(() =>
      expect(applied[1]).toStrictEqual({
        action: "settleWebToolCall",
        id: "ledger_1",
        state: "result",
        upstreamStatus: 200,
        resultHash: hashPayload(answer.result),
      }),
    );
    expect(ledger.forTurn(window.turnId)).toEqual([
      expect.objectContaining({ durableId: "ledger_1", state: "result" }),
    ]);
  });

  it("refuses a call it could not record, and the server receives nothing", async () => {
    const { ledger, window, vendor } = setup(() => {
      throw new Error("backend down");
    });
    const answer = await (await vendor.post(vendor.callToolRaw(4, "echo", "e"))).json();
    expect(answer).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: {
        code: -32000,
        message:
          "MCPJam could not record this tool call, so it was not sent. Send the prompt again.",
      },
    });
    expect(fixture.received).toHaveLength(0);
    expect(ledger.forTurn(window.turnId)).toHaveLength(0);
  });

  it("holds a batch whose second call can't be recorded, and settles the first call's record as an error", async () => {
    let records = 0;
    const { applied, ledger, window, vendor } = setup((command) => {
      if (command.action !== "recordWebToolCallForwarded") return { settled: true };
      records += 1;
      if (records === 2) throw new Error("backend down");
      return { id: "ledger_3", state: "forwarded" };
    });
    const batch = `[${vendor.callToolRaw(6, "echo", "g")},${vendor.callToolRaw(7, "echo", "h")},{"jsonrpc":"2.0","id":8,"method":"tools/list"}]`;
    const answers = await (await vendor.post(batch)).json();
    const refused = (id: number, message: string) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message },
    });
    const notRecorded =
      "MCPJam could not record this tool call, so it was not sent. Send the prompt again.";
    expect(answers).toEqual([
      refused(6, notRecorded),
      refused(7, notRecorded),
      refused(
        8,
        "This request was not sent because a tool call in the same batch was refused. Send it again on its own.",
      ),
    ]);
    expect(fixture.received).toHaveLength(0);
    expect(ledger.forTurn(window.turnId)).toHaveLength(0);
    await vi.waitFor(() =>
      expect(applied.filter((command) => command.action === "settleWebToolCall")).toStrictEqual([
        { action: "settleWebToolCall", id: "ledger_3", state: "error" },
      ]),
    );
  });

  it("refuses a call whose turn closed while it was recorded, and settles its record as an error", async () => {
    let closeTurn = () => {};
    const { applied, ledger, turns, window, vendor } = setup((command) => {
      if (command.action !== "recordWebToolCallForwarded") return { settled: true };
      // The run ends its turn while the record is being written.
      closeTurn();
      return { id: "ledger_4", state: "forwarded" };
    });
    closeTurn = () => turns.close(window.turnId);
    const answer = await (await vendor.post(vendor.callToolRaw(9, "echo", "i"))).json();
    expect(answer).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: {
        code: -32000,
        message:
          "No MCPJam run is using this connector, so the tool call was not sent. Start a run in MCPJam, then send the prompt again.",
      },
    });
    expect(fixture.received).toHaveLength(0);
    expect(ledger.forTurn(window.turnId)).toHaveLength(0);
    await vi.waitFor(() =>
      expect(applied[1]).toStrictEqual({ action: "settleWebToolCall", id: "ledger_4", state: "error" }),
    );
  });

  it("answers the vendor even when the durable settle fails", async () => {
    const { applied, vendor } = setup((command) => {
      if (command.action === "settleWebToolCall") throw new Error("backend down");
      return { id: "ledger_2", state: "forwarded" };
    });
    const response = await vendor.post(vendor.callToolRaw(5, "echo", "f"));
    expect(await response.json()).toMatchObject({ id: 5, result: {} });
    await vi.waitFor(() => expect(applied).toHaveLength(2));
  });
});
