import {
  chmodSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shared ownership of an MCPJam a dev command started.
 *
 * Each process holding an MCPJam writes `<pid>.json` into the port's holders
 * directory. The started MCPJam (`bin/start.js`, with
 * `MCPJAM_INSPECTOR_HOLDERS_DIR`) stops once no file names a live process,
 * so quitting one dev command leaves MCPJam up for the others. The files
 * carry no credentials; the directory sits beside the discovery file and has
 * the same same-user permissions.
 */
export function inspectorHoldersDir(port: number, home = os.homedir()): string {
  return path.join(home, ".mcpjam", "inspector", `${port}.holders`);
}

/** Launches in this process that hold each port; the file goes with the last. */
const holdsByPort = new Map<number, number>();

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Deletes the files of processes that are gone and returns the pids still
 * running. A dev command killed without `stop()` leaves its file behind, and
 * when MCPJam was started by hand no watchdog is there to remove it; a later
 * process that reuses the pid would otherwise count as a holder.
 */
function pruneDeadHolders(
  dir: string,
  isAlive: (pid: number) => boolean,
): number[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    // No holders directory: nothing holds this port.
    return [];
  }
  const live: number[] = [];
  for (const name of names) {
    const pid = Number(name.replace(/\.json$/, ""));
    if (isAlive(pid)) {
      live.push(pid);
      continue;
    }
    try {
      unlinkSync(path.join(dir, name));
    } catch {
      // The watchdog or another process removed it first.
    }
  }
  return live;
}

/**
 * Writes this process's holder file for the port and returns its release.
 * Several launches in one process share the file, and a release reports
 * whether this process still holds the port for another launch. Returns
 * undefined when the directory cannot be written; the caller then cannot
 * share MCPJam.
 */
export function holdInspector(
  port: number,
  options: { home?: string; pid?: number; isAlive?: (pid: number) => boolean } = {},
): (() => boolean) | undefined {
  const pid = options.pid ?? process.pid;
  const dir = inspectorHoldersDir(port, options.home);
  const file = path.join(dir, `${pid}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    pruneDeadHolders(dir, options.isAlive ?? isPidAlive);
    writeFileSync(
      file,
      JSON.stringify({ pid, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch {
    // Sharing is optional: an unwritable home only loses "quit A, keep B".
    return undefined;
  }
  holdsByPort.set(port, (holdsByPort.get(port) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return (holdsByPort.get(port) ?? 0) > 0;
    released = true;
    const remaining = (holdsByPort.get(port) ?? 1) - 1;
    if (remaining > 0) {
      holdsByPort.set(port, remaining);
      return true;
    }
    holdsByPort.delete(port);
    try {
      unlinkSync(file);
    } catch {
      // The watchdog may already have removed it.
    }
    return false;
  };
}

/** Live holders of the port other than this process. */
export function otherInspectorHolders(
  port: number,
  options: { home?: string; pid?: number; isAlive?: (pid: number) => boolean } = {},
): number {
  const own = options.pid ?? process.pid;
  return pruneDeadHolders(
    inspectorHoldersDir(port, options.home),
    options.isAlive ?? isPidAlive,
  ).filter((pid) => pid !== own).length;
}
