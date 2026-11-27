import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { computeInstancePorts } from "../../bin/runtime-profile.mjs";

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

function writeState(pid, processStart, extra = {}) {
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
      ...extra,
    }),
    { mode: 0o600 },
  );
}

/** A start time that is "t0" while `pid` is alive, as the OS would report. */
const liveStartTime = (pid) => (isAlive(pid) ? "t0" : null);

async function listenOn(port) {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
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
    startTimeOf: liveStartTime,
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

test("stop keeps the record when it cannot read the start time", async (t) => {
  const child = spawnSleeper();
  t.after(() => child.kill());
  writeState(child.pid, "t0");
  await assert.rejects(
    stopInstance({
      inspectorDir: INSPECTOR_DIR,
      log: () => {},
      startTimeOf: () => {
        throw new Error("lookup failed");
      },
    }),
    /lookup failed/,
  );
  assert.equal(isAlive(child.pid), true);
  assert.equal(existsSync(statePath(INSPECTOR_DIR)), true);
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

test("stop keeps the record while the launcher is still running", async (t) => {
  const child = spawnSleeper();
  t.after(() => child.kill());
  writeState(child.pid, "t0");
  await assert.rejects(
    stopInstance({
      inspectorDir: INSPECTOR_DIR,
      log: () => {},
      // The OS keeps reporting the launcher, as when a kill is refused.
      startTimeOf: () => "t0",
      timeoutMs: 600,
    }),
    /still running; kept the record/,
  );
  assert.equal(existsSync(statePath(INSPECTOR_DIR)), true);
});

test("stop waits on the worker port only when the launch ran the worker", async (t) => {
  const busy = await listenOn(0);
  t.after(() => busy.close());
  const port = busy.address().port;
  const ports = { client: 1, server: 1, worker: port, debugger: 1 };
  for (const worker of [false, true]) {
    const child = spawnSleeper();
    t.after(() => child.kill());
    writeState(child.pid, "t0", { ports, worker });
    const stop = stopInstance({
      inspectorDir: INSPECTOR_DIR,
      log: () => {},
      startTimeOf: liveStartTime,
      timeoutMs: 1_000,
    });
    if (worker) {
      await assert.rejects(stop, new RegExp(`worker :${port} still in use`));
    } else {
      await stop;
    }
    assert.equal(existsSync(statePath(INSPECTOR_DIR)), false);
  }
});

test("an explicit instance whose port is taken is refused before launching", async (t) => {
  const instance = 41;
  const busy = await listenOn(computeInstancePorts(instance).client);
  t.after(() => busy.close());
  const inspectorDir = join(home, "checkout-ports");
  await assert.rejects(
    startInstance({
      inspectorDir,
      instance,
      log: () => {},
      startTimeOf: () => "t0",
    }),
    /Instance 41 has client :\d+ in use/,
  );
  assert.equal(existsSync(statePath(inspectorDir)), false);
});

test("a second start for the same checkout waits for no one and refuses", async () => {
  const inspectorDir = join(home, "checkout-lock");
  ensureDriverHome();
  const lock = statePath(inspectorDir).replace(/\.json$/, ".lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, processStart: "t0" }));
  await assert.rejects(
    startInstance({
      inspectorDir,
      instance: -1,
      log: () => {},
      startTimeOf: () => "t0",
    }),
    /already starting this checkout's instance/,
  );
  assert.equal(existsSync(lock), true);
  // A lock whose holder has gone is taken over, and released afterwards.
  await assert.rejects(
    startInstance({
      inspectorDir,
      instance: -1,
      log: () => {},
      startTimeOf: () => "t1",
    }),
    /non-negative integer/,
  );
  assert.equal(existsSync(lock), false);
});
