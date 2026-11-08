/**
 * The workspace half of the preview tunnel, shipped as source.
 *
 * The hosted browser runs on its own desktop box, so `http://localhost:5173`
 * in that browser is not the workspace where the app runs. E2B's HTTP edge is
 * the only path between the two boxes, and it rewrites `Host` to the sandbox
 * hostname on every request, which dev servers such as Vite reject. Its
 * create-time `maskRequestHost` cannot help a workspace that already exists.
 *
 * So the edge carries a byte tunnel instead of the app's HTTP. This sidecar
 * accepts one keyed WebSocket handshake per connection, answers `101`, and then
 * splices raw bytes to `127.0.0.1:<port>`. The browser box's relay writes the
 * browser's own request into that stream, so the app sees exactly what a local
 * browser would send, `Host: localhost:5173` included, and never an E2B or
 * MCPJam credential.
 *
 * Each port has its own key, an HMAC of the workspace's tunnel secret, so a
 * relay granted port 5173 cannot open 3000. The secret lives in this process
 * and its state file: code in the workspace can read both, which grants it
 * nothing it lacks, since it already serves those ports.
 *
 * Kept dependency-free and written for any Node 18+, because it runs on the
 * customer's image, not ours.
 */
export const PREVIEW_TUNNEL_VERSION = 1;
export const PREVIEW_TUNNEL_DIR = "/tmp/mcpjam-preview";
export const PREVIEW_TUNNEL_SCRIPT = `${PREVIEW_TUNNEL_DIR}/tunnel.mjs`;
export const PREVIEW_TUNNEL_STATE = `${PREVIEW_TUNNEL_DIR}/state.json`;

/** envd and the Code Interpreter server: never a preview target. */
export const PREVIEW_TUNNEL_DENIED_PORTS: readonly number[] = [49983, 49999];

export const PREVIEW_TUNNEL_SOURCE = String.raw`
import net from "node:net";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { writeFileSync, renameSync } from "node:fs";

const VERSION = ${PREVIEW_TUNNEL_VERSION};
const SECRET = process.env.MCPJAM_PREVIEW_SECRET || "";
const STATE = process.env.MCPJAM_PREVIEW_STATE || "";
const DENIED = new Set(${JSON.stringify(PREVIEW_TUNNEL_DENIED_PORTS)});
// Tests run the app and the browser-side relay on one machine, on two
// loopback addresses; a workspace always targets 127.0.0.1.
const TARGET = process.env.MCPJAM_PREVIEW_TARGET_HOST || "127.0.0.1";
if (SECRET.length < 32 || !STATE) process.exit(2);

const keyFor = (port) => createHmac("sha256", SECRET).update("port:" + port).digest("hex");
const sameKey = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const refuse = (socket, status) => socket.end("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");

const server = net.createServer((client) => {
  let head = Buffer.alloc(0);
  client.setTimeout(15000, () => client.destroy());
  client.on("error", () => client.destroy());
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) { if (head.length > 16384) refuse(client, "431 Request Header Fields Too Large"); return; }
    client.off("data", onData);
    client.setTimeout(0);
    const lines = head.subarray(0, end).toString("latin1").split("\r\n");
    const rest = head.subarray(end + 4);
    const headers = {};
    for (const line of lines.slice(1)) { const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
    const match = /^GET \S*\/tunnel\?port=(\d{1,5}) HTTP\/1\.1$/.exec(lines[0]);
    const port = match ? Number(match[1]) : 0;
    if (!match || (headers.upgrade || "").toLowerCase() !== "websocket" || !headers["sec-websocket-key"]) return refuse(client, "404 Not Found");
    if (port < 1 || port > 65535 || DENIED.has(port) || !sameKey(headers["x-mcpjam-preview-key"] || "", keyFor(port))) return refuse(client, "403 Forbidden");
    const accept = createHash("sha1").update(headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const upstream = net.connect(port, TARGET);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
      if (rest.length) upstream.write(rest);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => { if (!client.writableEnded) refuse(client, "502 Bad Gateway"); });
    upstream.on("close", () => client.end());
    client.on("close", () => upstream.destroy());
  };
  client.on("data", onData);
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  DENIED.add(port);
  const tmp = STATE + "." + process.pid;
  writeFileSync(tmp, JSON.stringify({ version: VERSION, port, pid: process.pid, secret: SECRET }), { mode: 0o600 });
  renameSync(tmp, STATE);
});
`;
