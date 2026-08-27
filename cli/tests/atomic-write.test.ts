/**
 * `writeFileAtomic` — the temp-file-then-rename half of the corpus lock, now
 * shared with `eval export`.
 *
 * The lock's own tests still cover what a failed write MEANS to the lock (exit
 * 3, "no comparison happened"). What is proven here is the mechanic underneath
 * both callers: the temp file is a sibling, it is gone whether the write
 * succeeded or failed, and a failure never touches the destination.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../src/lib/atomic-write.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-atomic-write-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("writeFileAtomic", () => {
  test("writes the file and leaves no temp sibling", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "out.yaml");
      const written = await writeFileAtomic(target, "hello\n");

      assert.equal(written, target);
      assert.equal(await readFile(target, "utf8"), "hello\n");
      assert.deepEqual(await readdir(dir), ["out.yaml"]);
    });
  });

  test("replaces existing contents in one step", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "out.yaml");
      await writeFile(target, "old\n", "utf8");
      await writeFileAtomic(target, "new\n");

      assert.equal(await readFile(target, "utf8"), "new\n");
      assert.deepEqual(await readdir(dir), ["out.yaml"]);
    });
  });

  test("creates parent directories only when asked", async () => {
    await withTempDir(async (dir) => {
      const nested = path.join(dir, "a", "b", "out.yaml");

      await assert.rejects(() => writeFileAtomic(nested, "x\n"));
      assert.deepEqual(await readdir(dir), []);

      await writeFileAtomic(nested, "x\n", { createParents: true });
      assert.equal(await readFile(nested, "utf8"), "x\n");
    });
  });

  test("cleans up and leaves the destination alone when the rename fails", async () => {
    await withTempDir(async (dir) => {
      // A non-empty directory at the destination: the temp file is written and
      // fsynced, and only the `rename` onto it fails. Root-proof, unlike a
      // read-only parent — CI runs as root and root writes through mode bits.
      const target = path.join(dir, "out.yaml");
      await mkdir(target);
      await writeFile(path.join(target, "keep.txt"), "untouched\n", "utf8");

      await assert.rejects(() => writeFileAtomic(target, "new\n"));

      assert.deepEqual(await readdir(target), ["keep.txt"]);
      assert.deepEqual(await readdir(dir), ["out.yaml"]);
    });
  });

  test("re-throws the original failure for the caller to classify", async () => {
    await withTempDir(async (dir) => {
      // The two callers disagree about what a failed write means — the lock
      // says exit 3, an export says nothing was written — so this helper must
      // not pick one of those for them.
      const error = await writeFileAtomic(
        path.join(dir, "missing", "out.yaml"),
        "x\n"
      ).catch((caught: unknown) => caught);
      assert.ok(error instanceof Error);
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    });
  });
});
