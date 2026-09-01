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
 * A packaged build shipping its own signed Node runtime alongside the managed
 * bundle is the preferred shape once the bundle build lands. It is deliberately
 * NOT an option here yet: an "absolute path the caller promises is the right
 * Node" is a trust path with no verification behind it, and adding the option
 * before there is a digest to check it against would be exactly that. It
 * arrives with the bundle build, and with the same digest verification the rest
 * of the runtime gets.
 */
import { isAbsolute } from "node:path";

export interface NodeLauncher {
  /** Absolute path to the executable the supervisor spawns. */
  executable: string;
  /** Environment entries this launcher REQUIRES, merged by the provider after
   *  the allowlisted base environment is built. */
  requiredEnv: Readonly<Record<string, string>>;
  kind: "node" | "electron-as-node";
}

export class NodeLauncherError extends Error {}

export function resolveNodeLauncher(opts?: {
  execPath?: string;
  isElectron?: boolean;
}): NodeLauncher {
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
