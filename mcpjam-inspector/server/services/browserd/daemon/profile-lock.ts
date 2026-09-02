/**
 * L8 — clearing a stale Chromium profile lock before relaunch.
 *
 * A persistent `--user-data-dir` is a SINGLETON: exactly one Chromium may own it
 * at a time, guarded by `SingletonLock` (a symlink) plus `SingletonSocket` /
 * `SingletonCookie`. On a clean exit Chromium removes them; on an UNGRACEFUL
 * kill they remain, and the next launch either fails or silently forwards the
 * URL to a process that is already dead.
 *
 * browserd's recovery posture makes this the common case, not the edge case:
 * the M0 finding is to kill/relaunch on a failed `/healthz` after wake, so every
 * wake that fails health leaves an ungraceful exit behind. The supervisor must
 * therefore clear the lock before each relaunch. Best-effort by design: a
 * missing file is success (nothing to clear), and a lock we cannot remove is
 * surfaced, not thrown — the caller decides whether to proceed.
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";

/** The singleton artifacts Chromium leaves in a user-data dir. */
const SINGLETON_FILES = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
] as const;

export interface ClearedLock {
  /** Names actually removed (were present). */
  removed: string[];
  /** Names that were present but could not be removed, with the error text. */
  failed: Array<{ name: string; error: string }>;
}

/**
 * Remove any stale Chromium singleton files from `userDataDir`. Safe to call
 * when the directory is clean (removes nothing) and when Chromium is NOT running
 * (there is no live owner to disturb — the caller guarantees that by only
 * clearing before a relaunch). ENOENT is treated as already-clear.
 */
export async function clearStaleSingletonLock(
  userDataDir: string,
): Promise<ClearedLock> {
  const result: ClearedLock = { removed: [], failed: [] };
  for (const name of SINGLETON_FILES) {
    try {
      await unlink(join(userDataDir, name));
      result.removed.push(name);
    } catch (err) {
      if (isNotFound(err)) continue; // already clear — the common, healthy case
      result.failed.push({
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
