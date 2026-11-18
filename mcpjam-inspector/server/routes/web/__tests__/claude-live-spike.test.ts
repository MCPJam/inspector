import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createClaudeLiveSpikeRouter } from "../claude-live-spike.js";
import {
  readClaudeLiveSpikeConfig,
  type ClaudeLiveSpikeConfig,
} from "../../../utils/harness/forwarding/claude-live-spike.js";

const config: ClaudeLiveSpikeConfig = {
  upstreamUrl: "https://test-server.example/mcp",
  connectorSecret: "connector-secret",
  controlSecret: "control-secret",
  serverId: "claude-live-spike",
};

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-ai", version: "0.1.0" },
  },
};

function setup() {
  const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1.0.0" },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const app = new Hono();
  app.route(
    "/spike",
    createClaudeLiveSpikeRouter({ config, fetch: upstream as typeof fetch }),
  );
  const mcp = (body: unknown, key = config.connectorSecret) =>
    app.request("/spike/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "Claude-User",
        "x-mcpjam-spike-key": key,
      },
      body: JSON.stringify(body),
    });
  const control = (path: string, init: RequestInit = {}, secret = config.controlSecret) =>
    app.request(`/spike${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-mcpjam-spike-control": secret,
      },
    });
  const startTurn = (label: string) =>
    control("/turn", { method: "POST", body: JSON.stringify({ live: true, label }) });
  return { app, upstream, mcp, control, startTurn };
}

describe("claude live spike route", () => {
  it("answers 404 everywhere when the spike is not configured", async () => {
    const app = new Hono();
    app.route("/spike", createClaudeLiveSpikeRouter({ config: undefined }));
    expect((await app.request("/spike/mcp", { method: "POST" })).status).toBe(404);
    expect((await app.request("/spike/turn", { method: "POST" })).status).toBe(404);
  });

  it("refuses a connector request without the secret header", async () => {
    const { mcp, upstream } = setup();
    expect((await mcp(initialize, "wrong")).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers a JSON-RPC error and records the refusal when no turn is live", async () => {
    const { mcp, control, upstream } = setup();
    const response = await mcp(initialize);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32001 } });
    expect(upstream).not.toHaveBeenCalled();
    const records = await (await control("/records")).json();
    expect(records.refusedWithoutTurn).toEqual([
      expect.objectContaining({ kind: "refused", reason: "initialize" }),
    ]);
  });

  it("forwards during a live turn and records the envelope and both frames under it", async () => {
    const { mcp, control, startTurn, upstream } = setup();
    expect((await startTurn("prompt-1")).status).toBe(200);
    const response = await mcp(initialize);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 1, result: { serverInfo: { name: "test" } } });

    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe(config.upstreamUrl);
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get("x-mcpjam-spike-key")).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual(initialize);

    const { turns } = await (await control("/records")).json();
    expect(turns).toHaveLength(1);
    expect(turns[0].label).toBe("prompt-1");
    expect(turns[0].records).toEqual([
      expect.objectContaining({
        kind: "request",
        rpcMethod: "initialize",
        headers: expect.objectContaining({ "user-agent": "Claude-User" }),
      }),
      expect.objectContaining({ kind: "frame", direction: "send" }),
      expect.objectContaining({ kind: "frame", direction: "receive" }),
    ]);
  });

  it("stops forwarding once the turn is switched off", async () => {
    const { mcp, control, startTurn, upstream } = setup();
    await startTurn("prompt-1");
    await control("/turn", { method: "POST", body: JSON.stringify({ live: false }) });
    const body = await (await mcp({ ...initialize, id: 2 })).json();
    expect(body).toMatchObject({ id: 2, error: { code: -32001 } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not let the connector secret control turns or read records", async () => {
    const { control } = setup();
    const start = await control(
      "/turn",
      { method: "POST", body: JSON.stringify({ live: true }) },
      config.connectorSecret,
    );
    expect(start.status).toBe(401);
    expect((await control("/records", {}, config.connectorSecret)).status).toBe(401);
  });
});

describe("readClaudeLiveSpikeConfig", () => {
  const env = {
    CLAUDE_LIVE_SPIKE_UPSTREAM_URL: "https://test-server.example/mcp",
    CLAUDE_LIVE_SPIKE_CONNECTOR_SECRET: "a",
    CLAUDE_LIVE_SPIKE_CONTROL_SECRET: "b",
  };

  it("is off unless every required variable is set", () => {
    expect(readClaudeLiveSpikeConfig({})).toBeUndefined();
    expect(readClaudeLiveSpikeConfig(env)?.serverId).toBe("claude-live-spike");
  });

  it("refuses one secret for both doors", () => {
    expect(
      readClaudeLiveSpikeConfig({ ...env, CLAUDE_LIVE_SPIKE_CONTROL_SECRET: "a" }),
    ).toBeUndefined();
  });
});
