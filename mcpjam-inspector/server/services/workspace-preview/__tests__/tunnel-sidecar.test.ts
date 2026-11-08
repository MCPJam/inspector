import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewKeyFor } from "../workspace-tunnel";
import {
  APP_HOST,
  canBindIpv6Loopback,
  startSidecar,
  type RunningSidecar,
} from "./preview-tunnel-harness";

/** Send one handshake and whatever follows it; resolve with every byte back. */
function exchange(sidecarPort: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const socket = net.connect(sidecarPort, "127.0.0.1", () => socket.write(request));
    socket.on("data", (chunk) => {
      out += chunk.toString();
    });
    socket.on("close", () => resolve(out));
    setTimeout(() => socket.destroy(), 500);
  });
}

const handshake = (port: number, key: string, extra = "") =>
  `GET /tunnel?port=${port} HTTP/1.1\r\nHost: edge\r\nUpgrade: websocket\r\n` +
  `Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
  `x-mcpjam-preview-key: ${key}\r\n\r\n${extra}`;

describe("workspace preview sidecar", () => {
  let sidecar: RunningSidecar;
  let app: net.Server;
  let appPort: number;

  beforeAll(async () => {
    sidecar = await startSidecar();
    app = net.createServer((socket) =>
      socket.once("data", (request) =>
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${request.length}\r\n\r\n${request}`),
      ),
    );
    await new Promise<void>((resolve) => app.listen(0, APP_HOST, resolve));
    appPort = (app.address() as net.AddressInfo).port;
  });
  afterAll(() => {
    sidecar.stop();
    app.close();
  });

  it("splices the browser's own request to the app after a keyed handshake", async () => {
    const out = await exchange(
      sidecar.port,
      handshake(appPort, previewKeyFor(sidecar.secret, appPort), `GET / HTTP/1.1\r\nHost: localhost:${appPort}\r\n\r\n`),
    );
    expect(out.startsWith("HTTP/1.1 101 Switching Protocols\r\n")).toBe(true);
    expect(out).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(out).toContain(`Host: localhost:${appPort}`);
    expect(out).not.toContain("x-mcpjam-preview-key");
  });

  it("refuses another port's key", async () => {
    const out = await exchange(sidecar.port, handshake(appPort, previewKeyFor(sidecar.secret, appPort + 1)));
    expect(out.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
  });

  it("refuses envd and its own port even with a valid key", async () => {
    for (const port of [49983, sidecar.port]) {
      const out = await exchange(sidecar.port, handshake(port, previewKeyFor(sidecar.secret, port)));
      expect(out.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
    }
  });

  it("answers plain HTTP with 404 and never proxies it", async () => {
    const out = await exchange(sidecar.port, `GET / HTTP/1.1\r\nHost: localhost:${appPort}\r\n\r\n`);
    expect(out.split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
  });

  it("refuses a handshake whose headers never end", async () => {
    const out = await exchange(sidecar.port, `GET /tunnel?port=${appPort} HTTP/1.1\r\nX: ${"a".repeat(20_000)}`);
    expect(out.split("\r\n")[0]).toBe("HTTP/1.1 431 Request Header Fields Too Large");
  });

  it("answers 502 when nothing listens on the granted port", async () => {
    const closed = 1024 + ((appPort + 7) % 50000);
    const out = await exchange(sidecar.port, handshake(closed, previewKeyFor(sidecar.secret, closed)));
    expect(out.split("\r\n")[0]).toBe("HTTP/1.1 502 Bad Gateway");
  });

  it("keeps its state file private to the workspace user", () => {
    expect(sidecar.stateMode).toBe(0o600);
  });
});

const ipv6Loopback = await canBindIpv6Loopback();

describe("workspace preview sidecar, shipped targets", () => {
  it.skipIf(!ipv6Loopback)(
    "reaches an app bound only to ::1 when 127.0.0.1 refuses",
    async () => {
      const sidecar = await startSidecar({ target: null });
      const app = net.createServer((socket) =>
        socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nv6")),
      );
      await new Promise<void>((resolve) => app.listen(0, "::1", resolve));
      const port = (app.address() as net.AddressInfo).port;
      try {
        const out = await exchange(
          sidecar.port,
          handshake(port, previewKeyFor(sidecar.secret, port), `GET / HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`),
        );
        expect(out.startsWith("HTTP/1.1 101 ")).toBe(true);
        expect(out.endsWith("v6")).toBe(true);
      } finally {
        sidecar.stop();
        app.close();
      }
    },
  );
});
