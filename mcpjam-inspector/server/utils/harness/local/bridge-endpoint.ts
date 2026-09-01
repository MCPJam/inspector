/**
 * The loopback bridge endpoint, and the probe that proves it is one.
 *
 * ── The finding this module exists for ───────────────────────────────────
 * The pinned adapters' bridges bind `0.0.0.0`. Inside a cloud sandbox that is
 * unremarkable: the box's network is the boundary, and E2B's `getHost` is what
 * publishes a port deliberately. On a user's own machine the same line
 * publishes an authenticated-by-query-token WebSocket that drives an agent to
 * every device on their network — a coffee-shop Wi-Fi, a shared office LAN.
 *
 * Two defences, because either alone is a promise rather than a guarantee:
 *
 *  1. `localBridgeUrl` always returns a loopback authority. The provider's
 *     `getPortUrl` never returns a LAN address, so nothing Inspector hands the
 *     adapter can point off-box.
 *  2. `assertBridgeIsLoopbackOnly` actually TRIES to reach the port through a
 *     non-loopback local address once the bridge is up, and fails the session
 *     closed if the connection is accepted. That is the difference between
 *     "we built the bundle to bind loopback" and "this process is bound to
 *     loopback right now" — and only the second survives a bundle rebuild, an
 *     adapter upgrade, or a mistake.
 *
 * The bundle build is expected to bind the bridge to loopback; this probe is
 * what makes that expectation enforceable rather than aspirational, and it is
 * a required step in the conformance suite.
 */
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";

/** Loopback host used for every URL handed to an adapter. */
export const LOOPBACK_HOST_V4 = "127.0.0.1";

/** The other loopback a squatter could be holding while v4 looks free. */
export const LOOPBACK_HOST_V6 = "::1";

export class BridgeExposureError extends Error {}

/**
 * Build the URL an adapter opens its bridge WebSocket to.
 *
 * The adapter appends its own `?agent_bridge_token=…` capability; this
 * function deliberately does not, so the token never passes through a second
 * piece of code that might log it.
 */
export function localBridgeUrl(opts: {
  port: number;
  protocol?: "http" | "https" | "ws";
}): string {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new BridgeExposureError(`implausible bridge port ${opts.port}`);
  }
  // `ws`, not `wss`, and `http`, not `https`: a loopback listener has no
  // certificate, and returning an https URL for it would just fail. Loopback
  // traffic does not leave the machine, which is why the plaintext scheme is
  // acceptable here and would not be off-box.
  const scheme = opts.protocol === "ws" ? "ws" : "http";
  return `${scheme}://${LOOPBACK_HOST_V4}:${opts.port}`;
}

/** Non-loopback IPv4/IPv6 addresses on this machine, which is what a LAN peer
 *  would use to reach a `0.0.0.0` listener. */
export function nonLoopbackLocalAddresses(
  interfaces: NodeJS.Dict<
    Array<{ address: string; internal: boolean; family: string | number }>
  > = networkInterfaces(),
): string[] {
  const found: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (!entry.address) continue;
      found.push(entry.address);
    }
  }
  return found;
}

function canConnect(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (reachable: boolean) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* already destroyed */
      }
      resolvePromise(reachable);
    };
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Refuse to launch a bridge onto a port something else already holds.
 *
 * Without this, the readiness probe below cannot tell "our bridge came up" from
 * "our bridge failed to bind and a squatter answered": both look like an
 * accepted loopback connection. Checking that the leased port is free
 * IMMEDIATELY BEFORE the spawn narrows that to the window between this check
 * and the bridge's own `bind` — which only a process already running as this
 * user could win, and which the liveness checks in
 * `assertBridgeLoopbackOnly` then bound further.
 *
 * Both loopback families are probed: a listener on `::1` alone would leave
 * `127.0.0.1` looking free while still answering anything that resolves
 * `localhost` to IPv6 first.
 */
export async function assertBridgePortUnclaimed(args: {
  port: number;
  timeoutMs?: number;
  hosts?: readonly string[];
  connect?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}): Promise<void> {
  const connect = args.connect ?? canConnect;
  const timeoutMs = args.timeoutMs ?? 500;
  const hosts = args.hosts ?? [LOOPBACK_HOST_V4, LOOPBACK_HOST_V6];
  for (const host of hosts) {
    if (await connect(host, args.port, timeoutMs)) {
      throw new BridgeExposureError(
        `port ${args.port} is already accepting connections on ${host} before ` +
          `this session's bridge started, so a listener on it could not be ` +
          `attributed to the bridge. The session stops rather than talking to ` +
          `whatever is there.`,
      );
    }
  }
}

