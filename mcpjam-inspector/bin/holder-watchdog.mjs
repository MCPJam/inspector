/**
 * Shared ownership of an MCPJam started by a dev command.
 *
 * Every dev command that starts or reuses this MCPJam writes a holder file,
 * `<pid>.json`, into the directory named by `MCPJAM_INSPECTOR_HOLDERS_DIR`
 * (see `@mcpjam/sdk/internal/inspector`). `bin/start.js` runs this watchdog
 * for such an MCPJam: it deletes files whose process is gone and shuts down
 * after two checks in a row find no live holder. An MCPJam started by hand
 * has no holders directory, so a dev command never stops it.
 *
 * Plain ESM with no dependencies: the launcher runs under a bare Node.
 */
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const HOLDER_CHECK_INTERVAL_MS = 2_000;
/** Gives the starting dev command time to finish writing its own file. */
export const HOLDER_FIRST_CHECK_DELAY_MS = 5_000;
const IDLE_CHECKS_BEFORE_SHUTDOWN = 2;

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

function readHolderPid(dir, name) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0) return parsed.pid;
  } catch {
    // A file still being written, or garbage: fall back to its name.
  }
  const fromName = Number(name.replace(/\.json$/, ""));
  return Number.isInteger(fromName) && fromName > 0 ? fromName : undefined;
}

/**
 * Counts holders whose process is still running and deletes the rest. A
 * missing directory counts as no holders.
 */
export function countLiveHolders(dir, isAlive = defaultIsAlive) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return 0;
  }
  let live = 0;
  for (const name of names) {
    const pid = readHolderPid(dir, name);
    if (pid !== undefined && isAlive(pid)) {
      live += 1;
      continue;
    }
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Another process removed it first.
    }
  }
  return live;
}

/**
 * Calls `onIdle` once, after two consecutive checks find no live holder.
 * Returns a function that stops the watchdog.
 */
export function startHolderWatchdog({
  dir,
  onIdle,
  isAlive = defaultIsAlive,
  intervalMs = HOLDER_CHECK_INTERVAL_MS,
  firstCheckDelayMs = HOLDER_FIRST_CHECK_DELAY_MS,
}) {
  let idleChecks = 0;
  let timer;
  let stopped = false;
  const check = () => {
    if (stopped) return;
    idleChecks = countLiveHolders(dir, isAlive) === 0 ? idleChecks + 1 : 0;
    if (idleChecks >= IDLE_CHECKS_BEFORE_SHUTDOWN) {
      stopped = true;
      onIdle();
      return;
    }
    timer = setTimeout(check, intervalMs);
    timer.unref?.();
  };
  timer = setTimeout(check, firstCheckDelayMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
