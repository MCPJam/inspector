/**
 * `http://localhost:<port>` on the browser box, served from the workspace.
 *
 * The hosted browser runs on its own desktop box, while the person's app runs
 * in the conversation's workspace. This relay listens on the browser box's
 * loopback at the app's own port, so the page keeps the literal origin the
 * developer typed, and carries each connection through a keyed byte tunnel to
 * the workspace sidecar (`workspace-preview/tunnel-sidecar.ts`). The request
 * bytes reach the app unchanged, `Host: localhost:<port>` included.
 *
 * The relay is also the guard. Anything the browser marks as sent by another
 * site is refused here, before it leaves the box: an injected credential would
 * otherwise authenticate every page the agent visits, and Chrome's local
 * network permission is a prompt the agent could be talked into accepting.
 * Requests addressed to any other Host are refused too, which keeps DNS
 * rebinding out even for dev servers that skip their own host check.
 *
 * The upstream address, routing headers and keys stay in this process. They
 * never reach a page, the ledger or a log.
 */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import { PassThrough, type Duplex } from "node:stream";

/** Announced in `/v1/status.features` by a daemon that serves `/v1/preview`. */
export const WORKSPACE_PREVIEW_FEATURE = "workspace-preview-v1";

export interface PreviewGrant {
  port: number;
  /** `wss://` or `ws://` base the workspace tunnel is reached at. */
  upstreamUrl: string;
  /** Routing or traffic headers the provider needs on the tunnel handshake. */
  upstreamHeaders: Record<string, string>;
  /** This port's key, derived by the inspector from the workspace secret. */
  key: string;
}

export type PreviewGrantResult =
  | { ok: true; port: number }
  | { ok: false; error: "invalid_grant" | "port_unavailable" };

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,4096}$/;

/** A body is a grant only if every field is exactly what the tunnel needs. */
export function parsePreviewGrant(body: unknown): PreviewGrant | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { port, upstreamUrl, upstreamHeaders, key } = body as Record<
    string,
    unknown
  >;
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535)
    return undefined;
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) return undefined;
  if (typeof upstreamUrl !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(upstreamUrl);
  } catch {
    return undefined;
  }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    return undefined;
  const headers: Record<string, string> = {};
  if (upstreamHeaders !== undefined) {
    if (typeof upstreamHeaders !== "object" || upstreamHeaders === null) return undefined;
    for (const [name, value] of Object.entries(upstreamHeaders)) {
      if (!HEADER_NAME.test(name) || typeof value !== "string" || !HEADER_VALUE.test(value))
        return undefined;
      headers[name] = value;
    }
  }
  return { port: port as number, upstreamUrl: url.toString(), upstreamHeaders: headers, key };
}

/**
 * Why a browser request must not reach the app, or `undefined` to forward it.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be forged by a page. A
 * navigation the agent or the person typed is `none`; the app's own requests
 * are `same-origin`. Another granted preview port is `same-site`, which a
 * frontend calling its API on a second port needs.
 */
export function previewRequestRefusal(
  headers: http.IncomingHttpHeaders,
  port: number,
  grantedPorts: ReadonlySet<number>,
): "host" | "cross-site" | "origin" | undefined {
  const host = (headers.host ?? "").toLowerCase();
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}` && host !== `[::1]:${port}`)
    return "host";
  const site = headers["sec-fetch-site"];
  const origin = headers.origin;
  const granted = (value: string) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        grantedPorts.has(Number(url.port))
      );
    } catch {
      return false;
    }
  };
  if (site === "cross-site") return "cross-site";
  if (site === "same-site" && !(origin && granted(origin))) return "cross-site";
  if (origin && origin !== "null" && !granted(origin)) return "origin";
  return undefined;
}

function openTunnel(grant: PreviewGrant): Promise<Duplex> {
  const url = new URL(grant.upstreamUrl);
  const secure = url.protocol === "wss:";
  const port = Number(url.port) || (secure ? 443 : 80);
  const path = `${url.pathname.replace(/\/+$/, "")}/tunnel?port=${grant.port}`;
  const head = [
    `GET ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    `x-mcpjam-preview-key: ${grant.key}`,
    ...Object.entries(grant.upstreamHeaders).map(([k, v]) => `${k}: ${v}`),
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const socket: net.Socket = secure
      ? tls.connect({ host: url.hostname, servername: url.hostname, port })
      : net.connect(port, url.hostname);
    socket.once(secure ? "secureConnect" : "connect", () =>
      socket.write(`${head}\r\n\r\n`),
    );
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 16384) socket.destroy(new Error("tunnel_handshake_too_large"));
        return;
      }
      socket.off("data", onData);
      const status = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
      if (!/^HTTP\/1\.1 101 /.test(status)) {
        socket.destroy();
        reject(new Error(status.includes(" 502 ") ? "app_not_listening" : "tunnel_refused"));
        return;
      }
      // The deadline covers the whole handshake: an edge that accepts and
      // never answers would otherwise hold one of the agent's sockets forever.
      socket.setTimeout(0);
      const rest = buf.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.setTimeout(15_000, () => socket.destroy(new Error("tunnel_timeout")));
  });
}