/**
 * Wait until the bridge is actually accepting connections on loopback.
 *
 * The exposure probe below is worthless if it runs before the listener exists:
 * every connection would be refused, the probe would pass, and a bridge that
 * binds `0.0.0.0` a moment later would be admitted with a clean bill of
 * health. So readiness is established first, and only then is exposure tested.
 */
export async function waitForLoopbackListener(args: {
  port: number;
  timeoutMs?: number;
  pollMs?: number;
  connect?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}): Promise<boolean> {
  const connect = args.connect ?? canConnect;
  const pollMs = args.pollMs ?? 50;
  const deadline = Date.now() + (args.timeoutMs ?? 30_000);
  for (;;) {
    if (await connect(LOOPBACK_HOST_V4, args.port, 500)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * The check the provider runs before admitting a bridge: wait for it to listen
 * on loopback, then prove it is not ALSO reachable from the local network.
 *
 * Throws on either failure, because both are session-stopping: a bridge that
 * never came up cannot be used, and one reachable off-box is an agent control
 * channel published to whatever network the machine is on.
 */
export async function assertBridgeLoopbackOnly(args: {
  port: number;
  readinessTimeoutMs?: number;
  addresses?: readonly string[];
  timeoutMs?: number;
  connect?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /**
   * Is the supervised bridge process still running?
   *
   * A TCP probe answers "something is listening on that port", not "our bridge
   * is". Checking that the process we started is still alive — before and
   * after the exposure probe — rules out the two ways this check could pass
   * over the wrong endpoint: our bridge died and something else holds the
   * port, or it dies between readiness and use.
   *
   * A listener that was ALREADY squatting the port is ruled out separately, by
   * `assertBridgePortUnclaimed` immediately before the spawn. What remains is
   * the window between that check and the bridge's own `bind`, which only a
   * process already running as this user could win; closing even that needs a
   * nonce the bridge echoes back, which the vendor bridges do not speak.
   */
  isBridgeAlive?: () => Promise<boolean>;
}): Promise<void> {
  const assertAlive = async (when: string): Promise<void> => {
    if (args.isBridgeAlive === undefined) return;
    if (await args.isBridgeAlive()) return;
    throw new BridgeExposureError(
      `the supervised harness bridge was no longer running ${when}, so the ` +
        `listener on port ${args.port} cannot be attributed to it`,
    );
  };

  await assertAlive("while waiting for it to listen");
  const ready = await waitForLoopbackListener({
    port: args.port,
    ...(args.readinessTimeoutMs !== undefined
      ? { timeoutMs: args.readinessTimeoutMs }
      : {}),
    ...(args.connect ? { connect: args.connect } : {}),
  });
  if (!ready) {
    throw new BridgeExposureError(
      `the harness bridge never started listening on ` +
        `${LOOPBACK_HOST_V4}:${args.port}, so its binding could not be ` +
        `verified. The session stops rather than proceeding unverified.`,
    );
  }
  await assertBridgeIsLoopbackOnly(args);
  await assertAlive("after its binding was verified");
}

/**
 * Prove the bridge port is NOT reachable from any non-loopback address on this
 * machine.
 *
 * A machine with no non-loopback interface at all trivially passes — there is
 * nothing to be exposed to. Anything else is probed, and a single successful
 * connection fails the session: the whole point is that we do not ship a
 * "probably loopback" bridge.
 */
export async function assertBridgeIsLoopbackOnly(args: {
  port: number;
  addresses?: readonly string[];
  timeoutMs?: number;
  connect?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}): Promise<void> {
  const addresses = args.addresses ?? nonLoopbackLocalAddresses();
  const timeoutMs = args.timeoutMs ?? 1_000;
  const connect = args.connect ?? canConnect;
  for (const address of addresses) {
    // `net.createConnection` takes a bare address, IPv6 included — no bracketing.
    if (await connect(address, args.port, timeoutMs)) {
      throw new BridgeExposureError(
        `the harness bridge on port ${args.port} accepted a connection on a ` +
          `non-loopback address, so it is reachable from the local network. ` +
          `Local execution stops rather than leaving an agent's control ` +
          `channel published to the LAN.`,
      );
    }
  }
}
