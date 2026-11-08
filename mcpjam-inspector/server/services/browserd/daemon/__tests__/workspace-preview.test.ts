import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { previewKeyFor } from "../../../workspace-preview/workspace-tunnel";
import {
  APP_HOST,
  startSidecar,
  type RunningSidecar,
} from "../../../workspace-preview/__tests__/preview-tunnel-harness";
import {
  parsePreviewGrant,
  previewRequestRefusal,
  WorkspacePreviewRelay,
} from "../workspace-preview";

const KEY = "b".repeat(64);

describe("parsePreviewGrant", () => {
  const valid = { port: 5173, upstreamUrl: "wss://41000-ws1.e2b.app", upstreamHeaders: { "e2b-traffic-access-token": "t" }, key: KEY };

  it("accepts exactly what the tunnel needs", () => {
    expect(parsePreviewGrant(valid)).toEqual({ ...valid, upstreamUrl: "wss://41000-ws1.e2b.app/" });
  });

  it.each([
    ["a privileged port", { ...valid, port: 80 }],
    ["a short key", { ...valid, key: "abc" }],
    ["an http upstream", { ...valid, upstreamUrl: "https://41000-ws1.e2b.app" }],
    ["upstream credentials", { ...valid, upstreamUrl: "wss://u:p@41000-ws1.e2b.app" }],
    ["a header with a newline", { ...valid, upstreamHeaders: { x: "a\r\nb" } }],
    ["no body", null],
  ])("refuses %s", (_label, body) => {
    expect(parsePreviewGrant(body)).toBeUndefined();
  });
});

describe("previewRequestRefusal", () => {
  const granted = new Set([5173, 3000]);
  it.each([
    ["a typed navigation", 5173, { host: "localhost:5173", "sec-fetch-site": "none" }, undefined],
    ["the app's own request", 5173, { host: "localhost:5173", "sec-fetch-site": "same-origin", origin: "http://localhost:5173" }, undefined],
    ["the frontend calling its granted API port", 3000, { host: "localhost:3000", "sec-fetch-site": "same-site", origin: "http://localhost:5173" }, undefined],
    ["another site", 5173, { host: "localhost:5173", "sec-fetch-site": "cross-site", origin: "https://evil.example" }, "cross-site"],
    ["an ungranted local page", 5173, { host: "localhost:5173", "sec-fetch-site": "same-site", origin: "http://localhost:9999" }, "cross-site"],
    ["a foreign origin without fetch metadata", 5173, { host: "localhost:5173", origin: "https://evil.example" }, "origin"],
    ["a rebinding host", 5173, { host: "evil.example:5173" }, "host"],
    ["another port's host", 5173, { host: "localhost:3000" }, "host"],
  ] as const)("%s", (_label, port, headers, expected) => {
    expect(previewRequestRefusal(headers, port, granted)).toBe(expected);
  });
});

describe("WorkspacePreviewRelay through the real sidecar", () => {
  let sidecar: RunningSidecar;
  let app: http.Server;
  let sockets: WebSocketServer;
  let port: number;
  let hits = 0;
  const relay = new WorkspacePreviewRelay();

  const get = (headers: Record<string, string>, method = "GET") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: "/echo", headers: { host: `localhost:${port}`, ...headers } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    sidecar = await startSidecar();
    app = http.createServer((req, res) => {
      hits += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ host: req.headers.host, sawKey: "x-mcpjam-preview-key" in req.headers }));
    });
    sockets = new WebSocketServer({ server: app });
    sockets.on("connection", (socket, req) => socket.send(`hello ${req.headers.host}`));
    await new Promise<void>((resolve) => app.listen(0, APP_HOST, resolve));
    port = (app.address() as net.AddressInfo).port;
    const granted = await relay.grant({
      port,
      upstreamUrl: `ws://127.0.0.1:${sidecar.port}`,
      upstreamHeaders: {},
      key: previewKeyFor(sidecar.secret, port),
    });
    expect(granted).toEqual({ ok: true, port });
  });
  afterAll(async () => {
    await relay.close();
    sockets.close();
    app.close();
    sidecar.stop();
  });

  it("delivers the browser's request with its localhost Host and no tunnel key", async () => {
    const res = await get({ "sec-fetch-site": "none" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ host: `localhost:${port}`, sawKey: false });
  });

  it("carries the app's WebSocket, as hot reload needs", async () => {
    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` } });
      socket.once("message", (data) => {
        resolve(data.toString());
        socket.close();
      });
      socket.once("error", reject);
    });
    expect(message).toBe(`hello localhost:${port}`);
  });

  it("refuses another site's request before it reaches the app", async () => {
    const before = hits;
    const res = await get({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }, "POST");
    expect(res.status).toBe(403);
    expect(hits).toBe(before);
  });

  it("refuses another site's WebSocket", async () => {
    const status = await new Promise<number | undefined>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { host: `localhost:${port}`, origin: "https://evil.example" } });
      socket.once("unexpected-response", (_req, res) => resolve(res.statusCode));
      socket.once("open", () => resolve(101));
      socket.once("error", () => resolve(undefined));
    });
    expect(status).toBe(403);
  });

  it("re-grants the same port without a second listener", async () => {
    await expect(
      relay.grant({ port, upstreamUrl: `ws://127.0.0.1:${sidecar.port}`, upstreamHeaders: {}, key: previewKeyFor(sidecar.secret, port) }),
    ).resolves.toEqual({ ok: true, port });
  });

  it("says nothing is running when the app stops", async () => {
    await new Promise<void>((resolve) => {
      sockets.close();
      app.close(() => resolve());
      app.closeAllConnections();
    });
    const res = await get({ "sec-fetch-site": "none" });
    expect(res.status).toBe(502);
    expect(res.body).toContain(`Nothing is running on port ${port} on this conversation's computer.`);
  });

  it("reports a port the browser box already uses", async () => {
    const busy = net.createServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const busyPort = (busy.address() as net.AddressInfo).port;
    await expect(
      relay.grant({ port: busyPort, upstreamUrl: `ws://127.0.0.1:${sidecar.port}`, upstreamHeaders: {}, key: KEY }),
    ).resolves.toEqual({ ok: false, error: "port_unavailable" });
    busy.close();
  });
});
