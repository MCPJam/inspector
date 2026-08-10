#!/usr/bin/env node
/**
 * MCPJam plugin shim — a Streamable HTTP endpoint in front of a stdio MCP
 * server, run INSIDE a sandbox VM.
 *
 * Hosted MCPJam has no local machine to spawn a plugin's `stdio` component
 * into, so the child runs in the user's own computer sandbox and this program
 * bridges it: MCPJam's `MCPClientManager` connects to an E2B public port and
 * talks to what looks like an ordinary remote Streamable HTTP MCP server.
 *
 * This file is DATA, not application code. It is uploaded verbatim into a
 * sandbox and executed there with `node mcpjam-plugin-shim.mjs`, in an image
 * that may carry nothing but a Node 20+ runtime. It therefore imports ONLY
 * Node builtins, never a package and never anything from this repository —
 * a single repo import would make the file unrunnable at its destination.
 *
 * ---------------------------------------------------------------------------
 * Startup configuration (environment only)
 * ---------------------------------------------------------------------------
 * Required:
 *   MCPJAM_SHIM_PORT     TCP port to listen on, 0-65535. `0` asks the kernel
 *                        for an ephemeral port; the chosen one is reported on
 *                        stdout (see "Ready line" below).
 *   MCPJAM_SHIM_TOKEN    Bearer token every `/mcp` request must present. At
 *                        least 32 characters — this is the ONLY thing standing
 *                        between the public sandbox port and a process that
 *                        executes the plugin's command.
 *   MCPJAM_SHIM_LAUNCH   The child launch spec, as one JSON object:
 *                          {
 *                            "command": string,               // required, non-empty
 *                            "args":    string[],             // optional, default []
 *                            "env":     {[k: string]: string},// optional, default {}
 *                            "cwd":     string                // optional
 *                          }
 *                        Validated strictly: unknown keys, wrong types and
 *                        non-string env values are startup failures, not
 *                        silently-dropped fields. Note the key is `cwd`, the
 *                        `child_process.spawn` name — a caller holding a
 *                        `PluginStdioLaunchSpec` must map `workingDirectory`
 *                        onto it (an unmapped `workingDirectory` is rejected
 *                        loudly rather than ignored).
 *
 * Optional (defaults chosen for one interactive MCPJam user per sandbox):
 *   MCPJAM_SHIM_HOST                bind address, default "0.0.0.0" (the
 *                                   sandbox's public port forwards to it).
 *   MCPJAM_SHIM_MAX_SESSIONS        concurrent sessions/children, default 8.
 *   MCPJAM_SHIM_SESSION_IDLE_MS     idle session reap, default 300000 (5 min).
 *   MCPJAM_SHIM_REQUEST_TIMEOUT_MS  per-request child response deadline,
 *                                   default 120000 (2 min).
 *
 * Exit codes: 2 = invalid configuration, 1 = the port could not be bound.
 *
 * Ready line: exactly one JSON line is written to stdout once listening —
 * `{"event":"listening","host":...,"port":...}`. Everything else the shim
 * says, including the child's forwarded stderr, goes to stderr, so a caller
 * can read the port off stdout without a race.
 *
 * ---------------------------------------------------------------------------
 * HTTP surface
 * ---------------------------------------------------------------------------
 *   POST   /mcp       one JSON-RPC message in, one JSON-RPC message out.
 *   DELETE /mcp       terminate the session named by `Mcp-Session-Id`.
 *   GET    /mcp       405 + `Allow` — the shim offers no server-initiated SSE
 *                     stream, which is the spec's other permitted answer and
 *                     the one MCP clients treat as "no stream here" instead of
 *                     as a transport failure.
 *   GET    /healthz   unauthenticated liveness. Carries no secrets.
 *   anything else     404.
 *
 * Deliberately NOT bridged: server-to-client requests (sampling, elicitation,
 * roots) and server notifications. Both need a stream this endpoint does not
 * open. A server-initiated REQUEST is answered on the child's own stdin with
 * JSON-RPC -32601 so the child fails fast instead of blocking forever;
 * notifications are dropped with a stderr note.
 */
import { spawn } from "node:child_process";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ENV_PREFIX = "MCPJAM_SHIM_";

/** Long enough that the public sandbox port is not brute-forceable. */
const MIN_TOKEN_LENGTH = 32;

const DEFAULT_HOST = "0.0.0.0";

