import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostedRpcLogCollector,
  bridgeHarnessRpcLogsToCollector,
} from "../../../../routes/web/hosted-rpc-logs.js";
import { rpcLogBus } from "../../../../services/rpc-log-bus.js";
import {
  flushHarnessRpcLogs,
  __resetHarnessRpcLogSinkForTest,
} from "../../harness-rpc-log-sink.js";
import {
  createNativeRpcLogger,
  nativeRpcLogScope,
} from "../native-rpc-logs.js";
import { forwardNativeMcp } from "../native-transport.js";

const owner = {
  kind: "chat" as const,
  userId: "user",
  serverId: "server",
  connectionId: "account",
  harnessSessionId: "chat",
};
const context = {
  owner,
  turnId: "turn",
  projectId: "project",
  organizationId: "org",
};
const disposers: Array<() => void> = [];
let server: Server | undefined;

afterEach(async () => {
  disposers.splice(0).forEach((stop) => stop());
  __resetHarnessRpcLogSinkForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (server) {
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve, reject) =>
      closing.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe("native forwarding RPC logs", () => {
  it("binds the scope to the owner, account, chat and turn without exposing their identifiers", () => {
    const scope = nativeRpcLogScope(owner, "turn");
    expect(scope).toMatch(/^[0-9a-f]{64}$/);
    for (const changed of [
      { ...owner, userId: "other" },
      { ...owner, serverId: "other" },
      { ...owner, connectionId: "other" },
      { ...owner, harnessSessionId: "other" },
    ])
      expect(nativeRpcLogScope(changed, "turn")).not.toBe(scope);
    expect(nativeRpcLogScope(owner, "other")).not.toBe(scope);
    expect(nativeRpcLogScope({ ...owner }, "turn")).toBe(scope);
  });

  it("streams real HTTP frames into only the matching collector and the shared sink", async () => {
    const progress =
      'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\r\n\r\n';
    const result = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "done" }],
        structuredContent: { value: 42, access_token: "server-private" },
      },
    };
    const responseBody =
      progress + `event: message\ndata: ${JSON.stringify(result)}\n\n`;
    const requests: string[] = [];
    const sinkWrites: unknown[] = [];
    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (request.url === "/harness/rpc-logs/scoped-write") {
        sinkWrites.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"written":3}');
        return;
      }
      requests.push(body);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "set-cookie": "private-cookie",
      });
      response.write(progress);
      response.end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture address unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("CONVEX_HTTP_URL", origin);
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "sink-service-secret");
    const matching = createHostedRpcLogCollector({ serverIds: ["server"] });
    const otherAccount = createHostedRpcLogCollector({});
    const otherTurn = createHostedRpcLogCollector({});
    const legacy = createHostedRpcLogCollector({});
    disposers.push(
      bridgeHarnessRpcLogsToCollector(["server"], matching, {
        server: nativeRpcLogScope(owner, "turn"),
      }),
      bridgeHarnessRpcLogsToCollector(["server"], otherAccount, {
        server: nativeRpcLogScope({ ...owner, connectionId: "other" }, "turn"),
      }),
      bridgeHarnessRpcLogsToCollector(["server"], otherTurn, {
        server: nativeRpcLogScope(owner, "other"),
      }),
      bridgeHarnessRpcLogsToCollector(["server"], legacy),
    );
    const write = vi.fn();
    matching.attachStreamWriter({ write });
    const message = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call",
      params: { name: "read", arguments: { value: 42 } },
    };
    const body = JSON.stringify(message);
    const request = new Request(`${origin}/proxy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcpjam-forwarding-secret": "grant-secret",
      },
      body,
    });
    const settle = vi.fn(async () => undefined);
    const response = await forwardNativeMcp({
      url: `${origin}/mcp`,
      serverId: "server",
      request,
      body,
      message,
      fetch,
      trustedHeaders: { authorization: "Bearer upstream-secret" },
      rpcLogger: createNativeRpcLogger(context),
      settle,
    });
    expect(await response.text()).toBe(responseBody);
    expect(settle).toHaveBeenCalledWith({
      outcome: "success",
      resultJson: JSON.stringify(result),
    });
    expect(requests).toEqual([body]);
    const logs = matching.getLogs();
    expect(logs.map((log) => log.direction)).toEqual([
      "send",
      "receive",
      "receive",
    ]);
    expect(logs.at(-1)?.message).toMatchObject({
      result: { structuredContent: { value: 42, access_token: "[REDACTED]" } },
    });
    expect(write).toHaveBeenCalledTimes(3);
    expect(otherAccount.getLogs()).toEqual([]);
    expect(otherTurn.getLogs()).toEqual([]);
    expect(legacy.getLogs()).toEqual([]);
    expect(rpcLogBus.getBuffer(["server"], -1)).toEqual([]);
    await flushHarnessRpcLogs();
    expect(sinkWrites).toHaveLength(1);
    expect(sinkWrites[0]).toMatchObject({
      entries: logs.map((log) => ({
        serverId: "server",
        scopeId: nativeRpcLogScope(owner, "turn"),
        projectId: "project",
        organizationId: "org",
        direction: log.direction,
        message: log.message,
      })),
    });
    const stored = JSON.stringify(sinkWrites);
    for (const secret of [
      "server-private",
      "upstream-secret",
      "grant-secret",
      "private-cookie",
      "sink-service-secret",
    ])
      expect(stored).not.toContain(secret);
  });

  it("bounds only the log copy and keeps authoritative results intact", async () => {
    const collector = createHostedRpcLogCollector({});
    disposers.push(
      bridgeHarnessRpcLogsToCollector(["server"], collector, {
        server: nativeRpcLogScope(owner, "turn"),
      }),
    );
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
        access_token: "secret-fragment-".repeat(1000),
      },
    });
    const response = await forwardNativeMcp({
      url: "https://server.example/mcp",
      serverId: "server",
      request: new Request("https://forwarder.example"),
      message: { jsonrpc: "2.0", id: 1, method: "tools/call" },
      fetch: async () =>
        new Response(raw, { headers: { "content-type": "application/json" } }),
      rpcLogger: createNativeRpcLogger(context),
    });
    expect(await response.text()).toBe(raw);
    expect(collector.getLogs().at(-1)?.message).toMatchObject({
      _truncated: true,
    });
    expect(JSON.stringify(collector.getLogs())).not.toContain("secret-fragment-");
  });

  it("does not turn a log publisher failure into a transport failure", async () => {
    vi.spyOn(rpcLogBus, "publish").mockImplementation(() => {
      throw new Error("observer unavailable");
    });
    const raw =
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad arguments"}}';
    const response = await forwardNativeMcp({
      url: "https://server.example/mcp",
      serverId: "server",
      request: new Request("https://forwarder.example"),
      fetch: async () => new Response(raw),
      rpcLogger: createNativeRpcLogger(context),
    });
    expect(await response.text()).toBe(raw);
  });
});
