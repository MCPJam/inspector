import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  handleFacadeJsonRpc,
  matchTunnelPath,
  startLocalBridge,
  stripTunnelSecret,
  type LocalBridge,
} from "../src/lib/tunnel/local-bridge.js";

const SERVER_ID = "srv-1";
const PREFIX = `/api/mcp/adapter-http/${SERVER_ID}`;

// ── Path scope helpers ─────────────────────────────────────────────────

test("matchTunnelPath accepts the exact base path and subpaths only", () => {
  assert.equal(matchTunnelPath(SERVER_ID, PREFIX), "");
  assert.equal(matchTunnelPath(SERVER_ID, `${PREFIX}/sub/path`), "/sub/path");
  assert.equal(matchTunnelPath(SERVER_ID, "/other"), null);
  assert.equal(matchTunnelPath(SERVER_ID, "/api/mcp/adapter-http/other"), null);
  // Prefix confusion must not match: srv-1x is a different server scope.
  assert.equal(matchTunnelPath(SERVER_ID, `${PREFIX}x`), null);
});

test("stripTunnelSecret drops only the k param", () => {
  const params = stripTunnelSecret(
    new URLSearchParams("k=secret&x=1&k=again&y=two"),
  );
  assert.equal(params.has("k"), false);
  assert.equal(params.get("x"), "1");
  assert.equal(params.get("y"), "two");
});

// ── HTTP target: streaming reverse proxy ───────────────────────────────

type UpstreamCapture = { url?: string; method?: string; body?: string };

async function startUpstream(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { server, port: address.port };
}

async function withHttpBridge(
  targetUrl: string,
  fn: (bridge: LocalBridge) => Promise<void>,
): Promise<void> {
  const bridge = await startLocalBridge({
    serverId: SERVER_ID,
    target: { kind: "http", url: targetUrl },
  });
  try {
    await fn(bridge);
  } finally {
    await bridge.close();
  }
}

test("http target: rewrites the prefix, strips only k, and streams the body through", async () => {
  const captured: UpstreamCapture = {};
  const { server, port } = await startUpstream((req, res) => {
    captured.url = req.url;
    captured.method = req.method;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured.body = body;
      res.writeHead(200, { "content-type": "application/json", "x-up": "1" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  try {
    await withHttpBridge(`http://127.0.0.1:${port}/mcp?base=1`, async (bridge) => {
      const response = await fetch(
        `${bridge.localAddr}${PREFIX}?k=secret&x=1`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
        },
      );

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-up"), "1");
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(captured.method, "POST");
      // Target's own query survives, caller params append, k is gone.
      assert.equal(captured.url, "/mcp?base=1&x=1");
      assert.equal(captured.body, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
    });
  } finally {
    server.close();
  }
});

test("http target: subpaths append to the target path", async () => {
  const captured: UpstreamCapture = {};
  const { server, port } = await startUpstream((req, res) => {
    captured.url = req.url;
    res.writeHead(204);
    res.end();
  });

  try {
    await withHttpBridge(`http://127.0.0.1:${port}/mcp`, async (bridge) => {
      const response = await fetch(
        `${bridge.localAddr}${PREFIX}/sub/path?y=2&k=s`,
      );
      assert.equal(response.status, 204);
      assert.equal(captured.url, "/mcp/sub/path?y=2");
    });
  } finally {
    server.close();
  }
});

test("http target: foreign paths get 404 without touching the upstream", async () => {
  let upstreamHits = 0;
  const { server, port } = await startUpstream((_req, res) => {
    upstreamHits += 1;
    res.end();
  });

  try {
    await withHttpBridge(`http://127.0.0.1:${port}/mcp`, async (bridge) => {
      const foreign = await fetch(`${bridge.localAddr}/api/mcp/adapter-http/other`);
      assert.equal(foreign.status, 404);
      const root = await fetch(`${bridge.localAddr}/`);
      assert.equal(root.status, 404);
      assert.equal(upstreamHits, 0);
    });
  } finally {
    server.close();
  }
});

test("http target: unreachable upstream returns 502", async () => {
  // Bind then close to get a port that refuses connections.
  const { server, port } = await startUpstream((_req, res) => res.end());
  server.close();
  await once(server, "close");

  await withHttpBridge(`http://127.0.0.1:${port}/mcp`, async (bridge) => {
    const response = await fetch(`${bridge.localAddr}${PREFIX}`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? "", /unreachable/i);
  });
});

test("http target: SSE responses stream without buffering", async () => {
  let releaseSecondChunk: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (releaseSecondChunk = resolve));
  const { server, port } = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    void gate.then(() => {
      res.write("data: two\n\n");
      res.end();
    });
  });

  try {
    await withHttpBridge(`http://127.0.0.1:${port}/sse`, async (bridge) => {
      const response = await fetch(`${bridge.localAddr}${PREFIX}?k=s`);
      assert.equal(response.headers.get("content-type"), "text/event-stream");

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      // The first chunk must arrive while the upstream response is still
      // open — a buffering proxy would hold it until end.
      const first = await reader.read();
      assert.match(decoder.decode(first.value), /data: one/);

      releaseSecondChunk!();
      let rest = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += decoder.decode(value);
      }
      assert.match(rest, /data: two/);
    });
  } finally {
    server.close();
  }
});

