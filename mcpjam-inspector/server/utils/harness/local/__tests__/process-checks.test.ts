/**
 * The conformance suite's listener check, against stand-in `lsof` scripts so
 * it doesn't depend on the machine running it (CI's test container has no
 * `lsof`): a process's TCP listeners, none for a process that listens on
 * nothing, and `null` when they cannot be read, so the loopback check fails
 * rather than passing on a missing or failing tool. Also the Windows
 * process-tree walk, from a captured table.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  descendantsInTable,
  isLoopbackListener,
  listeners,
  parseProcessTable,
  treeListeners,
} from "../conformance/process-checks.js";

// The windows-latest leg that failed: the bridge landed on pid 704, which a
// boot-time process had held, and that process's orphans (wininit, services,
// svchost) still name 704 as their parent.
const BOOT = 134394000000000000n;
const LATER = 134394160793897383n;
const RUNNER_TABLE = [
  "0 0 -",
  "4 0 -",
  `716 704 ${BOOT + 10n}`,
  `840 716 ${BOOT + 20n}`,
  `932 840 ${BOOT + 30n}`,
  `704 5612 ${LATER}`,
  `9872 704 ${LATER + 5_000n}`,
  `9904 9872 ${LATER + 9_000n}`,
  // Same tick as its parent: still its child.
  `9512 9872 ${LATER + 5_000n}`,
  // Older than 9872, so an orphan of an earlier 9872, not its child.
  `3584 9872 ${LATER + 1_000n}`,
].join("\r\n");

describe("the Windows process tree", () => {
  it("parses pid, parent and start, with a hidden start as null", () => {
    expect(parseProcessTable("4 0 -\r\n704 5612 134394160793897383\r\n\r\nnoise\r\n")).toEqual([
      { pid: 4, parent: 0, started: null },
      { pid: 704, parent: 5612, started: 134394160793897383n },
    ]);
  });

  it("skips processes older than the pid they name as parent, at any depth", () => {
    expect(descendantsInTable(parseProcessTable(RUNNER_TABLE), 704)).toEqual([9872, 9904, 9512]);
  });

  it("still walks the boot-time tree from its real root", () => {
    expect(descendantsInTable(parseProcessTable(RUNNER_TABLE), 716)).toEqual([840, 932]);
  });

  it("claims nothing for a root that is not in the table", () => {
    expect(descendantsInTable(parseProcessTable(RUNNER_TABLE), 1234)).toEqual([]);
  });

  it("claims nothing under a process whose start CIM hides", () => {
    expect(descendantsInTable(parseProcessTable(RUNNER_TABLE), 0)).toEqual([]);
  });

  it("terminates on a process that names itself as parent", () => {
    expect(descendantsInTable(parseProcessTable(`77 77 ${LATER}\r\n78 77 ${LATER}`), 77)).toEqual([78]);
  });
});

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
