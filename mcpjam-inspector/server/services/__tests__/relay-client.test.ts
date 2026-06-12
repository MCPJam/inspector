import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  RelayConnection,
  CLOSE_BAD_TOKEN,
  CLOSE_REPLACED,
} from "../relay-client.js";

// ── Fake relay edge ─────────────────────────────────────────────────────────
// Speaks just enough mcpjam-tunnel.v1 to drive the client: sends hello on
// connect, exposes received frames, and lets tests push req frames and
// close codes.

interface EdgeConn {
  ws: WebSocket;
  authHeader: string | undefined;
  frames: any[];
  binary: { kind: number; id: number; payload: Buffer }[];
}

function startFakeEdge(): Promise<{
  port: number;
  connections: EdgeConn[];
  close: () => Promise<void>;
}> {
  const connections: EdgeConn[] = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/agent" });
  wss.on("connection", (ws, req) => {
    const conn: EdgeConn = {
      ws,
      authHeader: req.headers.authorization,
      frames: [],
      binary: [],
    };
    connections.push(conn);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = data as Buffer;
        conn.binary.push({
          kind: buf.readUInt8(0),
          id: buf.readUInt32BE(1),
          payload: buf.subarray(5),
        });
      } else {
        conn.frames.push(JSON.parse(String(data)));
      }
    });
    ws.send(
      JSON.stringify({
        t: "hello",
        proto: 1,
        slug: "testslug0001",
        limits: { maxReqBody: 10485760, chunk: 65536, maxInflight: 32 },
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        connections,
        close: () =>
          new Promise<void>((r) => {
            for (const c of connections) c.ws.terminate();
            wss.close();
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

// ── Local inspector stand-in ────────────────────────────────────────────────

let localServer: http.Server;
let localPort: number;
const localRequests: { method: string; url: string; body: string }[] = [];

beforeAll(async () => {
  localServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      localRequests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if ((req.url ?? "").includes("/sse")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => res.write("data: two\n\n"), 30);
        return; // stays open
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sawUrl: req.url }));
    });
  });
  await new Promise<void>((r) => localServer.listen(0, "127.0.0.1", () => r()));
  localPort = (localServer.address() as AddressInfo).port;
});

afterAll(async () => {
  localServer.closeAllConnections?.();
  await new Promise<void>((r) => localServer.close(() => r()));
});

function makeConnection(
  edgePort: number,
  overrides: Partial<{
    onPermanentFailure: (reason: string, code: number) => void;
  }> = {}
): RelayConnection {
  return new RelayConnection({
    serverId: "test-server",
    slug: "testslug0001",
    relayWsUrl: `ws://127.0.0.1:${edgePort}/agent`,
    connectToken: "test-connect-token",
    localAddr: `http://localhost:${localPort}`,
    publicHost: "testslug0001.tunnels.mcpjam.com",
    onPermanentFailure: overrides.onPermanentFailure,
  });
}

