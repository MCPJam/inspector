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
  > = networkInterfaces()
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
  timeoutMs: number
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
          `channel published to the LAN.`
      );
    }
  }
}
