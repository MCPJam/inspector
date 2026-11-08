import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import {
  MCPClientManager,
  type MrtrInputCollector,
  type MrtrOperationState,
  type InputRequests,
} from "@mcpjam/sdk";
import { createLocalMrtrStream } from "../local-mrtr-stream";
import { generateSessionToken } from "../../../services/session-token";
import mrtr, {
  pendingMrtrRoundCount,
  registerLocalMrtrCollector,
} from "../../mcp/mrtr";
import {
  LOCAL_MRTR_MAX_FRAME_BYTES,
  LOCAL_MRTR_PROTOCOL,
  localMrtrMessageSchema,
  localMrtrProtocols,
  type LocalMrtrMessage,
} from "@/shared/local-mrtr-wire";

const ORIGIN = "http://localhost:5173";
const sockets: WebSocket[] = [];
const controllers: AbortController[] = [];
const settlements: Promise<unknown>[] = [];
let server: Server;
let port: number;
let token: string;
let stream: ReturnType<typeof createLocalMrtrStream>;

beforeEach(async () => {
  token = generateSessionToken();
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  stream = createLocalMrtrStream(upgradeWebSocket);
  app.get("/api/web/mcp/mrtr/stream", stream.handler);
  server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  injectWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server address");
  port = address.port;
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(settlements.splice(0));
  for (const socket of sockets.splice(0)) socket.terminate();
  stream.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

function connect(
  protocols = localMrtrProtocols(token),
  origin: string | null = ORIGIN,
) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/web/mcp/mrtr/stream`,
    protocols,
    {
      ...(origin ? { origin } : {}),
    },
  );
  sockets.push(socket);
  const messages: LocalMrtrMessage[] = [];
  const errors: Error[] = [];
  socket.on("message", (data) => {
    const parsed = localMrtrMessageSchema.safeParse(
      JSON.parse(data.toString()),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) messages.push(parsed.data);
  });
  socket.on("error", (error) => errors.push(error));
  const ready = new Promise<boolean>((resolve) => {
    socket.once("open", () => resolve(true));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(false);
    });
  });
  const closed = new Promise<number>((resolve) =>
    socket.once("close", (code) => resolve(code)),
  );
  return { socket, messages, ready, closed, errors };
}

function pending(opId = crypto.randomUUID(), key = "q", round = 1) {
  const manager = new MCPClientManager({});
  let collector: MrtrInputCollector = async () => {
    throw new Error("Collector not installed");
  };
  vi.spyOn(manager, "setMrtrInputCollector").mockImplementation(
    (_id, value) => {
      collector = value;
    },
  );
  registerLocalMrtrCollector(manager, "server");
  const state: MrtrOperationState = {
    opId,
    method: "tools/call",
    originalParams: { name: "fixture" },
    round,
    maxRounds: 10,
    pendingInputRequests: {},
  };
  const inputRequests: InputRequests = {
    [key]: {
      method: "elicitation/create",
      params: {
        message: "Fixture",
        requestedSchema: { type: "object", properties: {} },
      },
    },
  };
  const controller = new AbortController();
  controllers.push(controller);
  const result = collector({ state, inputRequests, signal: controller.signal });
  settlements.push(
    result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
  );
  return { opId, result, controller };
}

describe("local MRTR WebSocket", () => {
  it("negotiates only the public protocol and replays a pending round", async () => {
    const operation = pending();
    const client = connect();
    expect(await client.ready).toBe(true);
    expect(client.socket.protocol).toBe(LOCAL_MRTR_PROTOCOL);
    expect(client.socket.protocol).not.toContain(token);
    await vi.waitFor(() =>
      expect(client.messages.map((message) => message.type)).toEqual([
        "snapshot_start",
        "mrtr_input_request",
        "snapshot_end",
      ]),
    );
    client.socket.send(
      JSON.stringify({
        type: "respond",
        requestId: "a",
        opId: operation.opId,
        roundKey: `${operation.opId}:1`,
        responses: { q: { action: "accept", content: {} } },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({
      q: { action: "accept", content: {} },
    });
    await vi.waitFor(() =>
      expect(client.messages).toContainEqual({
        type: "response",
        requestId: "a",
        result: { ok: true },
      }),
    );
  });

  it.each([
    { name: "missing origin", origin: null, protocols: "valid" },
    {
      name: "foreign origin",
      origin: "https://foreign.example",
      protocols: "valid",
    },
    { name: "wrong token", origin: ORIGIN, protocols: "wrong" },
    { name: "credential first", origin: ORIGIN, protocols: "reversed" },
  ])("refuses $name before upgrading", async (test) => {
    const protocols =
      test.protocols === "wrong"
        ? localMrtrProtocols("wrong-token-000000000000000000")
        : localMrtrProtocols(token);
    if (test.protocols === "reversed") protocols.reverse();
    const client = connect(protocols, test.origin);
    expect(await client.ready).toBe(false);
    expect(client.messages).toEqual([]);
  });

  it("preserves a prototype-shaped server key through the real socket", async () => {
    const operation = pending(crypto.randomUUID(), "__proto__");
    const client = connect();
    await client.ready;
    const responses: unknown = JSON.parse('{"__proto__":{"action":"cancel"}}');
    client.socket.send(
      JSON.stringify({
        type: "respond",
        requestId: "proto",
        opId: operation.opId,
        roundKey: `${operation.opId}:1`,
        responses,
      }),
    );
    const result = await operation.result;
    expect(Object.keys(result)).toEqual(["__proto__"]);
    expect(result["__proto__"]).toEqual({ action: "cancel" });
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it("keeps the round across disconnect and accepts cancellation after reconnect", async () => {
    const operation = pending();
    const first = connect();
    await first.ready;
    first.socket.close();
    await first.closed;
    expect(pendingMrtrRoundCount()).toBe(1);
    const second = connect();
    await second.ready;
    await vi.waitFor(() =>
      expect(
        second.messages.some(
          (message) => message.type === "mrtr_input_request",
        ),
      ).toBe(true),
    );
    second.socket.send(
      JSON.stringify({
        type: "respond",
        requestId: "cancel",
        opId: operation.opId,
        roundKey: `${operation.opId}:1`,
        responses: { q: { action: "cancel" } },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({
      q: { action: "cancel" },
    });
  });

  it.each([
    { name: "malformed JSON", payload: "{", code: 1007 },
    {
      name: "invalid action",
      payload: JSON.stringify({
        type: "respond",
        requestId: "a",
        opId: "op",
        roundKey: "op:1",
        responses: { q: { action: "erase" } },
      }),
      code: 1008,
    },
    {
      name: "oversized frame",
      payload: "x".repeat(LOCAL_MRTR_MAX_FRAME_BYTES + 1),
      code: 1009,
    },
  ])(
    "refuses $name without settling the collector",
    async ({ payload, code }) => {
      pending();
      const client = connect();
      await client.ready;
      client.socket.send(payload);
      expect(await client.closed).toBe(code);
      expect(pendingMrtrRoundCount()).toBe(1);
    },
  );

  it("retires both private HTTP paths without settling a pending round", async () => {
    const operation = pending();
    expect((await mrtr.request("/stream")).status).toBe(410);
    expect((await mrtr.request("/respond", { method: "POST" })).status).toBe(
      410,
    );
    expect(pendingMrtrRoundCount()).toBe(1);
    operation.controller.abort();
  });

  it("rejects a delayed answer from an earlier round with the same operation and keys", async () => {
    const first = pending();
    const client = connect();
    await client.ready;
    client.socket.send(
      JSON.stringify({
        type: "respond",
        requestId: "first",
        opId: first.opId,
        roundKey: `${first.opId}:1`,
        responses: { q: { action: "accept", content: {} } },
      }),
    );
    await first.result;
    const second = pending(first.opId, "q", 2);
    client.socket.send(
      JSON.stringify({
        type: "respond",
        requestId: "stale",
        opId: first.opId,
        roundKey: `${first.opId}:1`,
        responses: { q: { action: "cancel" } },
      }),
    );
    await vi.waitFor(() =>
      expect(client.messages).toContainEqual(
        expect.objectContaining({
          type: "response",
          requestId: "stale",
          result: expect.objectContaining({ ok: false, status: 400 }),
        }),
      ),
    );
    expect(pendingMrtrRoundCount()).toBe(1);
    client.socket.send(
      JSON.stringify({
        type: "respond",
        requestId: "current",
        opId: first.opId,
        roundKey: `${first.opId}:2`,
        responses: { q: { action: "cancel" } },
      }),
    );
    await expect(second.result).resolves.toMatchObject({
      q: { action: "cancel" },
    });
  });

  it("refuses a revoked token before applying an answer", async () => {
    const operation = pending();
    const client = connect();
    await client.ready;
    generateSessionToken();
    client.socket.send(
      JSON.stringify({
        type: "respond",
        requestId: "a",
        opId: operation.opId,
        roundKey: `${operation.opId}:1`,
        responses: { q: { action: "cancel" } },
      }),
    );
    expect(await client.closed).toBe(4401);
    expect(pendingMrtrRoundCount()).toBe(1);
  });

  it("kills sockets without latching, then refuses new upgrades after shutdown", async () => {
    const first = connect();
    await first.ready;
    stream.kill();
    expect(await first.closed).toBe(1012);
    const second = connect();
    expect(await second.ready).toBe(true);
    stream.shutdown();
    expect(await second.closed).toBe(1012);
    expect(await connect().ready).toBe(false);
  });
});
