/**
 * The conformance suite's listener check, against stand-in `lsof` scripts so
 * it doesn't depend on the machine running it (CI's test container has no
 * `lsof`): a process's TCP listeners, none for a process that listens on
 * nothing, and `null` when they cannot be read, so the loopback check fails
 * rather than passing on a missing or failing tool.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isLoopbackListener, listeners, treeListeners } from "../conformance/process-checks.js";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A directory for PATH holding, when `script` is given, an `lsof` that runs it. */
function pathWithLsof(script?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lsof-stand-in-"));
  dirs.push(dir);
  if (script !== undefined) {
    writeFileSync(join(dir, "lsof"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "lsof"), 0o755);
  }
  return dir;
}

async function withPath<T>(path: string, read: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return await read();
  } finally {
    process.env.PATH = saved;
  }
}

// `listeners` asks `netstat` on Windows; these cover the `lsof` side.
describe.skipIf(process.platform === "win32")("a process's listeners, as lsof reports them", () => {
  it("lists each listening socket's address", async () => {
    const path = pathWithLsof(
      "printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\nnode 42 me 20u IPv4 0x1 0t0 TCP 127.0.0.1:5555 (LISTEN)\\n'",
    );
    const found = await withPath(path, () => listeners(42));
    expect(found).toEqual(["127.0.0.1:5555 (LISTEN)"]);
    expect(isLoopbackListener(found![0]!)).toBe(true);
  });

  it("reads exit 1 with nothing on stdout as no listeners, even with a warning on stderr", async () => {
    const path = pathWithLsof("echo \"lsof: WARNING: can't stat() overlay file system\" >&2; exit 1");
    expect(await withPath(path, () => listeners(42))).toEqual([]);
    expect(await withPath(path, () => treeListeners([42, 43]))).toEqual([]);
  });

  it("has no answer when lsof fails another way or is missing, and neither does the tree", async () => {
    expect(await withPath(pathWithLsof("exit 2"), () => listeners(42))).toBeNull();
    const missing = pathWithLsof();
    expect(await withPath(missing, () => listeners(42))).toBeNull();
    expect(await withPath(missing, () => treeListeners([42]))).toBeNull();
  });
});
