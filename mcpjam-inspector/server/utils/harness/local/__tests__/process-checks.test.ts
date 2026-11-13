/**
 * The conformance suite's listener check: a process's TCP listeners, none for
 * a process that listens on nothing, and `null` when they cannot be read, so
 * the loopback check fails rather than passing on a missing tool.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { isLoopbackListener, listeners, treeListeners } from "../conformance/process-checks.js";

const children: ChildProcess[] = [];

afterAll(() => {
  for (const child of children) child.kill();
});

/** A node process, listening on loopback or on nothing, once it is ready. */
async function start(listen: boolean): Promise<number> {
  const script = listen
    ? "require('net').createServer().listen(0, '127.0.0.1', () => console.log('ready'))"
    : "console.log('ready'); setInterval(() => {}, 1000)";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  await once(createInterface({ input: child.stdout! }), "line");
  return child.pid!;
}

describe("a process's listeners", () => {
  it("lists a loopback listener", async () => {
    const found = await listeners(await start(true));
    expect(found).toHaveLength(1);
    expect(isLoopbackListener(found![0]!)).toBe(true);
  });

  it("lists none for a process that listens on nothing", async () => {
    const pid = await start(false);
    expect(await listeners(pid)).toEqual([]);
    expect(await treeListeners([pid])).toEqual([]);
  });

  it("has no answer when the tool that reads them is missing, and neither does its tree", async () => {
    const quiet = await start(false);
    const listening = await start(true);
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(await listeners(quiet)).toBeNull();
      expect(await treeListeners([listening, quiet])).toBeNull();
    } finally {
      process.env.PATH = path;
    }
  });
});
