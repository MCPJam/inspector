/**
 * A `node --import` preload that refuses every outbound network attempt to a
 * non-loopback destination, and records each one.
 *
 * For process tests that prove what a real server does NOT dial. Every route
 * out of a Node process passes one of the points patched here before a packet
 * leaves: a name lookup (`dns.lookup`, the resolver's `resolve*`, and their
 * promise forms) or a socket connect (`net.Socket.prototype.connect`, which
 * `net.connect`, `http`/`https` agents, `tls.connect` and the `fetch` built
 * into Node all reach, plus `tls.connect` itself for the name it was given).
 * That covers undici, posthog-node and Sentry's transports alike.
 *
 * Loopback stays reachable — the test talks to the server, and the server to
 * stubs it was pointed at — and everything else is refused as if the network
 * were down. A refusal never reaches the network: lookups fail with
 * `ENOTFOUND` and sockets are destroyed before they connect.
 *
 * Records go to the file named by `MCPJAM_NET_GUARD_LOG`, one JSON object per
 * line: `{ "via": "dns.lookup", "target": "us.i.posthog.com" }`.
 */
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import { isIP } from "node:net";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import tls from "node:tls";

const LOG = process.env.MCPJAM_NET_GUARD_LOG;

function isLoopback(target) {
  if (target === undefined || target === null || target === "") return true;
  const host = String(target)
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  if (isIP(host) === 6) {
    return host === "::1" || /^::ffff:127\./.test(host);
  }
  return false;
}

function record(via, target) {
  if (!LOG) return;
  appendFileSync(LOG, `${JSON.stringify({ via, target: String(target) })}\n`);
}

function refusal(target) {
  const error = new Error(`network guard refused ${target}`);
  error.code = "ENOTFOUND";
  error.hostname = String(target);
  return error;
}

const lookup = dns.lookup;
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (isLoopback(hostname)) return lookup.call(this, hostname, ...rest);
  record("dns.lookup", hostname);
  const callback = rest.find((arg) => typeof arg === "function");
  if (callback) process.nextTick(callback, refusal(hostname));
  return {};
};

const promiseLookup = dns.promises.lookup;
dns.promises.lookup = function guardedPromiseLookup(hostname, ...rest) {
  if (isLoopback(hostname)) return promiseLookup.call(this, hostname, ...rest);
  record("dns.promises.lookup", hostname);
  return Promise.reject(refusal(hostname));
};

for (const method of ["resolve", "resolve4", "resolve6", "resolveAny"]) {
  const original = dns[method];
  dns[method] = function guardedResolve(hostname, ...rest) {
    if (isLoopback(hostname)) return original.call(this, hostname, ...rest);
    record(`dns.${method}`, hostname);
    const callback = rest.find((arg) => typeof arg === "function");
    if (callback) process.nextTick(callback, refusal(hostname));
    return {};
  };
  const originalPromise = dns.promises[method];
  dns.promises[method] = function guardedPromiseResolve(hostname, ...rest) {
    if (isLoopback(hostname)) {
      return originalPromise.call(this, hostname, ...rest);
    }
    record(`dns.promises.${method}`, hostname);
    return Promise.reject(refusal(hostname));
  };
}

/**
 * The host a `connect` call targets, across its overloads; null for a local
 * socket path. A path counts only when truthy, the test `net` itself applies:
 * `http` passes `path: null` on every TCP connect.
 */
function connectHost(args) {
  const [first, second] = args;
  if (Array.isArray(first)) return connectHost(first);
  if (first && typeof first === "object") {
    if (first.path) return null;
    return first.host ?? first.hostname ?? "localhost";
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return null;
  return typeof second === "string" ? second : "localhost";
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = connectHost(args);
  if (host === null || isLoopback(host)) return connect.apply(this, args);
  record("net.connect", host);
  const error = refusal(host);
  process.nextTick(() => this.destroy(error));
  return this;
};

// Recorded here for the name it was given; the socket it opens is refused by
// the connect patch above.
const tlsConnect = tls.connect;
tls.connect = function guardedTlsConnect(...args) {
  const options = args.find((arg) => arg && typeof arg === "object") ?? {};
  const host =
    typeof args[1] === "string" ? args[1] : (options.host ?? options.servername);
  if (!options.socket && !isLoopback(host)) record("tls.connect", host);
  return tlsConnect.apply(this, args);
};

syncBuiltinESMExports();
