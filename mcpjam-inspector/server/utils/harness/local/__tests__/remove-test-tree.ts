/**
 * Remove a test's temporary runtime root.
 *
 * A runtime root can hold this build's Inspector layer, which is read-only by
 * design: its directory is 0o555, so an unprivileged process cannot unlink the
 * files in it. Root can, so a plain `rm` passed on a root dev box and failed
 * with EACCES on CI's runner user. Every directory is made writable again
 * (symlinks are not followed) before the tree is removed.
 */
import { chmod, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => {});
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await makeWritable(join(dir, entry.name));
  }
}

export async function removeTestTree(path: string): Promise<void> {
  await makeWritable(path);
  await rm(path, { recursive: true, force: true });
}
