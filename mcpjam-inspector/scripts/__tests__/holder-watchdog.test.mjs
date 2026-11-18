import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countLiveHolders,
  startHolderWatchdog,
} from "../../bin/holder-watchdog.mjs";

function holdersDir(pids) {
  const dir = mkdtempSync(join(tmpdir(), "mcpjam-holders-"));
  for (const pid of pids) {
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid }));
  }
  return dir;
}

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("counts live holders and deletes the files of exited processes", () => {
  const dir = holdersDir([101, 202]);
  try {
    const live = countLiveHolders(dir, (pid) => pid === 101);
    assert.equal(live, 1);
    assert.deepEqual(readdirSync(dir), ["101.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing directory counts as no holders", () => {
  assert.equal(countLiveHolders(join(tmpdir(), "does-not-exist-mcpjam")), 0);
});

test("falls back to the file name when a holder file is unreadable", () => {
  const dir = holdersDir([]);
  try {
    writeFileSync(join(dir, "303.json"), "{not json");
    assert.equal(countLiveHolders(dir, (pid) => pid === 303), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stops only after two checks in a row with no live holder", async () => {
  const dir = holdersDir([101]);
  let alive = true;
  let idle = 0;
  const stop = startHolderWatchdog({
    dir,
    onIdle: () => {
      idle += 1;
    },
    isAlive: () => alive,
    intervalMs: 10,
    firstCheckDelayMs: 0,
  });
  try {
    await waitFor(40);
    assert.equal(idle, 0, "a live holder keeps MCPJam up");
    alive = false;
    await waitFor(60);
    assert.equal(idle, 1, "onIdle runs once");
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a holder that arrives between checks resets the count", async () => {
  const dir = holdersDir([]);
  let idle = 0;
  const stop = startHolderWatchdog({
    dir,
    onIdle: () => {
      idle += 1;
    },
    isAlive: () => true,
    intervalMs: 25,
    firstCheckDelayMs: 0,
  });
  try {
    await waitFor(5);
    writeFileSync(join(dir, "404.json"), JSON.stringify({ pid: 404 }));
    await waitFor(100);
    assert.equal(idle, 0);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
