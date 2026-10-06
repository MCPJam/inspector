/**
 * The Inspector layer's bridge launcher.
 *
 * Ships INSIDE THE INSPECTOR, not inside a vendor pack: it is written, with the
 * bridge it launches, into the content-addressed Inspector layer
 * (`<runtimeRoot>/inspector-layer/<digest>/`), re-hashed against the digest
 * compiled into the Inspector before every exec, and spawned by the pack's own
 * verified `bin/node`. Two jobs, both applied before the bridge runs a line.
 *
 * ── 1. Loopback ──────────────────────────────────────────────────────────
 * The bridges call `new WebSocketServer({ port, host: "0.0.0.0" })`. Inside a
 * cloud sandbox that is unremarkable; on a user's own machine it publishes an
 * agent control channel to every device on their network. So this patches
 * `net.Server.prototype.listen` to substitute loopback for any host that is
 * not provably loopback, then imports the bridge. This is defence in depth:
 * `assertBridgeLoopbackOnly` in the provider is the enforcing check.
 *
 * ── 2. Only two trusted sources (invariant 1) ─────────────────────────────
 * Every executable byte comes from a verified vendor pack or from the Inspector
 * distribution. The layer's code is the second; a vendor SDK the bridge imports
 * (Claude Code's `@anthropic-ai/claude-agent-sdk`, which shares a version with
 * its native binary) is the first. A `module.registerHooks` resolve hook makes
 * that a property of module resolution rather than of how the bundle happens
 * to be built: from code inside the layer, an import may resolve only to
 *
 *   - a Node builtin,
 *   - a file inside the layer itself, or
 *   - a bare specifier resolved FROM the vendor root (`--mcpjam-vendor-root`),
 *     and landing inside it.
 *
 * Anything else — a `node_modules` above the layer, a user's global install, a
 * path the layer does not contain — throws instead of loading. Without a
 * vendor root (Codex, whose bridge bundles everything it needs) every bare
 * import from the layer is refused.
 *
 * `registerHooks` exists on Node 22.15+/23.5+, and this only ever runs under
 * the pack's pinned Node 24, so its absence is a pack this layer does not
 * support: refused, never worked around.
 *
 * Argv: `launcher.mjs [--mcpjam-vendor-root <abs>] [--mcpjam-probe] <bridge args…>`.
 * The launcher's own flags are consumed and removed before the bridge reads
 * `process.argv`, so the bridge sees exactly the arguments its adapter emitted.
 *
 * ── 3. The startup probe ─────────────────────────────────────────────────
 * `--mcpjam-probe` is how an install proves a CANDIDATE pack can start this
 * layer before anything selects it (`runtime-probe.ts`): the pack's Node runs
 * this launcher, both guards above are installed, the vendor import the bridge
 * depends on is resolved exactly as the bridge's would be (through the hook,
 * from the layer, into the pack), and it prints one JSON line and exits —
 * without importing the bridge, so no port is opened and no model is called.
 */
import net from "node:net";
import * as nodeModule from "node:module";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOOPBACK = "127.0.0.1";

// ── Launcher arguments ──────────────────────────────────────────────────────
let vendorRoot = null;
if (process.argv[2] === "--mcpjam-vendor-root") {
  const value = process.argv[3];
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("--mcpjam-vendor-root needs an absolute path");
  }
  vendorRoot = resolvePath(value);
  process.argv.splice(2, 2);
}
const probe = process.argv[2] === "--mcpjam-probe";
if (probe) process.argv.splice(2, 1);

// ── Resolution: the layer, the vendor root, and builtins — nothing else ────
const layerDir = fileURLToPath(new URL(".", import.meta.url));
const layerPrefix = layerDir.endsWith(sep) ? layerDir : layerDir + sep;
const vendorPrefix =
  vendorRoot === null ? null : vendorRoot.endsWith(sep) ? vendorRoot : vendorRoot + sep;

