import { it, expect, vi } from "vitest";
import { createServer, request } from "node:http";
import { startLocalBrowserProxy } from "../egress-proxy.js";
import { createLocalBrowserSecurityPolicy } from "../security-policy.js";

it("forwards authenticated localhost development requests but denies the controller and strips proxy credentials", async () => {
  let headers: unknown;
  const site = createServer((req, res) => {
    headers = req.headers;
    res.end("development page");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as import("node:net").AddressInfo).port;
  const policy = createLocalBrowserSecurityPolicy({
    controllerUrls: ["http://localhost:62345"],
  });
  const proxy = await startLocalBrowserProxy(policy);
  const auth = `Basic ${Buffer.from(
    `${proxy.proxy.username}:${proxy.proxy.password}`,
  ).toString("base64")}`;
  const get = (target: string, authorized = true) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        proxy.proxy.server,
        {
          path: target,
          headers: authorized ? { "Proxy-Authorization": auth } : {},
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    expect(await get(`http://127.0.0.1:${port}/`)).toEqual({
      status: 200,
      body: "development page",
    });
    expect(headers).not.toHaveProperty("proxy-authorization");
    expect((await get("http://localhost:62345/api/session-token")).status).toBe(
      403,
    );
    expect((await get(proxy.proxy.server)).status).toBe(403);
    expect((await get(`http://127.0.0.1:${port}/`, false)).status).toBe(407);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});

// Force DNS ordering rather than depending on the runner's localhost resolver.
it.each(["127.0.0.1", "::1"])(
  "falls back to an HTTP server bound only to %s without replaying the request",
  async (host) => {
    let calls = 0;
    let receivedHost: string | undefined;
    let body = "";
    const site = createServer((req, res) => {
      calls++;
      receivedHost = req.headers.host;
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => res.end("ok"));
    });
    await new Promise<void>((resolve) => site.listen(0, host, resolve));
    const port = (site.address() as import("node:net").AddressInfo).port;
    const addresses =
      host === "127.0.0.1"
        ? [
            { address: "::1", family: 6 },
            { address: host, family: 4 },
          ]
        : [
            { address: "127.0.0.1", family: 4 },
            { address: host, family: 6 },
          ];
    const lookup = vi.fn().mockResolvedValue(addresses);
    const policy = createLocalBrowserSecurityPolicy({
      controllerUrls: [],
      lookup,
    });
    const proxy = await startLocalBrowserProxy(policy);
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const req = request(
          proxy.proxy.server,
          {
            method: "POST",
            path: `http://localhost:${port}/submit`,
            headers: {
              "Proxy-Authorization": `Basic ${Buffer.from(
                `${proxy.proxy.username}:${proxy.proxy.password}`,
              ).toString("base64")}`,
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () => resolve(`${res.statusCode}:${data}`));
          },
        );
        req.on("error", reject);
        req.end("one submission");
      });
      expect(result).toBe("200:ok");
      expect(calls).toBe(1);
      expect(body).toBe("one submission");
      expect(receivedHost).toBe(`localhost:${port}`);
      expect(lookup).toHaveBeenCalledExactlyOnceWith("localhost", {
        all: true,
        verbatim: true,
      });
    } finally {
      await proxy.close();
      policy.dispose?.();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    }
  },
);

it.each(["CONNECT", "upgrade"])(
  "falls back to IPv4 for %s tunnels",
  async (mode) => {
    const site = createServer();
    site.on("upgrade", (req, socket) => {
      expect(req.headers.host).toMatch(/^localhost:/);
      expect(req.headers).not.toHaveProperty("proxy-authorization");
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello",
      );
    });
    site.on("request", (_req, res) => res.end("hello"));
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const port = (site.address() as import("node:net").AddressInfo).port;
    const lookup = vi.fn().mockResolvedValue([
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const policy = createLocalBrowserSecurityPolicy({
      controllerUrls: [],
      lookup,
    });
    const proxy = await startLocalBrowserProxy(policy);
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const req = request(proxy.proxy.server, {
          method: mode === "CONNECT" ? "CONNECT" : "GET",
          path:
            mode === "CONNECT"
              ? `localhost:${port}`
              : `http://localhost:${port}/ws`,
          headers: {
            "Proxy-Authorization": `Basic ${Buffer.from(
              `${proxy.proxy.username}:${proxy.proxy.password}`,
            ).toString("base64")}`,
            ...(mode === "upgrade"
              ? { Connection: "Upgrade", Upgrade: "websocket" }
              : {}),
          },
        });
        req.on("error", reject);
        req.on("response", (res) =>
          reject(new Error(`Unexpected response ${res.statusCode}`)),
        );
        req.on(
          mode === "CONNECT" ? "connect" : "upgrade",
          (res, socket, head) => {
            expect(res.statusCode).toBe(mode === "CONNECT" ? 200 : 101);
            let data = head.toString();
            socket.on("data", (chunk: Buffer) => {
              data += chunk;
            });
            socket.on("error", reject);
            socket.on("end", () => resolve(data));
            if (mode === "CONNECT")
              socket.write(
                `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
              );
          },
        );
        req.end();
      });
      expect(result).toContain("hello");
      expect(lookup).toHaveBeenCalledOnce();
    } finally {
      await proxy.close();
      policy.dispose?.();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    }
  },
);