// ── stdio target: stateless streamable-HTTP facade ────────────────────

type FakeManagerState = {
  requests: Array<{ method: string; params?: Record<string, unknown> }>;
  disconnected: boolean;
  managedMissing?: boolean;
};

function makeFakeManager(state: FakeManagerState): MCPClientManager {
  const fake = {
    getInitializationInfo: () => ({
      protocolVersion: "2025-06-18",
      transport: "stdio",
      serverCapabilities: { tools: { listChanged: true } },
      serverVersion: { name: "fake-server", version: "1.2.3" },
      instructions: "be nice",
      clientCapabilities: {},
    }),
    getManagedClient: () =>
      state.managedMissing
        ? undefined
        : {
            request: async (req: {
              method: string;
              params?: Record<string, unknown>;
            }) => {
              state.requests.push(req);
              if (req.method === "fails/method") {
                const error = new Error("nope") as Error & { code: number };
                error.code = -32601;
                throw error;
              }
              return { tools: [{ name: "echo" }] };
            },
          },
    disconnectAllServers: async () => {
      state.disconnected = true;
    },
  };
  return fake as unknown as MCPClientManager;
}

async function withStdioBridge(
  state: FakeManagerState,
  fn: (bridge: LocalBridge) => Promise<void>,
): Promise<void> {
  const bridge = await startLocalBridge({
    serverId: SERVER_ID,
    target: { kind: "stdio", config: { command: "unused" } },
    connectStdio: async () => makeFakeManager(state),
  });
  try {
    await fn(bridge);
  } finally {
    await bridge.close();
  }
}

function postJson(
  bridge: LocalBridge,
  body: unknown,
  path = `${PREFIX}?k=s`,
): Promise<Response> {
  return fetch(`${bridge.localAddr}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("stdio facade: initialize is answered locally from the real handshake", async () => {
  const state: FakeManagerState = { requests: [], disconnected: false };
  await withStdioBridge(state, async (bridge) => {
    const response = await postJson(bridge, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, "2025-06-18");
    assert.equal(body.result.serverInfo.name, "fake-server");
    assert.equal(body.result.instructions, "be nice");
    // Nothing was forwarded to the child.
    assert.equal(state.requests.length, 0);
  });
});

test("stdio facade: notifications return 202 with no envelope", async () => {
  const state: FakeManagerState = { requests: [], disconnected: false };
  await withStdioBridge(state, async (bridge) => {
    const response = await postJson(bridge, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(response.status, 202);
    assert.equal(state.requests.length, 0);
  });
});

test("stdio facade: requests pass through the managed client and echo the id", async () => {
  const state: FakeManagerState = { requests: [], disconnected: false };
  await withStdioBridge(state, async (bridge) => {
    const response = await postJson(bridge, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: { cursor: "c1" },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.id, 7);
    assert.deepEqual(body.result.tools, [{ name: "echo" }]);
    assert.deepEqual(state.requests, [
      { method: "tools/list", params: { cursor: "c1" } },
    ]);
  });
});

test("stdio facade: child errors map to JSON-RPC errors with their code", async () => {
  const state: FakeManagerState = { requests: [], disconnected: false };
  await withStdioBridge(state, async (bridge) => {
    const response = await postJson(bridge, {
      jsonrpc: "2.0",
      id: 8,
      method: "fails/method",
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.id, 8);
    assert.equal(body.error.code, -32601);
    assert.match(body.error.message, /nope/);
  });
});

test("stdio facade: GET/DELETE are 405, batches are 400, foreign paths 404", async () => {
  const state: FakeManagerState = { requests: [], disconnected: false };
  await withStdioBridge(state, async (bridge) => {
    const get = await fetch(`${bridge.localAddr}${PREFIX}?k=s`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");

    const del = await fetch(`${bridge.localAddr}${PREFIX}?k=s`, {
      method: "DELETE",
    });
    assert.equal(del.status, 405);

    const batch = await postJson(bridge, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
    ]);
    assert.equal(batch.status, 400);

    const foreign = await fetch(`${bridge.localAddr}/nope`, { method: "POST" });
    assert.equal(foreign.status, 404);
  });
});

test("stdio facade: closing the bridge disconnects the manager (kills the child)", async () => {
  const state: FakeManagerState = { requests: [], disconnected: false };
  await withStdioBridge(state, async () => {});
  assert.equal(state.disconnected, true);
});

test("handleFacadeJsonRpc reports a gone child as a JSON-RPC error", async () => {
  const state: FakeManagerState = {
    requests: [],
    disconnected: false,
    managedMissing: true,
  };
  const response = await handleFacadeJsonRpc(
    SERVER_ID,
    { id: 1, method: "tools/list" },
    makeFakeManager(state),
  );
  assert.equal((response as any).error.code, -32000);
  assert.match((response as any).error.message, /not connected/);
});
