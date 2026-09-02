// Loopback model gateway for the local-harness conformance suite (stands in for the real gateway).
// The child (Claude Code) is pointed at THIS server with a per-session
// capability token as its API key. The real upstream credential lives only in
// this process. Every upstream request carries a proof-of-possession header
// (HMAC over method, path, timestamp, nonce) so a stolen capability token alone
// is useless without the instance key.
import http from "node:http";
import https from "node:https";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const port = Number(process.env.GW_PORT ?? 0);
const upstream = new URL(process.env.GW_UPSTREAM);
const sessionCapability = process.env.GW_SESSION_CAPABILITY;
const upstreamKey = process.env.GW_UPSTREAM_KEY ?? "";
const popSecret = process.env.GW_POP_SECRET ?? "";
if (!sessionCapability) throw new Error("GW_SESSION_CAPABILITY required");
// Before listening, not at first use. An empty secret still produces a valid
// HMAC, so a run with one would prove that proof-of-possession "works" while
// signing everything with the empty string — the suite would be its own
// oracle and agree with itself.
if (!popSecret) throw new Error("GW_POP_SECRET required and must be non-empty");
// The upstream key is a credential. Sending it in clear to anything but this
// machine is not a thing a conformance run should be able to do by
// misconfiguration.
const upstreamIsLoopback =
  upstream.hostname === "127.0.0.1" ||
  upstream.hostname === "localhost" ||
  upstream.hostname === "[::1]" ||
  upstream.hostname === "::1";
if (upstreamKey && upstream.protocol === "http:" && !upstreamIsLoopback) {
  throw new Error(
    `refusing to send GW_UPSTREAM_KEY in clear to ${upstream.hostname}`,
  );
}
/** How long an upstream may take before this gateway gives up on it. */
const UPSTREAM_TIMEOUT_MS = 120_000;
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
  // By PROTOCOL, not always http: `http.request` ignores the scheme in a URL
  // and would send the upstream key in clear to an https endpoint.
  const transport = upstream.protocol === "https:" ? https : http;
  const up = transport.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers }, (upRes) => {
    stats.upstreamMs.push(Math.round(performance.now() - t0));
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.on("data", (c) => { stats.bytesOut += c.length; });
    upRes.pipe(res);
  });
  // Bounded, and cancelled when the client goes away. `req.pipe(up)` does not
  // destroy `up` if the client vanishes, and node's http client has no default
  // timeout — so a stalled upstream would hold a conformance run open until
  // the job timed out, with nothing in the log to say why.
  up.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    log("upstream timeout", req.method, req.url);
    up.destroy(new Error("upstream timeout"));
  });
  // Watch the RESPONSE, not the request. Since node 16 `close` on a server
  // `IncomingMessage` fires when the request STREAM completes — for a POST,
  // the moment the body finishes uploading — not when the client disconnects.
  // Destroying `up` there raced the upstream response and lost whenever the
  // upstream took more than a few milliseconds: on a loaded CI runner EVERY
  // call came back 502 `socket hang up`, the vendor CLI retried ten times, and
  // each turn finished after ~180s with no content at all. `res` closes either
  // because it was fully written (nothing left to cancel) or because the
  // connection died under it (the case this exists for).
  res.on("close", () => {
    if (!res.writableFinished && !up.destroyed) up.destroy();
  });
  up.on("error", (e) => {
    log("upstream error", e.message);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on("data", (c) => { stats.bytesIn += c.length; });
  req.pipe(up);
});
process.on("SIGUSR2", () => { revoked = true; log("capability REVOKED"); });
process.on("SIGTERM", () => {
  // Written with a completion callback and the server closed before exiting:
  // `process.exit` abandons a pending stdout write, and these stats are the
  // only thing the parent learns about what the gateway saw.
  process.stdout.write(`${JSON.stringify({ stats })}\n`, () => {
    server.close(() => process.exit(0));
  });
});
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