/**
 * One MCPJam user drives one plugin server, but reconnects, a second browser
 * tab and an eval run can legitimately overlap, and each child costs a process
 * inside a small VM. Eight is well above real concurrency and well below what
 * would exhaust the sandbox.
 */
const DEFAULT_MAX_SESSIONS = 8;

/**
 * Streamable HTTP gives no disconnect signal for a stateful session, so an
 * abandoned browser tab would otherwise pin a child forever. Five minutes
 * outlives a user reading a tool result and dies long before the sandbox does.
 */
const DEFAULT_SESSION_IDLE_MS = 5 * 60_000;

/**
 * Above MCPJam's own per-request ceilings, so a slow-but-alive tool is the
 * caller's timeout to enforce; this one exists only so a wedged child cannot
 * hold an HTTP request open indefinitely.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** SIGTERM → SIGKILL grace. Long enough for a Node child to run exit hooks. */
const KILL_GRACE_MS = 2_000;

/** A JSON-RPC message this large is a bug or an attack, never a real call. */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Characters tolerated on the child's stdout without a newline. Past this the
 * child is not newline-framing its output and the buffer would grow without
 * bound, so the session is torn down instead.
 */
const MAX_STDOUT_LINE_CHARS = 16 * 1024 * 1024;

/** Upper bound on how coarse the idle sweep may be. */
const SESSION_SWEEP_MS = 5_000;

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
/** Implementation-defined range (-32000..-32099). */
const SHIM_CHILD_UNAVAILABLE = -32000;
const SHIM_REQUEST_TIMEOUT = -32001;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export class ShimConfigError extends Error {}

function isRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === false
  );
}

function parseOptionalPositiveInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^\d+$/.test(raw) === false) {
    throw new ShimConfigError(`${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (value <= 0) {
    throw new ShimConfigError(`${name} must be greater than 0`);
  }
  return value;
}

/**
 * Parse and validate `MCPJAM_SHIM_LAUNCH`.
 *
 * Unknown keys are rejected rather than ignored: this blob is the entire
 * contract with the uploader, and a silently-dropped field would mean a child
 * launched with the wrong working directory or a missing credential.
 */
export function parseLaunchSpec(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ShimConfigError(`${ENV_PREFIX}LAUNCH is required`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShimConfigError(`${ENV_PREFIX}LAUNCH is not valid JSON`);
  }
  if (isRecord(parsed) === false) {
    throw new ShimConfigError(`${ENV_PREFIX}LAUNCH must be a JSON object`);
  }

  const allowed = new Set(["command", "args", "env", "cwd"]);
  for (const key of Object.keys(parsed)) {
    if (allowed.has(key) === false) {
      throw new ShimConfigError(
        `${ENV_PREFIX}LAUNCH has unknown key "${key}" (expected command, args, env, cwd)`
      );
    }
  }

  if (typeof parsed.command !== "string" || parsed.command.length === 0) {
    throw new ShimConfigError(
      `${ENV_PREFIX}LAUNCH.command must be a non-empty string`
    );
  }

  let args = [];
  if (parsed.args !== undefined) {
    if (
      Array.isArray(parsed.args) === false ||
      parsed.args.every((arg) => typeof arg === "string") === false
    ) {
      throw new ShimConfigError(
        `${ENV_PREFIX}LAUNCH.args must be an array of strings`
      );
    }
    args = [...parsed.args];
  }

  const env = {};
  if (parsed.env !== undefined) {
    if (isRecord(parsed.env) === false) {
      throw new ShimConfigError(
        `${ENV_PREFIX}LAUNCH.env must be an object of string values`
      );
    }
    for (const [key, value] of Object.entries(parsed.env)) {
      if (typeof value !== "string") {
        throw new ShimConfigError(
          `${ENV_PREFIX}LAUNCH.env["${key}"] must be a string`
        );
      }
      env[key] = value;
    }
  }

  let cwd;
  if (parsed.cwd !== undefined) {
    if (typeof parsed.cwd !== "string" || parsed.cwd.length === 0) {
      throw new ShimConfigError(
        `${ENV_PREFIX}LAUNCH.cwd must be a non-empty string`
      );
    }
    cwd = parsed.cwd;
  }

  return { command: parsed.command, args, env, cwd };
}

export function parseShimConfig(env) {
  const rawPort = env[`${ENV_PREFIX}PORT`];
  if (typeof rawPort !== "string" || /^\d+$/.test(rawPort) === false) {
    throw new ShimConfigError(`${ENV_PREFIX}PORT must be an integer 0-65535`);
  }
  const port = Number(rawPort);
  if (port > 65535) {
    throw new ShimConfigError(`${ENV_PREFIX}PORT must be an integer 0-65535`);
  }

  const token = env[`${ENV_PREFIX}TOKEN`];
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
    throw new ShimConfigError(
      `${ENV_PREFIX}TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`
    );
  }

  const host = env[`${ENV_PREFIX}HOST`];
  if (host !== undefined && host.length === 0) {
    throw new ShimConfigError(`${ENV_PREFIX}HOST must not be empty`);
  }

  return {
    port,
    host: host ?? DEFAULT_HOST,
    token,
    launch: parseLaunchSpec(env[`${ENV_PREFIX}LAUNCH`]),
    maxSessions: parseOptionalPositiveInt(
      env,
      `${ENV_PREFIX}MAX_SESSIONS`,
      DEFAULT_MAX_SESSIONS
    ),
    sessionIdleMs: parseOptionalPositiveInt(
      env,
      `${ENV_PREFIX}SESSION_IDLE_MS`,
      DEFAULT_SESSION_IDLE_MS
    ),
    requestTimeoutMs: parseOptionalPositiveInt(
      env,
      `${ENV_PREFIX}REQUEST_TIMEOUT_MS`,
      DEFAULT_REQUEST_TIMEOUT_MS
    ),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Split a stdout buffer into complete newline-delimited messages.
 *
 * The trailing `rest` is what makes chunk boundaries harmless: a message cut
 * in half by the OS is carried forward instead of parsed as two broken ones.
 * Blank lines are dropped — the stdio transport permits them and they are not
 * messages.
 */
export function drainFramedLines(buffer) {
  const lines = [];
  let start = 0;
  let index = buffer.indexOf("\n", start);
  while (index !== -1) {
    let line = buffer.slice(start, index);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length > 0) lines.push(line);
    start = index + 1;
    index = buffer.indexOf("\n", start);
  }
  return { lines, rest: buffer.slice(start) };
}

export function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code, message },
  };
}

/**
 * What a client-sent JSON-RPC message is, for routing purposes.
 *
 * A JSON-RPC *response* classifies as "unsupported": responses only exist as
 * answers to server-initiated requests, which this endpoint never delivers, so
 * accepting one would be accepting a message that can never be correlated.
 */
export function classifyClientMessage(message) {
  if (isRecord(message) === false) return "invalid";
  if (message.jsonrpc !== "2.0") return "invalid";
  if (typeof message.method !== "string" || message.method.length === 0) {
    return "unsupported";
  }
  const hasId = "id" in message && message.id !== null;
  if (hasId === false) return "notification";
  if (typeof message.id !== "string" && typeof message.id !== "number") {
    return "invalid";
  }
  return "request";
}

/**
 * Correlation key for a JSON-RPC id. Typed, because `1` and `"1"` are distinct
 * ids and collapsing them would deliver one child's answer to another request.
 */
function pendingKey(id) {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

/**
 * Per-process key so the digests below cannot be precomputed by an attacker
 * who knows the algorithm.
 */
const AUTH_DIGEST_KEY = randomBytes(32);

/**
 * Constant-time string comparison that is also constant-time in LENGTH.
 *
 * `timingSafeEqual` throws on unequal lengths, and the obvious guard —
 * comparing `a.length !== b.length` first — returns early, leaking the token's
 * length through response timing. Hashing both sides to a fixed 32 bytes makes
 * every comparison do identical work regardless of the input.
 */
export function constantTimeEquals(a, b) {
  const digestA = createHmac("sha256", AUTH_DIGEST_KEY)
    .update(a, "utf8")
    .digest();
  const digestB = createHmac("sha256", AUTH_DIGEST_KEY)
    .update(b, "utf8")
    .digest();
  return timingSafeEqual(digestA, digestB);
}

/** The bearer credential a request presents, or "" when it presents none. */
function presentedBearer(headerValue) {
  if (typeof headerValue !== "string") return "";
  const separator = headerValue.indexOf(" ");
  if (separator === -1) return "";
  if (headerValue.slice(0, separator).toLowerCase() !== "bearer") return "";
  return headerValue.slice(separator + 1).trim();
}

// ---------------------------------------------------------------------------
// Shim
// ---------------------------------------------------------------------------

function diagnostic(message) {
  process.stderr.write(`[mcpjam-plugin-shim] ${message}\n`);
}

function sendJson(res, status, body, headers) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendEmpty(res, status, headers) {
  res.writeHead(status, { "content-length": "0", ...headers });
  res.end();
}

class BodyTooLargeError extends Error {}

function readRequestBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A header that arrived more than once cannot be routed unambiguously. */
function singleHeader(req, name) {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return null;
  return value;
}

/**
 * The environment a plugin child is launched with.
 *
 * The shim's own environment carries the bearer token, so every
 * `MCPJAM_SHIM_*` variable is stripped before the child sees it — a plugin
 * command must never be able to read the credential that authorizes calls to
 * it. The launch spec's own env is applied last and may override anything
 * inherited.
 */
function buildChildEnv(specEnv) {
  const inherited = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(ENV_PREFIX)) continue;
    if (value === undefined) continue;
    inherited[key] = value;
  }
  return { ...inherited, ...specEnv };
}

export function createShim(config) {
  /** Insertion order is LRU order: `touch` re-inserts, so the first key is oldest. */
  const sessions = new Map();
  /**
   * Children that have been spawned and not yet reaped, including ones already
   * dropped from `sessions`. Shutdown waits on this, not on `sessions`.
   */
  const liveChildren = new Set();
  let shuttingDown = false;

  function touch(session) {
    session.lastUsedAt = Date.now();
    // A session torn down between lookup and use must not be resurrected by
    // the re-insertion that keeps this map in LRU order.
    if (session.terminating) return;
    sessions.delete(session.id);
    sessions.set(session.id, session);
  }

  function settleAllPending(session, reason) {
    for (const pending of [...session.pending.values()]) {
      pending.settle(jsonRpcError(pending.id, SHIM_CHILD_UNAVAILABLE, reason));
    }
    session.pending.clear();
  }

  function writeToChild(session, message) {
    const { stdin } = session.child;
    if (stdin === null || stdin.writable === false) return false;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function forwardChildStderr(session, chunk) {
    session.stderrBuffer += chunk;
    let index = session.stderrBuffer.indexOf("\n");
    while (index !== -1) {
      const line = session.stderrBuffer.slice(0, index);
      session.stderrBuffer = session.stderrBuffer.slice(index + 1);
      process.stderr.write(`[plugin ${session.shortId}] ${line}\n`);
      index = session.stderrBuffer.indexOf("\n");
    }
  }

  function flushChildStderr(session) {
    if (session.stderrBuffer.length === 0) return;
    process.stderr.write(
      `[plugin ${session.shortId}] ${session.stderrBuffer}\n`
    );
    session.stderrBuffer = "";
  }

  /**
   * Handle one framed message from the child.
   *
   * Nothing from the child's payload is ever logged — a tool result or an
   * argument echo can hold the user's data. Only method names and ids, which
   * are protocol shape, appear in diagnostics.
   */
  function handleChildMessage(session, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      diagnostic(`session ${session.shortId}: dropped non-JSON stdout line`);
      return;
    }
    if (isRecord(message) === false) {
      diagnostic(
        `session ${session.shortId}: dropped non-object stdout message`
      );
      return;
    }

    if (typeof message.method === "string") {
      const hasId = "id" in message && message.id !== null;
      if (hasId) {
        writeToChild(
          session,
          jsonRpcError(
            message.id,
            JSONRPC_METHOD_NOT_FOUND,
            "the MCPJam plugin shim does not bridge server-initiated requests"
          )
        );
        diagnostic(
          `session ${session.shortId}: refused server request ${message.method}`
        );
      } else {
        diagnostic(
          `session ${session.shortId}: dropped server notification ${message.method}`
        );
      }
      return;
    }

    if ("id" in message === false || message.id === null) {
      diagnostic(
        `session ${session.shortId}: dropped stdout message without id`
      );
      return;
    }
    const pending = session.pending.get(pendingKey(message.id));
    if (pending === undefined) {
      diagnostic(`session ${session.shortId}: response for an unknown id`);
      return;
    }
    pending.settle(message);
  }

  function handleChildStdout(session, chunk) {
    session.stdoutBuffer += chunk;
    const { lines, rest } = drainFramedLines(session.stdoutBuffer);
    session.stdoutBuffer = rest;
    if (rest.length > MAX_STDOUT_LINE_CHARS) {
      terminateSession(
        session,
        "the plugin server emitted an unterminated line on stdout"
      );
      return;
    }
    for (const line of lines) {
      handleChildMessage(session, line);
    }
  }

  /**
   * Signal the child to stop and fail everything in flight now, rather than
   * waiting for `exit`: the caller is owed an answer immediately, and the
   * session must stop routing before the process is actually gone.
   */
  function terminateSession(session, reason) {
    if (session.terminating) return;
    session.terminating = true;
    sessions.delete(session.id);
    settleAllPending(session, reason);
    try {
      session.child.stdin?.end();
    } catch {
      // A child that already exited has an unwritable stdin; nothing to close.
    }
    try {
      session.child.kill("SIGTERM");
    } catch {
      // Already reaped.
    }
    session.killTimer = setTimeout(() => {
      try {
        session.child.kill("SIGKILL");
      } catch {
        // Already reaped.
      }
    }, KILL_GRACE_MS);
    session.killTimer.unref();
  }

  function createSession() {
    if (sessions.size >= config.maxSessions) {
      const lruId = sessions.keys().next().value;
      const lru = sessions.get(lruId);
      if (lru !== undefined) {
        diagnostic(
          `session ${lru.shortId}: evicted, concurrent session cap (${config.maxSessions}) reached`
        );
        terminateSession(
          lru,
          "the session was evicted because the shim reached its concurrent session cap"
        );
      }
    }

    const id = randomUUID();
    const child = spawn(config.launch.command, config.launch.args, {
      cwd: config.launch.cwd,
      env: buildChildEnv(config.launch.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const session = {
      id,
      shortId: id.slice(0, 8),
      child,
      pending: new Map(),
      stdoutBuffer: "",
      stderrBuffer: "",
      lastUsedAt: Date.now(),
      terminating: false,
      killTimer: undefined,
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => handleChildStdout(session, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => forwardChildStderr(session, chunk));
    // EPIPE on a stdin whose reader has died is expected, and unhandled it
    // would take the whole shim down with it.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      terminateSession(
        session,
        `the plugin server failed to start: ${error.message}`
      );
      // A command that never resolved to a process has no pid and emits no
      // `exit`, so the bookkeeping the exit handler owns has to happen here or
      // shutdown would wait out its backstop on a child that never existed.
      if (child.pid === undefined) {
        liveChildren.delete(child);
        if (shuttingDown && liveChildren.size === 0) process.exit(0);
      }
    });
    child.once("exit", (code, signal) => {
      flushChildStderr(session);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.stdin.removeAllListeners();
      child.removeAllListeners("error");
      if (session.killTimer !== undefined) clearTimeout(session.killTimer);
      session.terminating = true;
      sessions.delete(session.id);
      liveChildren.delete(child);
      settleAllPending(
        session,
        signal === null
          ? `the plugin server exited with code ${code}`
          : `the plugin server was terminated by ${signal}`
      );
      if (shuttingDown && liveChildren.size === 0) process.exit(0);
    });

    liveChildren.add(child);
    sessions.set(id, session);
    return session;
  }

  /**
   * Send one request to the child and wait for the answer with the same id.
   *
   * Correlation is by id rather than by arrival order because a compliant MCP
   * server may answer concurrent requests in any order.
   */
  function dispatch(session, message) {
    return new Promise((resolve) => {
      const key = pendingKey(message.id);
      const superseded = session.pending.get(key);
      if (superseded !== undefined) {
        superseded.settle(
          jsonRpcError(
            message.id,
            SHIM_CHILD_UNAVAILABLE,
            "the request was superseded by another in-flight request with the same id"
          )
        );
      }

      let timer;
      let settled = false;
      const settle = (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (session.pending.get(key)?.settle === settle) {
          session.pending.delete(key);
        }
        resolve(response);
      };

      timer = setTimeout(() => {
        settle(
          jsonRpcError(
            message.id,
            SHIM_REQUEST_TIMEOUT,
            `the plugin server did not answer within ${config.requestTimeoutMs}ms`
          )
        );
      }, config.requestTimeoutMs);
      timer.unref();

      session.pending.set(key, { id: message.id, settle });

      if (writeToChild(session, message) === false) {
        settle(
          jsonRpcError(
            message.id,
            SHIM_CHILD_UNAVAILABLE,
            "the plugin server is not accepting input"
          )
        );
      }
    });
  }

  async function handleMcp(req, res) {
    if (
      constantTimeEquals(
        presentedBearer(req.headers.authorization),
        config.token
      ) === false
    ) {
      // No `WWW-Authenticate`: the shim is not an OAuth resource server, and
      // advertising a challenge would send MCP clients down a discovery path
      // that leads nowhere. No body either — 401 says nothing about why.
      sendEmpty(res, 401);
      return;
    }

    // The spec's DNS-rebinding defence. Every legitimate caller here is
    // server-side and sends no Origin, so any Origin at all is invalid.
    if (req.headers.origin !== undefined) {
      sendJson(
        res,
        403,
        jsonRpcError(
          null,
          JSONRPC_INVALID_REQUEST,
          "cross-origin requests are not accepted"
        )
      );
      return;
    }

    const sessionHeader = singleHeader(req, "mcp-session-id");
    if (sessionHeader === null) {
      sendJson(
        res,
        400,
        jsonRpcError(
          null,
          JSONRPC_INVALID_REQUEST,
          "duplicate Mcp-Session-Id header"
        )
      );
      return;
    }

    if (req.method === "DELETE") {
      if (sessionHeader === undefined) {
        sendJson(
          res,
          400,
          jsonRpcError(
            null,
            JSONRPC_INVALID_REQUEST,
            "missing Mcp-Session-Id header"
          )
        );
        return;
      }
      const session = sessions.get(sessionHeader);
      if (session === undefined) {
        sendEmpty(res, 404);
        return;
      }
      terminateSession(session, "the session was terminated by the client");
      sendEmpty(res, 204);
      return;
    }

    // GET lands here too: 405 is the spec's sanctioned answer for an endpoint
    // that offers no server-initiated SSE stream, and the one MCP clients read
    // as "no stream" rather than as a broken transport.
    if (req.method !== "POST") {
      sendEmpty(res, 405, { allow: "POST, DELETE" });
      return;
    }

    let raw;
    try {
      raw = await readRequestBody(req, MAX_REQUEST_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(
          res,
          413,
          jsonRpcError(null, JSONRPC_INVALID_REQUEST, "request body too large")
        );
        return;
      }
      sendJson(
        res,
        400,
        jsonRpcError(
          null,
          JSONRPC_INVALID_REQUEST,
          "request body could not be read"
        )
      );
      return;
    }

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      sendJson(
        res,
        400,
        jsonRpcError(null, JSONRPC_PARSE_ERROR, "invalid JSON")
      );
      return;
    }

    if (Array.isArray(message)) {
      sendJson(
        res,
        400,
        jsonRpcError(
          null,
          JSONRPC_INVALID_REQUEST,
          "JSON-RPC batches are not supported"
        )
      );
      return;
    }

    const kind = classifyClientMessage(message);
    if (kind === "invalid") {
      sendJson(
        res,
        400,
        jsonRpcError(
          null,
          JSONRPC_INVALID_REQUEST,
          "not a JSON-RPC 2.0 request or notification"
        )
      );
      return;
    }
    if (kind === "unsupported") {
      sendJson(
        res,
        400,
        jsonRpcError(
          null,
          JSONRPC_INVALID_REQUEST,
          "the shim accepts only JSON-RPC requests and notifications"
        )
      );
      return;
    }

    if (kind === "request" && message.method === "initialize") {
      if (shuttingDown) {
        sendJson(
          res,
          503,
          jsonRpcError(
            message.id,
            SHIM_CHILD_UNAVAILABLE,
            "the shim is shutting down"
          )
        );
        return;
      }
      // An `initialize` always opens a fresh session: MCP clients strip the
      // session header from the handshake, so there is no session to reuse and
      // reusing one by accident would hand a client another client's child.
      const session = createSession();
      const response = await dispatch(session, message);
      // Only advertise a session the client can still address: a child that
      // died during the handshake leaves no session behind, and naming it
      // would send the client's next request to a guaranteed 404.
      sendJson(
        res,
        200,
        response,
        sessions.has(session.id) ? { "mcp-session-id": session.id } : undefined
      );
      return;
    }

    if (sessionHeader === undefined) {
      sendJson(
        res,
        400,
        jsonRpcError(
          message.id ?? null,
          JSONRPC_INVALID_REQUEST,
          "missing Mcp-Session-Id header"
        )
      );
      return;
    }

    const session = sessions.get(sessionHeader);
    if (session === undefined) {
      // 404 is the spec's signal that the session is gone; clients answer it
      // by starting a new one with a fresh `initialize`.
      sendJson(
        res,
        404,
        jsonRpcError(
          message.id ?? null,
          JSONRPC_INVALID_REQUEST,
          "unknown or terminated session"
        )
      );
      return;
    }
    touch(session);

    if (kind === "notification") {
      writeToChild(session, message);
      // 202 with no body, and no pending entry: a notification has no id to
      // correlate an answer to and will never receive one.
      sendEmpty(res, 202);
      return;
    }

    const response = await dispatch(session, message);
    sendJson(res, 200, response);
  }

  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://shim.invalid").pathname;
    } catch {
      sendEmpty(res, 404);
      return;
    }

    if (pathname === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendEmpty(res, 405, { allow: "GET, HEAD" });
        return;
      }
      // Liveness only. Never the token, the launch spec, or any session id.
      sendJson(res, 200, {
        ok: true,
        sessions: sessions.size,
        uptimeMs: Math.round(process.uptime() * 1000),
      });
      return;
    }

    if (pathname !== "/mcp") {
      sendEmpty(res, 404);
      return;
    }

    handleMcp(req, res).catch((error) => {
      diagnostic(`unhandled request failure: ${error?.message ?? "unknown"}`);
      if (res.headersSent === false) {
        sendJson(
          res,
          500,
          jsonRpcError(null, SHIM_CHILD_UNAVAILABLE, "internal shim error")
        );
      } else {
        res.end();
      }
    });
  });

  const sweepIntervalMs = Math.max(
    250,
    Math.min(SESSION_SWEEP_MS, Math.floor(config.sessionIdleMs / 2))
  );
  const sweep = setInterval(() => {
    const cutoff = Date.now() - config.sessionIdleMs;
    for (const session of [...sessions.values()]) {
      if (session.pending.size > 0) continue;
      if (session.lastUsedAt > cutoff) continue;
      diagnostic(`session ${session.shortId}: reaped after idle timeout`);
      terminateSession(
        session,
        "the session was reaped after its idle timeout"
      );
    }
  }, sweepIntervalMs);
  sweep.unref();

  /**
   * Stop accepting work and take every child down with the shim.
   *
   * The backstop timer is deliberately NOT unref'd: it is the only thing
   * keeping the loop alive long enough for the SIGKILL escalation to fire, and
   * exiting before it would orphan a child that ignored SIGTERM. The common
   * case never reaches it — the last child's `exit` handler exits immediately.
   */
  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweep);
    server.close();
    server.closeAllConnections?.();
    for (const session of [...sessions.values()]) {
      terminateSession(session, `the shim is shutting down (${reason})`);
    }
    if (liveChildren.size === 0) {
      process.exit(0);
      return;
    }
    setTimeout(() => process.exit(0), KILL_GRACE_MS + 500);
  }

  return { server, sessions, shutdown };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function main() {
  let config;
  try {
    config = parseShimConfig(process.env);
  } catch (error) {
    process.stderr.write(`mcpjam-plugin-shim: ${error.message}\n`);
    process.exit(2);
    return;
  }

  const shim = createShim(config);

  shim.server.on("error", (error) => {
    process.stderr.write(
      `mcpjam-plugin-shim: listen failed: ${error.message}\n`
    );
    process.exit(1);
  });

  shim.server.listen(config.port, config.host, () => {
    const address = shim.server.address();
    const port =
      typeof address === "object" && address !== null
        ? address.port
        : config.port;
    // The one and only stdout line, so a caller can learn an ephemeral port
    // without racing the child stderr the shim also forwards.
    process.stdout.write(
      `${JSON.stringify({ event: "listening", host: config.host, port })}\n`
    );
    // Never the token, the command, its args or its env: an argv element or an
    // env value is exactly where a plugin's own credentials live.
    diagnostic(
      `listening host=${config.host} port=${port} maxSessions=${config.maxSessions} idleMs=${config.sessionIdleMs} requestTimeoutMs=${config.requestTimeoutMs}`
    );
  });

  process.on("SIGTERM", () => shim.shutdown("SIGTERM"));
  process.on("SIGINT", () => shim.shutdown("SIGINT"));
}

// Runs only when executed directly. Importing the module (the unit tests do)
// must not read the environment or bind a port.
const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  main();
}
