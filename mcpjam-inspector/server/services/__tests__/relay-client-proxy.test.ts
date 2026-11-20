/**
 * The relay's WebSocket through a CONNECT proxy, end to end. The TLS edge
 * answers as `relay.test`, a name nothing resolves, so only the proxy can
 * reach it, as in a cloud session with no DNS. The certificate is minted per
 * run with the system `openssl` and trusted in this test worker only.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { WebSocketServer } from "ws";
import { RelayConnection } from "../relay-client.js";

const OPENSSL = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function mintCertificate(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "mcpjam-relay-proxy-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=relay.test",
        "-addext",
        "subjectAltName=DNS:relay.test,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    return {
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
      key: readFileSync(join(dir, "key.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected a TCP listener"));
        return;
      }
      resolve(address.port);
    }),
  );
}

function closeServer(server: net.Server, sockets: Set<Duplex>) {
  for (const socket of sockets) socket.destroy();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A CONNECT proxy that sends every host to loopback and records what it was asked. */
async function startConnectProxy() {
  const connects: { target: string; auth: string | undefined }[] = [];
  const sockets = new Set<Duplex>();
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (req, client, head) => {
    const target = req.url ?? "";
    connects.push({ target, auth: req.headers["proxy-authorization"] });
    const upstream = net.connect(
      Number(target.split(":").pop()),
      "127.0.0.1",
      () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      },
    );
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
  });
  const port = await listen(server);
  return { port, connects, close: () => closeServer(server, sockets) };
}

/** A TLS relay edge that says hello and records the bearer it was dialed with. */
async function startTlsEdge(certificate: { cert: string; key: string }) {
  const authorizations: (string | undefined)[] = [];
  const sockets = new Set<Duplex>();
  const server = https.createServer(certificate);
  server.on("connection", (socket) => sockets.add(socket));
  const wss = new WebSocketServer({ server, path: "/agent" });
  wss.on("connection", (ws, req) => {
    authorizations.push(req.headers.authorization);
    ws.send(
      JSON.stringify({
        t: "hello",
        proto: 1,
        slug: "testslug0001",
        limits: { maxReqBody: 10485760, chunk: 65536, maxInflight: 32 },
      }),
    );
  });
  const port = await listen(server);
  return {
    port,
    authorizations,
    close: () => {
      wss.close();
      return closeServer(server, sockets);
    },
  };
}

function relay(relayWsUrl: string): RelayConnection {
  return new RelayConnection({
    serverId: "test-server",
    slug: "testslug0001",
    relayWsUrl,
    connectToken: "connect-token",
    localAddr: "http://127.0.0.1:1",
    publicHost: "testslug0001.tunnels.example",
  });
}

/** Only `HTTPS_PROXY`, whatever the machine running the tests has set. */
function setProxyEnv(httpsProxy: string) {
  const others = [
    "https_proxy",
    "http_proxy",
    "HTTP_PROXY",
    "no_proxy",
    "NO_PROXY",
  ];
  for (const name of others) vi.stubEnv(name, "");
  vi.stubEnv("HTTPS_PROXY", httpsProxy);
}

describe.skipIf(!OPENSSL)("relay WebSocket through HTTPS_PROXY", () => {
  let proxy: Awaited<ReturnType<typeof startConnectProxy>>;
  let edge: Awaited<ReturnType<typeof startTlsEdge>>;
  let defaultCas: string[];
  const open: RelayConnection[] = [];

  beforeAll(async () => {
    const certificate = mintCertificate();
    defaultCas = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...defaultCas, certificate.cert]);
    proxy = await startConnectProxy();
    edge = await startTlsEdge(certificate);
  });

  afterEach(() => {
    for (const connection of open.splice(0)) connection.close();
    vi.unstubAllEnvs();
    proxy.connects.length = 0;
    edge.authorizations.length = 0;
  });

  afterAll(async () => {
    tls.setDefaultCACertificates(defaultCas);
    await proxy?.close();
    await edge?.close();
  });

  it("opens the handshake through the proxy, with its credentials", async () => {
    setProxyEnv(`http://agent:p%40ss@127.0.0.1:${proxy.port}`);
    const connection = relay(`wss://relay.test:${edge.port}/agent`);
    open.push(connection);

    await connection.connect();

    expect(connection.isConnected).toBe(true);
    expect(proxy.connects).toEqual([
      {
        target: `relay.test:${edge.port}`,
        auth: `Basic ${Buffer.from("agent:p@ss").toString("base64")}`,
      },
    ]);
    expect(edge.authorizations).toEqual(["Bearer connect-token"]);
  }, 20_000);

  it("dials a loopback relay directly, past the proxy", async () => {
    setProxyEnv(`http://127.0.0.1:${proxy.port}`);
    const connection = relay(`wss://127.0.0.1:${edge.port}/agent`);
    open.push(connection);

    await connection.connect();

    expect(connection.isConnected).toBe(true);
    expect(proxy.connects).toEqual([]);
    expect(edge.authorizations).toEqual(["Bearer connect-token"]);
  }, 20_000);
});
