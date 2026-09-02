/**
 * The per-session loopback gateway that stands between a locally-running agent
 * and MCPJam's model proxy.
 *
 * ── Why a gateway, rather than giving the child the lease ────────────────
 * The agent framework warns that our provider "does not support request
 * transformations … falling back to less secure credential forwarding": the
 * model credential reaches the CLI as `ANTHROPIC_API_KEY` in its environment,
 * and the bridge persists its start config to disk. Whatever the child is
 * handed, it is handed in the clear and it is written down.
 *
 * So the child is never handed the lease. It gets a per-session CAPABILITY —
 * a random string that means nothing anywhere but this listener, for the length
 * of this session. The lease, and the instance key that signs for it, stay in
 * this process. Revoking the session revokes the capability instantly; the
 * lease is revoked separately, server-side.
 *
 * ── What this listener will and will not do ──────────────────────────────
 * It is not a proxy. It is a narrow adapter for one upstream, and everything
 * about it is an allowlist:
 *
 *   - binds 127.0.0.1 on a random port, never a routable address;
 *   - `Host` must be loopback, so a DNS-rebound page cannot reach it;
 *   - ANY `Origin` header is rejected — nothing in a browser should ever be
 *     talking to this, so the presence of the header is itself the signal;
 *   - only `POST /v1/messages*` and `count_tokens` are forwarded;
 *   - `HEAD /api/hello` answers 200 WITHOUT a capability, because the CLI
 *     probes it before its first request and a 401 there is noise that its
 *     "API reachable" heuristics may read;
 *   - the capability is compared in constant time;
 *   - bodies are size-capped and NEVER logged, in either direction;
 *   - the connecting socket's owning pid is checked against the supervised
 *     tree, so another process on the machine that learned the capability
 *     still cannot use it.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { logger } from "../../logger.js";
import { LOOPBACK_HOST_V4 } from "./bridge-endpoint.js";
import { leaseJti, signProxiedRequest } from "./instance-key.js";

/** Upstream request body ceiling. A model request is prompt-sized, not
 *  file-sized; anything past this is not a request we forward. */
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
/** How long an upstream request may take before the gateway gives up. Long,
 *  because a generation legitimately is. */
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** Paths the gateway will forward, as exact matches or prefixes. */
const ALLOWED_PATHS: ReadonlyArray<{ method: string; prefix: string }> = [
  { method: "POST", prefix: "/v1/messages" },
  { method: "POST", prefix: "/v1/messages/count_tokens" },
  { method: "POST", prefix: "/chat/completions" },
  { method: "POST", prefix: "/responses" },
];

/**
 * The CLI's reachability probe. Answered without a capability on purpose: it is
 * sent before the first authenticated request, and a 401 is both noise in the
 * log and something the CLI's own "is the API reachable" heuristics may read.
 */
const HELLO_PROBE = { method: "HEAD", path: "/api/hello" };

export interface LocalModelGatewayOptions {
  /** The signed lease. Held here and NOWHERE else in this process's data flow. */
  lease: string;
  /** Absolute upstream base, from the broker's `proxyBaseUrl`. */
  upstreamBaseUrl: string;
  /**
   * Pids the gateway will serve. A connection whose owning process is not in
   * this set is refused even with a valid capability — the capability reaches
   * the child in its environment and is written to the bridge's start config,
   * so "knows the capability" is a weaker claim than we would like it to be.
   *
   * Returns `null` when the platform cannot answer, which is NOT a refusal:
   * the capability check still stands.
   */
  isSupervisedPid?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
  /** Test seam for the peer-pid lookup. */
  resolvePeerPid?: (
    socket: Socket,
    platform: NodeJS.Platform,
  ) => Promise<number | null>;
  fetchImpl?: typeof fetch;
}

export interface LocalModelGateway {
  /** `http://127.0.0.1:<port>` — the child's `ANTHROPIC_BASE_URL`. */
  baseUrl: string;
  port: number;
  /** The child's `ANTHROPIC_API_KEY`. Means nothing off this listener. */
  sessionCapability: string;
  /** Refuse every further request, without closing in-flight ones abruptly. */
  revoke: () => void;
  /** Revoke and close the listener. */
  close: () => Promise<void>;
  stats: () => {
    requests: number;
    rejected: number;
    forwarded: number;
    upstreamErrors: number;
  };
}

