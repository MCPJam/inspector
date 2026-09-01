// Loopback model gateway for the local-harness spike (B1 client half).
// The child (Claude Code) is pointed at THIS server with a per-session
// capability token as its API key. The real upstream credential lives only in
// this process. Every upstream request carries a proof-of-possession header
// (HMAC over method, path, timestamp, nonce) so a stolen capability token alone
// is useless without the instance key.
import http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const port = Number(process.env.GW_PORT ?? 0);
const upstream = new URL(process.env.GW_UPSTREAM);
const sessionCapability = process.env.GW_SESSION_CAPABILITY;
const upstreamKey = process.env.GW_UPSTREAM_KEY ?? "";
const popSecret = process.env.GW_POP_SECRET ?? "";
if (!sessionCapability) throw new Error("GW_SESSION_CAPABILITY required");
const stats = { requests: 0, rejected: 0, upstreamMs: [], bytesIn: 0, bytesOut: 0 };
const log = (...a) => console.error("[gw]", ...a);
let revoked = false;

function capabilityOk(req) {
  const presented = req.headers["x-api-key"] ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (typeof presented !== "string") return false;
  const a = Buffer.from(presented); const b = Buffer.from(sessionCapability);
  return a.length === b.length && timingSafeEqual(a, b);
}
function pop(method, path) {
  const ts = String(Date.now()); const nonce = randomBytes(12).toString("hex");
  const mac = createHmac("sha256", popSecret).update(`${method}\n${path}\n${ts}\n${nonce}`).digest("hex");
  return `${ts}.${nonce}.${mac}`;
}
const server = http.createServer((req, res) => {
  stats.requests += 1;
  if (revoked || !capabilityOk(req)) {
    stats.rejected += 1; log("REJECT", revoked ? "revoked" : "bad capability", req.method, req.url);
    res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "capability rejected" } })); return;
  }
  const headers = { ...req.headers };
  delete headers.host; delete headers["x-api-key"]; delete headers.authorization; delete headers["content-length"];
  headers["x-api-key"] = upstreamKey;
  headers["x-mcpjam-pop"] = pop(req.method, req.url);
  const t0 = performance.now();
  const up = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers }, (upRes) => {
    stats.upstreamMs.push(Math.round(performance.now() - t0));
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.on("data", (c) => { stats.bytesOut += c.length; });
    upRes.pipe(res);
  });
  up.on("error", (e) => { log("upstream error", e.message); res.writeHead(502); res.end(); });
  req.on("data", (c) => { stats.bytesIn += c.length; });
  req.pipe(up);
});
process.on("SIGUSR2", () => { revoked = true; log("capability REVOKED"); });
process.on("SIGTERM", () => { console.log(JSON.stringify({ stats })); process.exit(0); });
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
