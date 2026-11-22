import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * What a plugin's stdio component is checked for at launch, after its
 * placeholders resolve and before anything spawns.
 *
 * The parser already refuses a working directory that leaves its
 * placeholder, but a stored row can outlive the parser that checked it, and
 * the writable data directory can hold a symlink to anywhere. So the resolved
 * directory is checked here against where it really is. The command is
 * checked too, so a missing runtime or a bundle file that lost its executable
 * bit is reported by name instead of as a failed spawn.
 */
export type PluginLaunchGuardFailure =
  | { reason: "working_directory_outside_plugin" }
  | { reason: "working_directory_missing" }
  /** A bare command (a runtime such as `uvx`) that is not on the PATH. */
  | { reason: "runtime_not_found"; command: string }
  /** A command in the plugin's files that is missing or not executable. */
  | { reason: "command_not_executable"; command: string };

/** `child` is `base` or inside it, by path alone. */
function isWithin(base: string, child: string, paths = path): boolean {
  const rel = paths.relative(base, child);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(rel))
  );
}

const realOrSelf = (target: string) => realpath(target).catch(() => target);

const isExecutableFile = async (target: string) =>
  (await stat(target).then(
    (info) => info.isFile(),
    () => false,
  )) &&
  access(target, constants.X_OK).then(
    () => true,
    () => false,
  );

/**
 * Check one resolved launch. `remote` launches run in a box this machine
 * cannot inspect, so only the path rule applies there; the box reports its
 * own missing commands when it spawns.
 */
export async function checkPluginLaunch(
  launch: {
    command: string;
    env: Record<string, string>;
    workingDirectory: string;
  },
  roots: { root: string; dataDir: string },
  options: { remote: boolean; declaredCommand: string },
): Promise<PluginLaunchGuardFailure | null> {
  const cwd = launch.workingDirectory;
  if (options.remote) {
    return [roots.root, roots.dataDir].some((base) =>
      isWithin(base, cwd, path.posix),
    )
      ? null
      : { reason: "working_directory_outside_plugin" };
  }

  let real: string;
  try {
    real = await realpath(cwd);
  } catch {
    // Missing or unreadable: there is nowhere to start the server.
    return { reason: "working_directory_missing" };
  }
  const bases = await Promise.all([roots.root, roots.dataDir].map(realOrSelf));
  if (!bases.some((base) => isWithin(base, real))) {
    return { reason: "working_directory_outside_plugin" };
  }

  const windows = process.platform === "win32";
  // Looked up as the spawn looks it up: from the directory the server runs
  // in, where a relative PATH entry starts and an empty one points.
  const { command } = launch;
  if (command.includes("/") || (windows && command.includes("\\"))) {
    // Windows has no executable bit to check; there the spawn's own error
    // names a bundle file that is missing.
    if (windows) return null;
    return (await isExecutableFile(path.resolve(real, command)))
      ? null
      : { reason: "command_not_executable", command: options.declaredCommand };
  }
  // The server's environment adds to this process's. With no PATH in either,
  // the spawn searches the system default, which only it knows.
  const searchPath = launch.env.PATH ?? process.env.PATH;
  if (searchPath === undefined) return null;
  let dirs = searchPath.split(path.delimiter);
  let names = [command];
  if (windows) {
    // The stdio transport spawns through cross-spawn 7, whose `which` 2 looks
    // in the working directory first, drops the quotes around a quoted PATH
    // entry, and finds `uvx` as `uvx.exe` or `uvx.cmd` by trying each suffix
    // of this process's PATHEXT. When no suffix matches it retries the bare
    // name, which is how it runs an extensionless shebang script.
    dirs = [
      real,
      ...dirs.map((dir) => (/^".*"$/.test(dir) ? dir.slice(1, -1) : dir)),
    ];
    const suffixes = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";");
    names = [...suffixes.map((suffix) => command + suffix), command];
  }
  for (const dir of dirs) {
    for (const name of names) {
      if (await isExecutableFile(path.resolve(real, dir, name))) return null;
    }
  }
  return { reason: "runtime_not_found", command };
}