export async function startLocalModelGateway(
  options: LocalModelGatewayOptions,
): Promise<LocalModelGateway> {
  const sessionCapability = randomBytes(32).toString("base64url");
  const capabilityBytes = Buffer.from(sessionCapability, "utf8");
  const parsedJti = leaseJti(options.lease);
  if (parsedJti === null) {
    throw new Error(
      "the harness model lease is not a token this gateway can bind a proof " +
        "of possession to",
    );
  }
  const jti: string = parsedJti;
  const upstream = new URL(options.upstreamBaseUrl);
  const platform = options.platform ?? process.platform;
  const doFetch = options.fetchImpl ?? fetch;
  const resolvePeer = options.resolvePeerPid ?? resolvePeerPid;

  let revoked = false;
  const stats = {
    requests: 0,
    rejected: 0,
    forwarded: 0,
    upstreamErrors: 0,
  };

  const refuse = (
    res: ServerResponse,
    status: number,
    // A short machine-readable reason. NEVER echoes anything from the request.
    reason: string,
  ): void => {
    stats.rejected += 1;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: reason },
      }),
    );
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      // Never let a handler throw take the listener down mid-session: the
      // supervised tree would keep running with no gateway to talk to.
      logger.warn("[local-harness] gateway request failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) refuse(res, 500, "gateway error");
      else res.end();
    });
  });

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    stats.requests += 1;

    // A DNS-rebound page resolves an attacker-controlled name to 127.0.0.1 and
    // then talks to whatever is listening. Requiring the Host header to BE
    // loopback is what stops that, because the rebound request carries the
    // attacker's hostname.
    if (!isLoopbackHost(req.headers.host)) {
      refuse(res, 403, "host not allowed");
      return;
    }
    // Nothing in a browser has any business here, so the presence of an Origin
    // header is itself the signal — there is no allowlist, because there is no
    // origin that should be allowed.
    if (req.headers.origin !== undefined) {
      refuse(res, 403, "origin not allowed");
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    const path = req.url ?? "/";

    if (method === HELLO_PROBE.method && stripQuery(path) === HELLO_PROBE.path) {
      res.writeHead(200);
      res.end();
      return;
    }

    if (revoked) {
      refuse(res, 401, "session ended");
      return;
    }
    if (!isAllowedPath(method, path)) {
      refuse(res, 404, "endpoint not allowed");
      return;
    }
    if (!capabilityMatches(req, capabilityBytes)) {
      refuse(res, 401, "capability rejected");
      return;
    }

    // The capability reaches the child as an environment variable and is
    // persisted in the bridge's start config, so "knows the capability" is a
    // weaker claim than we would like. Tying the connection to a process in the
    // supervised tree is what narrows it back down. A platform that cannot
    // answer leaves this check silent rather than refusing everything.
    if (options.isSupervisedPid !== undefined) {
      const peerPid = await resolvePeer(req.socket, platform);
      if (peerPid !== null && !options.isSupervisedPid(peerPid)) {
        refuse(res, 403, "caller not part of this session");
        return;
      }
    }

    const body = await readBoundedBody(req);
    if (body === null) {
      refuse(res, 413, "request too large");
      return;
    }

    const target = new URL(
      `${upstream.pathname.replace(/\/+$/, "")}${path}`,
      upstream.origin,
    );
    // The proof of possession is over the path the UPSTREAM sees, because that
    // is the path the backend verifies against.
    const pop = await signProxiedRequest({
      method,
      path: stripQuery(target.pathname),
      jti,
      nonce: randomBytes(16).toString("base64url"),
    });

    let upstreamResponse: Response;
    try {
      upstreamResponse = await doFetch(target.toString(), {
        method,
        headers: {
          // Rebuilt, not forwarded: the child's headers are not ours to relay,
          // and the two that matter here are ours to set.
          "content-type": "application/json",
          accept: String(req.headers.accept ?? "application/json"),
          authorization: `Bearer ${options.lease}`,
          "x-mcpjam-harness-lease": options.lease,
          "x-mcpjam-pop": pop,
          ...(typeof req.headers["anthropic-version"] === "string"
            ? { "anthropic-version": req.headers["anthropic-version"] }
            : {}),
          ...(typeof req.headers["anthropic-beta"] === "string"
            ? { "anthropic-beta": req.headers["anthropic-beta"] }
            : {}),
        },
        body: body as unknown as BodyInit,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      stats.upstreamErrors += 1;
      // The message, never the body or the headers.
      logger.warn("[local-harness] gateway upstream error", {
        message: error instanceof Error ? error.message : String(error),
      });
      refuse(res, 502, "upstream unavailable");
      return;
    }

    stats.forwarded += 1;
    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
      // Hop-by-hop and framing headers are ours to set, not the upstream's to
      // dictate — Node writes its own for the response we are streaming.
      if (
        name === "content-encoding" ||
        name === "content-length" ||
        name === "transfer-encoding" ||
        name === "connection"
      ) {
        return;
      }
      responseHeaders[name] = value;
    });
    res.writeHead(upstreamResponse.status, responseHeaders);
    if (upstreamResponse.body === null) {
      res.end();
      return;
    }
    // Streamed, so a generation reaches the CLI token by token rather than
    // being buffered here — and so nothing accumulates a transcript in memory.
    const reader = upstreamResponse.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) res.write(Buffer.from(value));
      }
    } finally {
      res.end();
      reader.releaseLock();
    }
  }

  const port = await new Promise<number>((resolvePromise, reject) => {
    server.once("error", reject);
    // Loopback, explicitly, and port 0 so the OS picks one nobody predicted.
    server.listen(0, LOOPBACK_HOST_V4, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the local model gateway did not bind a port"));
        return;
      }
      resolvePromise(address.port);
    });
  });

  return {
    baseUrl: `http://${LOOPBACK_HOST_V4}:${port}`,
    port,
    sessionCapability,
    revoke: () => {
      revoked = true;
    },
    close: async () => {
      revoked = true;
      await closeServer(server);
    },
    stats: () => ({ ...stats }),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    // Sockets the CLI left open would otherwise keep the listener alive past
    // the session it belongs to.
    server.closeAllConnections?.();
  });
}

