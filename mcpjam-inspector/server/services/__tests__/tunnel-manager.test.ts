import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { tunnelManager } from "../tunnel-manager.js";
import { isActiveTunnelDomain } from "../tunnel-registry.js";

const SLUG = "tmslug000001";
const HOST = `${SLUG}.tunnels.mcpjam.com`;

// Fake relay edge: every agent gets a hello (which resolves connect()). When
// `closeCodeAfterHello` is set, the edge immediately closes with that code,
// exercising the "permanent close racing registration" path.
function startFakeEdge(opts: { closeCodeAfterHello?: number } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/agent" });
  wss.on("connection", (ws) => {
    ws.send(
      JSON.stringify({
        t: "hello",
        proto: 1,
        slug: SLUG,
        limits: { maxReqBody: 10485760, chunk: 65536, maxInflight: 32 },
      })
    );
    if (opts.closeCodeAfterHello) {
      ws.close(opts.closeCodeAfterHello, "test close");
    }
  });
  return new Promise<{ port: number; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve({
          port: (server.address() as AddressInfo).port,
          close: () =>
            new Promise<void>((r) => {
              wss.close();
              server.closeAllConnections?.();
              server.close(() => r());
            }),
        });
      });
    }
  );
}

let localServer: http.Server;
let localPort: number;

beforeAll(async () => {
  localServer = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((r) => localServer.listen(0, "127.0.0.1", () => r()));
  localPort = (localServer.address() as AddressInfo).port;
});

afterAll(async () => {
  localServer.closeAllConnections?.();
  await new Promise<void>((r) => localServer.close(() => r()));
});

// Close any live tunnel first: a healthy RelayConnection reconnects on an
// abnormal socket close, so tearing down the edge before the tunnel would
// leave the edge's server.close() waiting on a reconnecting client.
afterEach(async () => {
  await tunnelManager.closeAll();
});

function grantOptions(port: number) {
  return {
    localAddr: `http://localhost:${localPort}`,
    slug: SLUG,
    relayWsUrl: `ws://127.0.0.1:${port}/agent`,
    connectToken: "tm-test-token",
    publicUrl: `https://${HOST}/api/mcp/adapter-http/srv?k=secret123`,
    secretVersion: 1,
  };
}

describe("tunnelManager relay lifecycle", () => {
  it("registers a live tunnel and exposes its bearer URL", async () => {
    const edge = await startFakeEdge();
    try {
      const opts = grantOptions(edge.port);
      await tunnelManager.createTunnel("srv", opts);
      expect(tunnelManager.getServerTunnelUrl("srv")).toBe(opts.publicUrl);
      expect(isActiveTunnelDomain(HOST)).toBe(true);
      // Stop the tunnel before edge teardown so it doesn't reconnect into a
      // closing server (which would hang server.close()).
      await tunnelManager.closeTunnel("srv");
    } finally {
      await edge.close();
    }
  });

  it("never persists a tunnel whose relay permanently closes during/after the handshake", async () => {
    // 4001 = replaced (permanent). Closing right after hello races the
    // post-connect registration; the invariant is that no live entry and no
    // registered domain survive, whichever branch handles the close.
    const edge = await startFakeEdge({ closeCodeAfterHello: 4001 });
    try {
      const opts = grantOptions(edge.port);
      let threw = false;
      try {
        await tunnelManager.createTunnel("srv", opts);
      } catch {
        threw = true;
      }

      // Allow a close that landed just after registration to propagate.
      await new Promise((r) => setTimeout(r, 50));

      // Either createTunnel threw (guard caught it pre-registration) or it
      // registered and dropEntry removed it — both leave no dead tunnel.
      expect(tunnelManager.getServerTunnelUrl("srv")).toBeNull();
      expect(isActiveTunnelDomain(HOST)).toBe(false);
      // A permanent close must never silently yield a live tunnel.
      expect(threw || tunnelManager.getServerTunnelUrl("srv") === null).toBe(
        true
      );
    } finally {
      await edge.close();
    }
  });
});
