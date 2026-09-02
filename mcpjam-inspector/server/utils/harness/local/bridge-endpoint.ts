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
import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
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

/**
 * Non-loopback IPv4/IPv6 addresses on this machine, which is what a LAN peer
 * would use to reach a `0.0.0.0` listener.
 *
 * IPv6 link-local addresses (`fe80::/10`) are returned WITH their interface
 * scope appended (`fe80::1%en0`). Without a scope they are not connectable at
 * all — the kernel cannot pick an interface — so every probe against one sat
 * out the full timeout and answered "not reachable" for a reason that had
 * nothing to do with the bridge's binding. On the machine this was measured on
 * that was ten addresses × 500 ms of pure latency in the session-start path,
 * and ten probes that proved nothing. Scoped, they are probed for real; an
 * address that cannot be scoped is dropped rather than probed uselessly.
 */
export function nonLoopbackLocalAddresses(
  interfaces: NodeJS.Dict<
    Array<{
      address: string;
      internal: boolean;
      family: string | number;
      scopeid?: number;
    }>
  > = networkInterfaces(),
): string[] {
  const found: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (!entry.address) continue;
      if (!isIpv6LinkLocal(entry.address)) {
        found.push(entry.address);
        continue;
      }
      if (entry.address.includes("%")) {
        found.push(entry.address);
        continue;
      }
      // `networkInterfaces()` keys by interface name, which is exactly the
      // scope a link-local address needs.
      if (name) found.push(`${entry.address}%${name}`);
    }
  }
  return found;
}

function isIpv6LinkLocal(address: string): boolean {
  const bare = address.split("%")[0]!.toLowerCase();
  // fe80::/10 covers fe80: through febf:.
  return /^fe[89ab][0-9a-f]:/.test(bare);
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
  /**
   * Pid of the supervised bridge, for the corroborating OS-level binding read.
   * Omitted, only the connect probe runs — which is still the enforcing check.
   */
  bridgePid?: number;
  platform?: NodeJS.Platform;
  readListenAddresses?: (
    pid: number,
    platform: NodeJS.Platform,
  ) => Promise<string[] | null>;
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
  if (args.bridgePid !== undefined) {
    await assertBridgeBindingIsLoopback({
      pid: args.bridgePid,
      ...(args.platform !== undefined ? { platform: args.platform } : {}),
      ...(args.readListenAddresses !== undefined
        ? { read: args.readListenAddresses }
        : {}),
    });
  }
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
  if (addresses.length === 0) return;
  // Per-address timeout, and a whole-probe budget that does not grow with the
  // number of interfaces. Sequentially this cost 11 s on a laptop with ten
  // link-local addresses; the addresses are independent, so the only reason it
  // was ever serial was the shape of the loop.
  const timeoutMs = Math.min(args.timeoutMs ?? 500, PROBE_BUDGET_MS);
  const connect = args.connect ?? canConnect;
  // `net.createConnection` takes a bare address, IPv6 included — no bracketing.
  const results = await Promise.all(
    addresses.map(async (address) => ({
      address,
      reachable: await connect(address, args.port, timeoutMs),
    })),
  );
  const exposed = results.find((result) => result.reachable);
  if (exposed !== undefined) {
    throw new BridgeExposureError(
      `the harness bridge on port ${args.port} accepted a connection on a ` +
        `non-loopback address, so it is reachable from the local network. ` +
        `Local execution stops rather than leaving an agent's control ` +
        `channel published to the LAN.`,
    );
  }
}

/** Whole-probe budget. Parallel probes make this a wall-clock bound, not a
 *  per-address one. */
const PROBE_BUDGET_MS = 1_000;

/**
 * What the OS says the bridge process is bound to.
 *
 * The connect probe is the ENFORCING check and stays that way: it tests
 * reachability, which is the property that matters. This is the corroborating
 * one, and it closes the connect probe's blind spot — an address the machine
 * has but this process cannot route to (a firewall, a down interface, a
 * container's netns) probes as unreachable while the socket is still bound to
 * it and reachable from somewhere else. Reading the binding out of the kernel
 * does not depend on being able to reach it.
 *
 * `null` means the platform could not be asked, which is NOT a failure: the
 * connect probe still ran. An empty array means the process holds no listening
 * TCP socket at all, which the readiness check has already ruled out by the
 * time this runs.
 */
export async function readProcessListenAddresses(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string[] | null> {
  if (platform === "darwin") return readDarwinListenAddresses(pid);
  if (platform === "linux") return readLinuxListenAddresses(pid);
  return null;
}

function readDarwinListenAddresses(pid: number): Promise<string[] | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"],
      { timeout: 2_000, maxBuffer: 256 * 1024, encoding: "utf8", env: {} },
      (error, stdout) => {
        // lsof exits 1 when it simply matched nothing, which is a real answer
        // ("no listening sockets"), not a failure to ask.
        if (error && (error as { code?: number }).code !== 1) {
          resolvePromise(null);
          return;
        }
        const addresses: string[] = [];
        for (const line of String(stdout).split("\n").slice(1)) {
          // NAME is the last column: `127.0.0.1:53123` or `*:53123 (LISTEN)`.
          const name = line.trim().split(/\s+/).at(-2);
          if (name === undefined) continue;
          const host = name.slice(0, name.lastIndexOf(":"));
          if (host.length > 0) addresses.push(host);
        }
        resolvePromise(addresses);
      },
    );
  });
}

