/**
 * Replace a file's contents, or leave the file exactly as it was.
 *
 * Extracted from `corpus-lock.ts:writeCorpusLockAtomic`, which is now one
 * caller of this. The reasoning is that module's, restated here because it is
 * the reason this function exists rather than a plain `writeFile`:
 *
 * A file that is READ BACK — a corpus lock under `--frozen`, a suite file
 * handed to the loader — must never be half-written. A plain `writeFile` that
 * dies mid-flight (disk full, SIGINT between two `write` syscalls) leaves a
 * file that does not look broken. It looks like a lock that lost cases, or a
 * suite that lost half its tests, and the next command reports that as a real
 * change nobody made.
 *
 * So: write a temp file in the DESTINATION DIRECTORY, `fsync` it, then
 * `rename`. `rename` within one filesystem is atomic, so a reader sees either
 * the old bytes or the new ones and never a half of either. The temp file must
 * be a SIBLING — `os.tmpdir()` is frequently a different filesystem, where
 * `rename` degrades to copy-then-unlink and loses the atomicity that is the
 * entire point.
 *
 * On ANY failure the temp file is removed and the destination is untouched.
 * The error is re-thrown for the caller to classify: the two callers here
 * disagree about what a failed write MEANS (the lock's exit 3 says "no
 * comparison happened"; an export's exit 1 says "nothing was written"), and a
 * helper that picked one of those for them would be wrong for the other.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type AtomicWriteOptions = {
  /** File mode for the destination. Defaults to `0o644`. */
  mode?: number;
  /** Create the destination's parent directories first. Defaults to `false`. */
  createParents?: boolean;
};

/**
 * Write `body` to `destinationPath`, atomically.
 *
 * `destinationPath` is resolved against the working directory; the resolved
 * path is returned so a caller can report where the bytes actually landed.
 */
export async function writeFileAtomic(
  destinationPath: string,
  body: string,
  options: AtomicWriteOptions = {}
): Promise<string> {
  const resolved = path.resolve(process.cwd(), destinationPath);
  // The random suffix keeps two concurrent writers (a developer and a CI job
  // on the same checkout) from writing the same temp path and corrupting each
  // other's output.
  const temporary = `${resolved}.${process.pid}-${randomBytes(6).toString(
    "hex"
  )}.tmp`;
  // Which side of the rename a failure lands on decides whether there is a
  // temp file left to clean up, and whether the destination changed.
  let renamed = false;

  try {
    if (options.createParents) {
      await mkdir(path.dirname(resolved), { recursive: true });
    }
    await writeFile(temporary, body, {
      encoding: "utf8",
      mode: options.mode ?? 0o644,
    });
    // Flush before the rename. Without this the rename can be durable while
    // the bytes it points at are not, which after a crash leaves a file that
    // exists and is empty — the failure mode this whole function exists to
    // prevent, just moved one layer down.
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, resolved);
    renamed = true;
    // `rename` is atomic for a READER the instant it returns, but it is not
    // yet DURABLE: the new directory entry can still be sitting in the page
    // cache. A crash in that window leaves the destination holding the
    // previous bytes — or nothing — after this function already reported
    // success. Flushing the containing directory is what closes that window,
    // and it is the second half of the recipe whose first half is the fsync
    // above.
    await syncDirectory(path.dirname(resolved));
  } catch (error) {
    // Only before the rename. Afterwards the temp NAME no longer exists, and
    // unlinking `resolved` under its new name is the last thing a failed
    // durability flush should do. Best-effort either way: the write may have
    // failed before the file existed, and a cleanup failure must not mask the
    // original error.
    if (!renamed) {
      await unlink(temporary).catch(() => {});
    }
    throw error;
  }

  return resolved;
}

/**
 * Flush a directory's entries to storage.
 *
 * Skipped on Windows, where Node cannot open a directory handle at all — the
 * call fails with `EPERM`/`EISDIR` rather than doing nothing, so attempting it
 * would turn every successful write on that platform into an error. NTFS
 * commits the directory entry as part of the rename, so there is nothing this
 * would add there.
 *
 * Everywhere else a failure PROPAGATES. A durability flush that quietly failed
 * would leave this function reporting a success it cannot vouch for, which is
 * the same class of bug the temp-file dance exists to prevent.
 */
async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
