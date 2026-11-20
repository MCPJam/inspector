import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

// DRIVER_HOME is read from the home directory at import, so point it at a
// scratch directory before the module loads.
const home = mkdtempSync(join(tmpdir(), "driver-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
after(() => rmSync(home, { recursive: true, force: true }));
const {
  ensureDriverHome,
  isAlive,
  processStartTime,
  startInstance,
  statePath,
  stopInstance,
} = await import("../lib/inspector-driver-instance.mjs");

const INSPECTOR_DIR = join(home, "checkout");

function spawnSleeper() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    detached: true,
    stdio: "ignore",
  });
}

function writeState(pid, processStart) {
  ensureDriverHome();
  writeFileSync(
    statePath(INSPECTOR_DIR),
    JSON.stringify({
      pid,
      processStart,
      instance: 0,
      // Port 1 is never listened on, so the port wait ends at once.
      ports: { client: 1, server: 1 },
      baseUrl: "http://localhost:1",
      token: "t",
    }),
    { mode: 0o600 },
  );
}

test("the OS start time names one live process and nothing once it exits", async () => {
  const first = processStartTime(process.pid);
  assert.ok(first);
  assert.equal(processStartTime(process.pid), first);
  const child = spawnSleeper();
  child.kill();
  await once(child, "exit");
  assert.equal(processStartTime(child.pid), null);
});

test("stop kills the recorded process when its start time matches", async () => {
  const child = spawnSleeper();
  writeState(child.pid, "t0");
  const exited = once(child, "exit");
  await stopInstance({
    inspectorDir: INSPECTOR_DIR,
    log: () => {},
    startTimeOf: () => "t0",
  });
  await exited;
  assert.equal(existsSync(statePath(INSPECTOR_DIR)), false);
});

test("stop leaves a reused pid alone and clears the stale record", async (t) => {
  const child = spawnSleeper();
  t.after(() => child.kill());
  writeState(child.pid, "t0");
  const lines = [];
  await stopInstance({
    inspectorDir: INSPECTOR_DIR,
    log: (line) => lines.push(line),
    startTimeOf: () => "t1",
  });
  assert.equal(isAlive(child.pid), true);
  assert.equal(existsSync(statePath(INSPECTOR_DIR)), false);
  assert.match(lines.join("\n"), /cleared the record without stopping/);
});

test("start refuses while the recorded launcher is still running", async () => {
  writeState(process.pid, "t0");
  await assert.rejects(
    startInstance({
      inspectorDir: INSPECTOR_DIR,
      instance: 0,
      log: () => {},
      startTimeOf: () => "t0",
    }),
    /already has a driver instance/,
  );
  assert.equal(existsSync(statePath(INSPECTOR_DIR)), true);
});

test("start clears a stale record and carries on", async () => {
  writeState(process.pid, "t0");
  const lines = [];
  // An invalid instance stops the launch at its first step after the check.
  await assert.rejects(
    startInstance({
      inspectorDir: INSPECTOR_DIR,
      instance: -1,
      log: (line) => lines.push(line),
      startTimeOf: () => "t1",
    }),
    /non-negative integer/,
  );
  assert.equal(existsSync(statePath(INSPECTOR_DIR)), false);
  assert.match(lines.join("\n"), /cleared the record/);
});