const insideDir = (url, prefix) => {
  if (prefix === null || typeof url !== "string" || !url.startsWith("file:")) return false;
  try {
    return fileURLToPath(url).startsWith(prefix);
  } catch {
    return false;
  }
};
const isBuiltinSpecifier = (specifier) =>
  specifier.startsWith("node:") ||
  (typeof nodeModule.isBuiltin === "function" && nodeModule.isBuiltin(specifier));
const isBareSpecifier = (specifier) =>
  !specifier.startsWith(".") &&
  !specifier.startsWith("/") &&
  !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier);

if (typeof nodeModule.registerHooks !== "function") {
  throw new Error(
    "this Inspector layer needs module.registerHooks (Node 22.15+); the " +
      "runtime pack's Node is older than this Inspector supports",
  );
}
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromLayer = insideDir(context.parentURL, layerPrefix);
    if (!fromLayer || isBuiltinSpecifier(specifier)) {
      return nextResolve(specifier, context);
    }
    if (isBareSpecifier(specifier)) {
      if (vendorPrefix === null) {
        throw new Error(
          `the Inspector layer may not import ${JSON.stringify(specifier)}: ` +
            `it names no vendor root, and nothing outside the layer is trusted`,
        );
      }
      const resolved = nextResolve(specifier, {
        ...context,
        parentURL: pathToFileURL(vendorPrefix).href,
      });
      if (!isBuiltinSpecifier(resolved.url) && !insideDir(resolved.url, vendorPrefix)) {
        throw new Error(
          `${JSON.stringify(specifier)} resolved outside the verified runtime ` +
            `pack (${resolved.url}); refusing to load it`,
        );
      }
      return resolved;
    }
    const resolved = nextResolve(specifier, context);
    if (!insideDir(resolved.url, layerPrefix) && !isBuiltinSpecifier(resolved.url)) {
      throw new Error(
        `${JSON.stringify(specifier)} resolved outside the Inspector layer ` +
          `(${resolved.url}); refusing to load it`,
      );
    }
    return resolved;
  },
});

// ── Loopback ────────────────────────────────────────────────────────────────
/**
 * Hosts that reach only this machine. Deliberately a LOOPBACK allowlist rather
 * than a wildcard denylist: a denylist has to enumerate every spelling of
 * "every interface" Node accepts, and the one it misses is a control channel
 * published to the LAN.
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
    if (!isLoopbackHost(first.host)) args[0] = { ...first, host: LOOPBACK };
  } else if (
    typeof first === "number" ||
    (typeof first === "string" && /^\d+$/.test(first))
  ) {
    // `listen(port[, host][, backlog][, cb])`. Either the host argument is
    // there and not loopback, or it is absent and loopback is inserted before
    // whatever followed.
    if (typeof args[1] === "string") {
      if (!isLoopbackHost(args[1])) args[1] = LOOPBACK;
    } else {
      args.splice(1, 0, LOOPBACK);
    }
  }
  return originalListen.apply(this, args);
};

if (probe) {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const layer = JSON.parse(readFileSync(new URL("./layer.json", import.meta.url), "utf8"));
  const result = { mcpjamProbe: "ok", harnessId: layer.harnessId, node: process.version };
  if (layer.harnessId === "claude-code") {
    // The bridge's one external import, resolved and loaded exactly as the
    // bridge will: a pack whose SDK the hook cannot reach fails here.
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    if (typeof sdk.query !== "function") throw new Error("the pack's agent SDK exports no query()");
  } else if (layer.harnessId === "codex") {
    // Codex's bridge spawns the pack's codex.js; it must be where it looks.
    if (vendorRoot === null || !existsSync(join(vendorRoot, "node_modules", "@openai", "codex", "bin", "codex.js"))) {
      throw new Error("the pack has no node_modules/@openai/codex/bin/codex.js");
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

await import("./bridge.mjs");
