/**
 * Loaded into a CLI or SDK process under test through
 * `NODE_OPTIONS=--import <this file>`, so every process the command starts,
 * including the detached update check, carries it too.
 *
 * In deny mode (the default) only loopback ports listed in
 * MCPJAM_TEST_NET_ALLOW (comma-separated) connect. Every other connection or
 * DNS lookup fails as refused and is appended to the file named by
 * MCPJAM_TEST_NET_LOG as one JSON line ({ pid, kind, host, port }), so a test
 * sees what the product TRIED to reach without anything leaving the machine.
 * MCPJAM_TEST_NET_MODE=record allows and logs every connection instead.
 * Process spawns are logged in both modes.
 *
 * These variables are read by this test file only; the product never reads
 * them.
 */
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const net = require("node:net");
const dns = require("node:dns");
const childProcess = require("node:child_process");

const logFile = process.env.MCPJAM_TEST_NET_LOG;
const recordOnly = process.env.MCPJAM_TEST_NET_MODE === "record";
const allowedPorts = new Set(
  (process.env.MCPJAM_TEST_NET_ALLOW ?? "")
    .split(",")
    .map((port) => port.trim())
    .filter(Boolean)
    .map(Number),
);
const LOOPBACK = new Set(["::1", "localhost", "::ffff:127.0.0.1"]);
const isLoopback = (host) => LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

function log(entry) {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

/** Deny mode logs what it blocked; record mode logs everything. */
function logAttempt(entry, allowed) {
  if (recordOnly || !allowed) log(entry);
}

function isAllowed(host, port) {
  return recordOnly || (isLoopback(host) && allowedPorts.has(Number(port)));
}

/** The destination of a `socket.connect(...)` call, in any of its forms. */
function destinationOf(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (typeof first.path === "string") return { path: first.path };
    return { host: first.host ?? "localhost", port: Number(first.port) };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) {
    return { path: first };
  }
  return {
    host: typeof args[1] === "string" ? args[1] : "localhost",
    port: Number(first),
  };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const destination = destinationOf(args);
  // A local IPC path never leaves the machine.
  if (destination.path !== undefined) {
    return originalConnect.apply(this, args);
  }
  const allowed = isAllowed(destination.host, destination.port);
  logAttempt({ kind: "connect", ...destination }, allowed);
  if (allowed) return originalConnect.apply(this, args);
  const error = Object.assign(
    new Error(
      `connect ECONNREFUSED ${destination.host}:${destination.port} (blocked by the test network guard)`,
    ),
    { code: "ECONNREFUSED" },
  );
  process.nextTick(() => this.destroy(error));
  return this;
};

function guardLookup(original, promised) {
  return function guardedLookup(hostname, ...rest) {
    const allowed = recordOnly || isLoopback(hostname);
    logAttempt({ kind: "dns", host: hostname }, allowed);
    if (allowed) return original.call(this, hostname, ...rest);
    const error = Object.assign(
      new Error(`getaddrinfo ENOTFOUND ${hostname} (blocked by the test network guard)`),
      { code: "ENOTFOUND" },
    );
    if (promised) return Promise.reject(error);
    const callback = rest[rest.length - 1];
    if (typeof callback === "function") process.nextTick(() => callback(error));
    return undefined;
  };
}

dns.lookup = guardLookup(dns.lookup, false);
dns.promises.lookup = guardLookup(dns.promises.lookup, true);

for (const name of ["spawn", "fork", "execFile"]) {
  const original = childProcess[name];
  childProcess[name] = function loggedSpawn(command, ...rest) {
    log({ kind: name, command: String(command) });
    return original.call(this, command, ...rest);
  };
}

syncBuiltinESMExports();

// The IT settings file is read from a fixed system path. A test points the
// product at its own file through this registered global, never through a
// variable the product reads.
if (process.env.MCPJAM_TEST_MANAGED_SETTINGS) {
  globalThis[Symbol.for("mcpjam.managedSettingsPath")] =
    process.env.MCPJAM_TEST_MANAGED_SETTINGS;
}
