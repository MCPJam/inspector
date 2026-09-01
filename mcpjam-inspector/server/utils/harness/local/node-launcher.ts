/**
 * Which Node binary launches the harness bridge, and how.
 *
 * The supervisor spawns absolute paths only, so "run the bridge with node" has
 * to name a specific executable. There is no `PATH` lookup and no `npx`; the
 * user's own Node version — or a version manager's shim — is deliberately not
 * consulted, because it is writable by everything the user runs and would make
 * the launcher a different binary from the one consent named.
 *
 * Two supported shapes:
 *
 *  - a plain Node process (`npx @mcpjam/inspector`): `process.execPath` IS
 *    node, so it is used directly;
 *  - an Electron main process: `process.execPath` is the app binary, which
 *    behaves as Node only with `ELECTRON_RUN_AS_NODE=1`. That invocation is
 *    explicit here rather than implied somewhere in a spawn call, because it
 *    is a conformance-tested property of the launch, not a detail.
 *
 * A packaged build that ships its own signed Node runtime alongside the
 * managed bundle passes it as `override`; that is the preferred shape once the
 * bundle build lands, since it pins the runtime the bundle was tested against
 * instead of inheriting whatever the app happens to embed.
 */
import { isAbsolute } from "node:path";

export interface NodeLauncher {
  /** Absolute path to the executable the supervisor spawns. */
  executable: string;
  /** Environment entries this launcher REQUIRES, merged by the provider after
   *  the allowlisted base environment is built. */
  requiredEnv: Readonly<Record<string, string>>;
  kind: "node" | "electron-as-node" | "bundled";
}

export class NodeLauncherError extends Error {}

export function resolveNodeLauncher(opts?: {
  /** Absolute path to a Node runtime shipped with the managed bundle. */
  override?: string;
  execPath?: string;
  isElectron?: boolean;
}): NodeLauncher {
  if (opts?.override !== undefined) {
    if (!isAbsolute(opts.override)) {
      throw new NodeLauncherError(
        "a bundled Node runtime must be given as an absolute path"
      );
    }
    return { executable: opts.override, requiredEnv: {}, kind: "bundled" };
  }

  const execPath = opts?.execPath ?? process.execPath;
  if (!execPath || !isAbsolute(execPath)) {
    throw new NodeLauncherError(
      "could not determine an absolute Node executable for the harness bridge"
    );
  }
  const isElectron =
    opts?.isElectron ?? typeof process.versions.electron === "string";

  return isElectron
    ? {
        executable: execPath,
        requiredEnv: { ELECTRON_RUN_AS_NODE: "1" },
        kind: "electron-as-node",
      }
    : { executable: execPath, requiredEnv: {}, kind: "node" };
}
