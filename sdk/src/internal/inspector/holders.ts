import { mkdirSync, unlinkSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
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

/**
 * Writes this process's holder file for the port and returns its release.
 * Several launches in one process share the file. Returns undefined when
 * the directory cannot be written; the caller then cannot share MCPJam.
 */
export function holdInspector(
  port: number,
  options: { home?: string; pid?: number } = {},
): (() => void) | undefined {
  const pid = options.pid ?? process.pid;
  const dir = inspectorHoldersDir(port, options.home);
  const file = path.join(dir, `${pid}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
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
    if (released) return;
    released = true;
    const remaining = (holdsByPort.get(port) ?? 1) - 1;
    if (remaining > 0) {
      holdsByPort.set(port, remaining);
      return;
    }
    holdsByPort.delete(port);
    try {
      unlinkSync(file);
    } catch {
      // The watchdog may already have removed it.
    }
  };
}

/** Holder files for the port other than this process's own. */
export function otherInspectorHolders(
  port: number,
  options: { home?: string; pid?: number; isAlive?: (pid: number) => boolean } = {},
): number {
  const own = `${options.pid ?? process.pid}.json`;
  const isAlive = options.isAlive ?? isPidAlive;
  try {
    return readdirSync(inspectorHoldersDir(port, options.home)).filter(
      (name) =>
        name.endsWith(".json") &&
        name !== own &&
        isAlive(Number(name.replace(/\.json$/, ""))),
    ).length;
  } catch {
    return 0;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