async function readLinuxListenAddresses(pid: number): Promise<string[] | null> {
  let sockets: Set<string>;
  try {
    const fds = await readdir(`/proc/${pid}/fd`);
    const inodes = await Promise.all(
      fds.map(async (fd) => {
        try {
          const link = await readlink(`/proc/${pid}/fd/${fd}`);
          const match = /^socket:\[(\d+)\]$/.exec(link);
          return match?.[1] ?? null;
        } catch {
          return null;
        }
      }),
    );
    sockets = new Set(inodes.filter((inode): inode is string => inode !== null));
  } catch {
    return null;
  }
  if (sockets.size === 0) return [];

  const addresses: string[] = [];
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let raw: string;
    try {
      raw = await readFile(table, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      // sl local_address rem_address st … uid timeout inode
      if (fields.length < 10) continue;
      if (fields[3] !== "0A") continue; // TCP_LISTEN
      if (!sockets.has(fields[9]!)) continue;
      const host = decodeProcNetAddress(fields[1]!.split(":")[0]!);
      if (host !== null) addresses.push(host);
    }
  }
  return addresses;
}

/** `/proc/net/tcp*` writes each 32-bit word little-endian, in hex. */
function decodeProcNetAddress(hex: string): string | null {
  if (hex.length === 8) {
    const octets = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return octets.join(".");
  }
  if (hex.length === 32) {
    const words: string[] = [];
    for (let word = 0; word < 4; word += 1) {
      const chunk = hex.slice(word * 8, word * 8 + 8);
      const beChunk =
        chunk.slice(6, 8) + chunk.slice(4, 6) + chunk.slice(2, 4) + chunk.slice(0, 2);
      words.push(beChunk.slice(0, 4), beChunk.slice(4, 8));
    }
    return words.join(":");
  }
  return null;
}

/**
 * Strip the leading zeroes an IPv6 group may carry.
 *
 * `/proc/net/tcp6` renders every group as four hex digits, so loopback arrives
 * as `0000:0000:0000:0000:0000:0000:0000:0001` — the same address as `::1` and
 * not equal to it as a string. Classifying that as exposed would REFUSE a
 * session whose bridge is bound exactly where it is supposed to be, which is a
 * false positive in the one check whose job is to be trusted.
 *
 * Only zero-stripping: no `::` collapsing, because the classifier below
 * compares against fully-expanded forms and adding a second spelling would give
 * it two things to get right instead of one.
 */
function normalizeHexGroups(address: string): string {
  if (!address.includes(":")) return address;
  return address
    .split(":")
    .map((group) => (/^[0-9a-f]+$/.test(group) ? group.replace(/^0+(?=.)/, "") : group))
    .join(":");
}

/** Is a bound address one that only this machine can reach? */
export function isLoopbackBoundAddress(address: string): boolean {
  const bare = normalizeHexGroups(
    address.split("%")[0]!.trim().toLowerCase().replace(/^\[|\]$/g, ""),
  );
  if (bare === "") return false;
  if (/^127\./.test(bare)) return true;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  // IPv4-mapped loopback, in either of the two spellings /proc and lsof use.
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/.exec(bare);
  if (mapped !== null) {
    const inner = mapped[1]!;
    if (/^127\./.test(inner)) return true;
    // /proc renders the mapped v4 half as two hex words, e.g. `::ffff:7f00:1`.
    const hexWords = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
    if (hexWords !== null && parseInt(hexWords[1]!, 16) >> 8 === 0x7f) return true;
  }
  // `*`, `0.0.0.0` and `::` are wildcards: bound to everything, including the
  // LAN. Explicitly NOT loopback.
  return false;
}

/**
 * Fail if the OS reports the bridge bound to anything but loopback.
 *
 * Silent when the platform cannot be asked (`null`) — the connect probe is
 * what enforces, and refusing a session because `lsof` is missing would trade
 * a real capability for no additional safety.
 */
export async function assertBridgeBindingIsLoopback(args: {
  pid: number;
  platform?: NodeJS.Platform;
  read?: (
    pid: number,
    platform: NodeJS.Platform,
  ) => Promise<string[] | null>;
}): Promise<void> {
  const platform = args.platform ?? process.platform;
  const read = args.read ?? readProcessListenAddresses;
  const addresses = await read(args.pid, platform);
  if (addresses === null) return;
  const offBox = addresses.filter(
    (address) => !isLoopbackBoundAddress(address),
  );
  if (offBox.length > 0) {
    throw new BridgeExposureError(
      `the operating system reports the harness bridge listening on ` +
        `${offBox.join(", ")}, which is not loopback. Local execution stops ` +
        `rather than leaving an agent's control channel published to the LAN.`,
    );
  }
}
