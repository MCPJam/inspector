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
  } catch (error) {
    // Best-effort: the write may have failed before the file existed, and a
    // cleanup failure must not mask the original error.
    await unlink(temporary).catch(() => {});
    throw error;
  }

  return resolved;
}
