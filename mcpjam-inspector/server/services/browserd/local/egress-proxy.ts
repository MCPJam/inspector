/** Local browser egress only. No TLS interception, body capture, or direct fallback. */
import { createServer, request, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  registerBrowserController,
  type LocalBrowserSecurityPolicy,
} from "./security-policy.js";

export async function startLocalBrowserProxy(
  policy: LocalBrowserSecurityPolicy,
) {
  const username = "browser";
  const password = randomBytes(32).toString("hex");
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  );
  const sockets = new Set<Socket>();
  let closed = false;
  const authorized = (req: IncomingMessage) => {
    const actual = Buffer.from(req.headers["proxy-authorization"] ?? "");
    return (
      !closed &&
      policy.isActive() &&
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    );
  };
  const server = createServer(
    { maxHeaderSize: 64 * 1024, requestTimeout: 120_000 },
    async (req, res) => {
      if (!authorized(req)) {
        res.writeHead(407, {
          "Proxy-Authenticate": 'Basic realm="MCPJam managed browser"',
        });
        res.end();
        return;
      }
      try {
        const target = new URL(req.url ?? "");
        if (
          target.protocol !== "http:" ||
          target.username ||
          target.password ||
          !policy.allowsRequest(target.href)
        )
          throw new Error("denied");
        const address = await policy.resolveDestination(
          target.hostname,
          Number(target.port || 80),
        );
        if (closed || req.destroyed) throw new Error("closed");
        const headers: Record<string, string | string[] | undefined> = {
          ...req.headers,
          host: target.host,
        };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        const upstream = request(
          {
            hostname: address.address,
            family: address.family,
            port: target.port || 80,
            path: target.pathname + target.search,
            method: req.method,
            headers,
            maxHeaderSize: 64 * 1024,
            agent: false,
          },
          (incoming) => {
            res.writeHead(incoming.statusCode ?? 502, incoming.headers);
            incoming.pipe(res);
          },
        );
        upstream.on("socket", (socket) => track(socket));
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      } catch {
        res.writeHead(403);
        res.end("Browser destination blocked.");
      }
    },
  );
  function track(socket: Socket) {
    if (closed || sockets.size >= 256) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }
  server.maxConnections = 128;
  server.on("connection", track);
  server.on("clientError", (_error, socket) => socket.destroy());
  // CONNECT covers HTTPS and WSS; HTTP Upgrade covers ws://. Neither is a
  // request interceptor shim: worker traffic goes through the same transport.
  const tunnel = async (
    req: IncomingMessage,
    downstream: Socket,
    head: Buffer,
    upgrade: boolean,
  ) => {
    if (!authorized(req)) {
      downstream.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="MCPJam managed browser"\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    try {
      const target = new URL(upgrade ? req.url ?? "" : `https://${req.url}`);
      if (
        !(upgrade ? ["http:", "ws:"] : ["https:"]).includes(target.protocol) ||
        target.username ||
        target.password ||
        !policy.allowsRequest(target.href)
      )
        throw new Error("denied");
      const destination = await policy.resolveDestination(
        target.hostname,
        Number(target.port || (upgrade ? 80 : 443)),
      );
      if (closed || downstream.destroyed) throw new Error("closed");
      const upstream = connect({
        host: destination.address,
        family: destination.family,
        port: Number(target.port || (upgrade ? 80 : 443)),
      });
      track(upstream);
      upstream.setTimeout(30_000, () => {
        if (upstream.connecting) upstream.destroy();
      });
      downstream.once("close", () => upstream.destroy());
      upstream.once("close", () => downstream.destroy());
      upstream.once("connect", () => {
        upstream.setTimeout(0);
        if (closed || !policy.isActive()) {
          upstream.destroy();
          return;
        }
        if (upgrade) {
          const headers = Object.entries({
            ...req.headers,
            host: target.host,
          }).filter(
            ([key]) =>
              !["proxy-authorization", "proxy-connection"].includes(
                key.toLowerCase(),
              ),
          );
          upstream.write(
            `${req.method} ${target.pathname}${
              target.search
            } HTTP/1.1\r\n${headers
              .map(
                ([key, value]) =>
                  `${key}: ${Array.isArray(value) ? value.join(", ") : value}`,
              )
              .join("\r\n")}\r\n\r\n`,
          );
        } else downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      });
    } catch {
      downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  };
  server.on("connect", (req, socket, head) => {
    void tunnel(req, socket as Socket, head, false);
  });
  server.on("upgrade", (req, socket, head) => {
    void tunnel(req, socket as Socket, head, true);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Browser network policy unavailable.");
  const url = `http://127.0.0.1:${address.port}`;
  const unregister = registerBrowserController(url);
  let unsubscribe: (() => void) | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unregister();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  server.on("error", () => {
    void close();
  });
  unsubscribe = policy.onRevoked(close);
  return {
    proxy: { server: url, username, password, bypass: "<-loopback>" },
    close,
  };
}