const notListening = (port: number) =>
  `<!doctype html><title>Nothing on port ${port}</title><p>Nothing is running on port ${port} on this conversation's computer. Start your app, then reload.</p>`;

interface PortRelay {
  grant: PreviewGrant;
  servers: http.Server[];
  agent: http.Agent;
}

export class WorkspacePreviewRelay {
  private readonly ports = new Map<number, PortRelay>();
  /** Every accepted connection, upgraded ones included, so shutdown can end them. */
  private readonly sockets = new Set<net.Socket>();
  /** Grants run one at a time: two navigations to a new port must not race to listen. */
  private queue: Promise<unknown> = Promise.resolve();

  private granted(): ReadonlySet<number> {
    return new Set(this.ports.keys());
  }

  /** Serve `grant.port`, or repoint an existing listener at a new upstream. */
  grant(grant: PreviewGrant): Promise<PreviewGrantResult> {
    const run = this.queue.then(() => this.grantNow(grant));
    // The caller gets `run`, rejection included; the queue only records that
    // this grant finished, so one failure cannot stall the grants after it.
    this.queue = run.then(
      () => "done",
      () => "done",
    );
    return run;
  }

  private async grantNow(grant: PreviewGrant): Promise<PreviewGrantResult> {
    const existing = this.ports.get(grant.port);
    if (existing) {
      if (existing.grant.upstreamUrl !== grant.upstreamUrl || existing.grant.key !== grant.key) {
        existing.agent.destroy();
        existing.grant = grant;
        existing.agent = this.agentFor(existing);
      }
      return { ok: true, port: grant.port };
    }
    const relay: PortRelay = { grant, servers: [], agent: new http.Agent() };
    relay.agent = this.agentFor(relay);
    const server = this.serverFor(relay);
    try {
      await listen(server, grant.port, "127.0.0.1");
    } catch {
      relay.agent.destroy();
      return { ok: false, error: "port_unavailable" };
    }
    relay.servers.push(server);
    // Chromium may resolve `localhost` to ::1 first. A box without IPv6
    // loopback only loses that address, so a failure here is not an error.
    const v6 = this.serverFor(relay);
    if (await listen(v6, grant.port, "::1").then(() => true, () => false))
      relay.servers.push(v6);
    this.ports.set(grant.port, relay);
    return { ok: true, port: grant.port };
  }

  async close(): Promise<void> {
    const all = [...this.ports.values()];
    this.ports.clear();
    // `server.close` waits for every open socket, and a hot-reload WebSocket
    // never ends on its own; the daemon would never exit.
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(
      all.flatMap((relay) => {
        relay.agent.destroy();
        return relay.servers.map(
          (server) => new Promise<void>((done) => server.close(() => done())),
        );
      }),
    );
  }

  private agentFor(relay: PortRelay): http.Agent {
    class TunnelAgent extends http.Agent {
      override createConnection(
        _options: http.ClientRequestArgs,
        callback?: (error: Error | null, stream: Duplex) => void,
      ): Duplex | undefined {
        openTunnel(relay.grant).then(
          (socket) => callback?.(null, socket),
          (error: Error) => {
            // Node reports the error on the request and never reads this
            // stream; it exists because the callback's type requires one.
            const unused = new PassThrough();
            unused.destroy();
            callback?.(error, unused);
          },
        );
        return undefined;
      }
    }
    return new TunnelAgent({ keepAlive: true, maxSockets: 8 });
  }

  private serverFor(relay: PortRelay): http.Server {
    const port = relay.grant.port;
    const server = http.createServer((req, res) => {
      if (previewRequestRefusal(req.headers, port, this.granted())) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("This preview only answers requests from its own pages.");
        return;
      }
      const upstream = http.request(
        {
          agent: relay.agent,
          method: req.method,
          path: req.url,
          headers: req.headers,
          setHost: false,
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
          answer.pipe(res);
        },
      );
      upstream.on("error", (error) => {
        if (res.headersSent) return void res.destroy();
        const idle = error.message === "app_not_listening";
        res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
        res.end(idle ? notListening(port) : "The conversation's computer did not answer. Reload to try again.");
      });
      req.pipe(upstream);
    });
    server.on("connection", (socket: net.Socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.on("upgrade", (req, client: Duplex, head: Buffer) => {
      // Node drops its own error listener when it hands over an upgraded
      // socket, so a reset while the tunnel opens would crash the daemon.
      let gone = false;
      client.on("error", () => client.destroy());
      client.once("close", () => {
        gone = true;
      });
      if (previewRequestRefusal(req.headers, port, this.granted())) {
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      openTunnel(relay.grant).then(
        (tunnel) => {
          if (gone) return void tunnel.destroy();
          const lines = [`${req.method} ${req.url} HTTP/1.1`];
          for (let i = 0; i < req.rawHeaders.length; i += 2)
            lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
          tunnel.write(`${lines.join("\r\n")}\r\n\r\n`);
          if (head.length) tunnel.write(head);
          tunnel.pipe(client);
          client.pipe(tunnel);
          tunnel.on("error", () => client.destroy());
          client.once("close", () => tunnel.destroy());
        },
        () => client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
      );
    });
    return server;
  }
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
