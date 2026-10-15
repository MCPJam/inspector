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

  // Windows resolves commands through PATHEXT and .cmd shims; there the
  // spawn's own error names the command.
  if (process.platform === "win32") return null;
  const { command } = launch;
  if (command.includes("/")) {
    return (await isExecutableFile(path.resolve(cwd, command)))
      ? null
      : { reason: "command_not_executable", command: options.declaredCommand };
  }
  const searchPath = launch.env.PATH ?? process.env.PATH ?? "";
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    if (await isExecutableFile(path.join(dir, command))) return null;
  }
  return { reason: "runtime_not_found", command };
}