function stripQuery(path: string): string {
  const index = path.indexOf("?");
  return index === -1 ? path : path.slice(0, index);
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const withoutPort = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : (host.split(":")[0] ?? "");
  return (
    withoutPort === "127.0.0.1" ||
    withoutPort === "localhost" ||
    withoutPort === "::1" ||
    /^127\./.test(withoutPort)
  );
}

export function isAllowedPath(method: string, path: string): boolean {
  const bare = stripQuery(path);
  return ALLOWED_PATHS.some(
    (entry) =>
      entry.method === method &&
      (bare === entry.prefix || bare.startsWith(`${entry.prefix}/`)),
  );
}

function capabilityMatches(
  req: IncomingMessage,
  expected: Buffer,
): boolean {
  const header = req.headers["x-api-key"] ?? req.headers.authorization;
  const presented =
    typeof header === "string"
      ? header.replace(/^Bearer\s+/i, "")
      : Array.isArray(header)
        ? ""
        : "";
  const presentedBytes = Buffer.from(presented, "utf8");
  // Length is compared first because `timingSafeEqual` throws on a mismatch;
  // the length of a random 32-byte capability is not the secret.
  if (presentedBytes.length !== expected.length) return false;
  return timingSafeEqual(presentedBytes, expected);
}

async function readBoundedBody(
  req: IncomingMessage,
): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Which process owns the other end of a loopback connection.
 *
 * `null` means the platform could not be asked, and the caller treats that as
 * "no opinion" rather than a refusal — this is a narrowing check on top of the
 * capability, not a replacement for it.
 */
export async function resolvePeerPid(
  socket: Socket,
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  const remotePort = socket.remotePort;
  if (remotePort === undefined) return null;
  if (platform === "darwin") return resolveDarwinPeerPid(remotePort);
  if (platform === "linux") return resolveLinuxPeerPid(remotePort);
  return null;
}

function resolveDarwinPeerPid(remotePort: number): Promise<number | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "/usr/sbin/lsof",
      ["-nP", "-t", `-iTCP:${remotePort}`, "-sTCP:ESTABLISHED"],
      { timeout: 1_500, maxBuffer: 32 * 1024, encoding: "utf8", env: {} },
      (error, stdout) => {
        if (error && (error as { code?: number }).code !== 1) {
          resolvePromise(null);
          return;
        }
        // Both ends of a loopback connection are on this machine, so `lsof`
        // reports two pids: ours and the peer's. Ours is dropped by identity,
        // and an ambiguous answer resolves `null` rather than guessing.
        const pids = String(stdout)
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
        resolvePromise(pids.length === 1 ? pids[0]! : null);
      },
    );
  });
}

async function resolveLinuxPeerPid(remotePort: number): Promise<number | null> {
  const inode = await findLocalSocketInode(remotePort);
  if (inode === null) return null;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let fds: string[];
    try {
      fds = await readdir(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const link = await readlink(`/proc/${entry}/fd/${fd}`);
        if (link === `socket:[${inode}]`) return pid;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** The inode of the socket whose LOCAL port is `port`, from `/proc/net/tcp*`. */
async function findLocalSocketInode(port: number): Promise<string | null> {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let raw: string;
    try {
      raw = await readFile(table, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const local = fields[1] ?? "";
      if (!local.endsWith(`:${hexPort}`)) continue;
      return fields[9] ?? null;
    }
  }
  return null;
}
