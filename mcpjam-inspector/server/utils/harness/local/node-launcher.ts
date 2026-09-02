/**
 * Which Node binary launches the harness bridge, and how.
 *
 * The supervisor spawns absolute paths only, so "run the bridge with node" has
 * to name a specific executable. There is no `PATH` lookup and no `npx`; the
 * user's own Node version — or a version manager's shim — is deliberately not
 * consulted, because it is writable by everything the user runs and would make
 * the launcher a different binary from the one consent named.
 *
 * There is exactly one supported shape, and it is the runtime pack's own
 * `bin/node`:
 *
 *  - Electron cannot be the launcher. `forge.config.ts` sets the `RunAsNode`
 *    fuse to false, so `ELECTRON_RUN_AS_NODE=1` is inert in every packaged
 *    build. The branch that relied on it was dead code that would have failed
 *    at spawn time in exactly the distribution it was written for.
 *  - The npx server's own `process.execPath` is a Node the user installed,
 *    outside the pack, and therefore outside the digest consent named. Using
 *    it would mean the verified runtime is verified except for the binary that
 *    interprets it.
 *
 * So both distributions run the same `bin/node` shipped inside the pack, which
 * `computeTreeDigest` covers along with `launcher.mjs` and `bridge.mjs`. The
 * caller passes the path it resolved from the VERIFIED runtime; this module
 * refuses anything that is not absolute, and refuses to fall back to a Node it
 * cannot name a digest for.
 */
import { isAbsolute } from "node:path";

export interface NodeLauncher {
  /** Absolute path to the executable the supervisor spawns. */
  executable: string;
  /** Environment entries this launcher REQUIRES, merged by the provider after
   *  the allowlisted base environment is built. */
  requiredEnv: Readonly<Record<string, string>>;
  kind: "bundled";
}

export class NodeLauncherError extends Error {}

/**
 * Resolve the launcher from a verified runtime's bundled Node.
 *
 * `bundledNodePath` comes from `ResolvedRuntime.nodePath`, which is inside the
 * tree the digest just covered. There is deliberately no `execPath` fallback:
 * an unverified "absolute path the caller promises is Node" is a trust path
 * with nothing behind it, and the whole point of the pack is that there is
 * something behind it.
 */
export function resolveNodeLauncher(opts: {
  bundledNodePath: string;
}): NodeLauncher {
  const executable = opts.bundledNodePath;
  if (!executable || !isAbsolute(executable)) {
    throw new NodeLauncherError(
      "the harness bridge launcher must be an absolute path to the Node " +
        "binary inside the verified runtime pack",
    );
  }
  return { executable, requiredEnv: {}, kind: "bundled" };
}
