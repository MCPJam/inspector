/**
 * The runtime pack's bridge launcher.
 *
 * Ships INSIDE the pack as `launcher.mjs`, covered by the pack's tree digest,
 * and is what the supervisor actually spawns. It exists for one reason: the
 * pinned adapters' bridges call
 * `new WebSocketServer({ port, host: "0.0.0.0" })`.
 *
 * Inside a cloud sandbox that is unremarkable — the box is the boundary. On a
 * user's own machine it publishes an agent control channel to every device on
 * whatever network they are on. The bridge file cannot simply be edited to fix
 * it: the provider byte-compares the pack's `bridge.mjs` against the pinned
 * adapter's recipe copy, and a patched bridge would fail that compare (which is
 * the correct behaviour — a modified vendor artifact should not run).
 *
 * So the constraint is applied from OUTSIDE the file. This module patches
 * `net.Server.prototype.listen` to substitute loopback for any wildcard host,
 * then imports the verbatim bridge. The bridge runs at import time and reads
 * `process.argv.slice(2)` itself, so importing it is the whole invocation.
 *
 * This is defence in depth, not the guarantee. `assertBridgeLoopbackOnly` in
 * the provider is the enforcing check: it connects to the port through every
 * non-loopback local address and refuses the session if any of them answers,
 * and it reads the binding back out of the kernel. A pack whose launcher was
 * removed or subverted fails there, which is exactly what the `no-launcher`
 * conformance scenario asserts.
 */
import net from "node:net";

const LOOPBACK = "127.0.0.1";

/**
 * Hosts that reach only this machine.
 *
 * Deliberately a LOOPBACK allowlist rather than a wildcard denylist. A denylist
 * has to enumerate every spelling of "every interface" Node accepts — `""`,
 * `0.0.0.0`, `::`, `::0`, `0`, `[::]` — and the one it misses is a control
 * channel published to the LAN. An allowlist fails the other way: an exotic
 * spelling of loopback gets forced to `127.0.0.1`, which is where it was going
 * anyway.
 */
const isLoopbackHost = (host) => {
  if (typeof host !== "string") return false;
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (bare === "localhost") return true;
  if (/^127(\.\d{1,3}){3}$/.test(bare)) return true;
  if (bare === "::1") return true;
  // Zero-padded and IPv4-mapped spellings of the same two addresses.
  const groups = bare.split(":").map((g) => g.replace(/^0+(?=.)/, ""));
  if (bare.includes(":") && groups.join(":") === "0:0:0:0:0:0:0:1") return true;
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/.exec(groups.join(":"));
  return mapped !== null && /^127(\.\d{1,3}){3}$/.test(mapped[1]);
};

/** Anything this launcher will rewrite: not provably loopback. */
const isWildcardHost = (host) => !isLoopbackHost(host);

const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function listenOnLoopback(...args) {
  const first = args[0];
  if (
    typeof first === "object" &&
    first !== null &&
    !("fd" in first) &&
    !("path" in first)
  ) {
    // `listen({ port, host })`. A unix socket (`path`) and a pre-bound
    // descriptor (`fd`) have no host to constrain and are left alone.
    if (isWildcardHost(first.host)) args[0] = { ...first, host: LOOPBACK };
  } else if (
    typeof first === "number" ||
    (typeof first === "string" && /^\d+$/.test(first))
  ) {
    // `listen(port[, host][, backlog][, cb])`. Either the host argument is
    // there and wildcard, or it is absent and loopback is inserted before
    // whatever followed.
    if (typeof args[1] === "string") {
      if (isWildcardHost(args[1])) args[1] = LOOPBACK;
    } else {
      args.splice(1, 0, LOOPBACK);
    }
  }
  return originalListen.apply(this, args);
};

await import("./bridge.mjs");