async function waitFor<T>(
  probe: () => T | undefined | false,
  timeoutMs = 2000
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value as T;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let activeConnections: RelayConnection[] = [];
let activeEdges: Awaited<ReturnType<typeof startFakeEdge>>[] = [];

afterEach(async () => {
  for (const c of activeConnections) c.close();
  activeConnections = [];
  for (const e of activeEdges) await e.close();
  activeEdges = [];
  localRequests.length = 0;
});

describe("RelayConnection", () => {
  it("connects with the bearer token and resolves on hello", async () => {
    const edge = await startFakeEdge();
    activeEdges.push(edge);
    const conn = makeConnection(edge.port);
    activeConnections.push(conn);

    await conn.connect();
    expect(conn.isConnected).toBe(true);
    expect(edge.connections[0].authHeader).toBe("Bearer test-connect-token");
  });

  it("replays req frames against the local server and streams the response back — URL verbatim incl. ?k=", async () => {
    const edge = await startFakeEdge();
    activeEdges.push(edge);
    const conn = makeConnection(edge.port);
    activeConnections.push(conn);
    await conn.connect();
    const ec = edge.connections[0];

    ec.ws.send(
      JSON.stringify({
        t: "req",
        id: 7,
        method: "POST",
        url: "/api/mcp/adapter-http/test-server?k=sekret&sessionId=s1",
        headers: [
          ["content-type", "application/json"],
          ["x-forwarded-host", "testslug0001.tunnels.mcpjam.com"],
        ],
        hasBody: true,
      })
    );
    // body as one binary chunk, then req_end
    const payload = Buffer.from(JSON.stringify({ hello: "world" }));
    const frame = Buffer.allocUnsafe(5 + payload.length);
    frame.writeUInt8(0x01, 0);
    frame.writeUInt32BE(7, 1);
    payload.copy(frame, 5);
    ec.ws.send(frame);
    ec.ws.send(JSON.stringify({ t: "req_end", id: 7 }));

    const res = await waitFor(() =>
      ec.frames.find((f) => f.t === "res" && f.id === 7)
    );
    expect(res.status).toBe(200);
    await waitFor(() => ec.frames.find((f) => f.t === "res_end" && f.id === 7));

    const chunks = ec.binary.filter((b) => b.kind === 0x02 && b.id === 7);
    const body = JSON.parse(
      Buffer.concat(chunks.map((c) => c.payload)).toString("utf8")
    );
    // The ?k= secret reached the local adapter untouched (its SSE endpoint
    // event depends on it) and the body round-tripped.
    expect(body.sawUrl).toBe(
      "/api/mcp/adapter-http/test-server?k=sekret&sessionId=s1"
    );
    expect(localRequests[0].body).toBe(JSON.stringify({ hello: "world" }));
  });

  it("streams SSE chunk-by-chunk as separate frames", async () => {
    const edge = await startFakeEdge();
    activeEdges.push(edge);
    const conn = makeConnection(edge.port);
    activeConnections.push(conn);
    await conn.connect();
    const ec = edge.connections[0];

    ec.ws.send(
      JSON.stringify({
        t: "req",
        id: 9,
        method: "GET",
        url: "/api/mcp/adapter-http/test-server/sse?k=sekret",
        headers: [["accept", "text/event-stream"]],
        hasBody: false,
      })
    );

    await waitFor(() => ec.frames.find((f) => f.t === "res" && f.id === 9));
    await waitFor(() => {
      const text = Buffer.concat(
        ec.binary.filter((b) => b.id === 9).map((b) => b.payload)
      ).toString("utf8");
      return text.includes("data: one") && text.includes("data: two");
    });
    // Two events arrived in at least two separate frames (no buffering),
    // and the stream is still open (no res_end).
    expect(ec.binary.filter((b) => b.id === 9).length).toBeGreaterThanOrEqual(
      2
    );
    expect(ec.frames.find((f) => f.t === "res_end" && f.id === 9)).toBe(
      undefined
    );

    // An edge abort tears down the local request without killing the socket.
    ec.ws.send(JSON.stringify({ t: "abort", id: 9, code: "client_gone" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.isConnected).toBe(true);
  });

  it("treats 4001 (replaced) as PERMANENT — no reconnect, surfaced to the owner", async () => {
    const edge = await startFakeEdge();
    activeEdges.push(edge);
    let permanent: { reason: string; code: number } | null = null;
    const conn = makeConnection(edge.port, {
      onPermanentFailure: (reason, code) => {
        permanent = { reason, code };
      },
    });
    activeConnections.push(conn);
    await conn.connect();

    edge.connections[0].ws.close(CLOSE_REPLACED, "replaced");
    await waitFor(() => permanent !== null);
    expect(permanent!.code).toBe(CLOSE_REPLACED);
    expect(conn.permanentFailure).toMatch(/another inspector/i);

    // No reconnect attempt: the connection count must stay at 1.
    await new Promise((r) => setTimeout(r, 300));
    expect(edge.connections.length).toBe(1);
  });

  it("treats 4000 (bad token) as permanent", async () => {
    const edge = await startFakeEdge();
    activeEdges.push(edge);
    let code = 0;
    const conn = makeConnection(edge.port, {
      onPermanentFailure: (_r, c) => {
        code = c;
      },
    });
    activeConnections.push(conn);
    await conn.connect();

    edge.connections[0].ws.close(CLOSE_BAD_TOKEN, "expired");
    await waitFor(() => code !== 0);
    expect(code).toBe(CLOSE_BAD_TOKEN);
    await new Promise((r) => setTimeout(r, 300));
    expect(edge.connections.length).toBe(1);
  });

  it("reconnects immediately on 1012 (edge restart)", async () => {
    const edge = await startFakeEdge();
    activeEdges.push(edge);
    const conn = makeConnection(edge.port);
    activeConnections.push(conn);
    await conn.connect();

    edge.connections[0].ws.close(1012, "edge restarting");
    await waitFor(() => edge.connections.length === 2, 3000);
    await waitFor(() => conn.isConnected);
    expect(conn.permanentFailure).toBeNull();
  });

  it("does not reconnect after an intentional close()", async () => {
    const edge = await startFakeEdge();
    activeEdges.push(edge);
    const conn = makeConnection(edge.port);
    activeConnections.push(conn);
    await conn.connect();

    conn.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(edge.connections.length).toBe(1);
    expect(conn.isConnected).toBe(false);
  });
});
