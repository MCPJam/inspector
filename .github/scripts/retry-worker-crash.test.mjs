import assert from "node:assert/strict";
import { test } from "node:test";
import { isWorkerCrashOnly, main, memoryReport } from "./retry-worker-crash.mjs";

// Excerpts of real CI output (Inspector Tests shards), colors included where
// the log had them.
const CRASH = `
 ✓  src  __tests__/electron-auth-proxy.test.ts (1 test) 75ms
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 1 unhandled error during the test run.

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
\x1b[31m\x1b[1mError\x1b[22m: [vitest-pool]: Worker forks emitted error.\x1b[39m
 ❯ EventEmitter.onTaskError ../node_modules/vitest/dist/chunks/cli-api.B0Pz1_R7.js:3526:21
 ❯ Process.ChildProcess._handle.onexit node:internal/child_process:324:12

\x1b[31m\x1b[1mCaused by: Error\x1b[22m: Worker exited unexpectedly\x1b[39m
 ❯ ChildProcess.emitUnexpectedExit ../node_modules/vitest/dist/chunks/cli-api.B0Pz1_R7.js:3090:33

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m596 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m3 skipped\x1b[39m\x1b[90m (600)\x1b[39m
\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m8884 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m29 skipped\x1b[39m\x1b[90m (8913)\x1b[39m
\x1b[2m     Errors \x1b[22m \x1b[1m\x1b[31m1 error\x1b[39m\x1b[22m
\x1b[2m   Start at \x1b[22m 03:42:49
\x1b[2m   Duration \x1b[22m 230.15s
`;

test("a crashed worker with nothing else wrong is retryable", () => {
  assert.equal(isWorkerCrashOnly(CRASH), true);
});

test("a failed test is never retryable, crash or not", () => {
  const failed = CRASH.replace("8884 passed", "1 failed\x1b[39m | 8883 passed");
  assert.equal(isWorkerCrashOnly(failed), false);
});

test("a file that failed to load is never retryable, even with every test passed", () => {
  const output = `
 FAIL   server  routes/mcp/__tests__/manual-rich-form.integration.test.ts
Error: Cannot find package '@modelcontextprotocol/server'

 Test Files  5 failed | 591 passed (596)
      Tests  8605 passed (8605)
   Start at  23:38:04
`;
  assert.equal(isWorkerCrashOnly(output), false);
  assert.equal(isWorkerCrashOnly(CRASH.replace("596 passed", "1 failed | 595 passed")), false);
});

test("another unhandled error beside the crash is not retryable", () => {
  const twoErrors = CRASH.replace("1 error", "2 errors").replace(
    "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
    "⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯\nTypeError: boom\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
  );
  assert.equal(isWorkerCrashOnly(twoErrors), false);
});

test("an unhandled error that is not a worker crash is not retryable", () => {
  const output = `
⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending

 Test Files  599 passed (599)
      Tests  8715 passed (8715)
     Errors  1 error
`;
  assert.equal(isWorkerCrashOnly(output), false);
});

test("output with no Vitest summary is not retryable", () => {
  assert.equal(isWorkerCrashOnly("Error: Worker exited unexpectedly\n"), false);
  assert.equal(isWorkerCrashOnly(""), false);
});

test("the memory report reads the cgroup and says when it cannot", () => {
  const files = {
    "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 1\noom_kill 1\n",
    "/sys/fs/cgroup/memory.peak": String(15 * 2 ** 30),
  };
  const read = (path) => {
    if (!(path in files)) throw new Error("ENOENT");
    return files[path];
  };
  assert.equal(memoryReport(read), "oom_kill=1, memory.peak=15360 MiB");
  assert.equal(
    memoryReport(() => {
      throw new Error("ENOENT");
    }),
    "memory.events unreadable, memory.peak unreadable",
  );
});

test("a passing command runs once and a failing one keeps its exit code", async () => {
  assert.equal(await main([process.execPath, "-e", "process.exit(0)"]), 0);
  assert.equal(await main([process.execPath, "-e", "process.exit(3)"]), 3);
});

test("a crash-only run is rerun exactly once", async () => {
  const script = `
    const fs = require("node:fs");
    const counter = process.argv[1];
    const runs = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0) + 1;
    fs.writeFileSync(counter, String(runs));
    process.stdout.write(${JSON.stringify(CRASH)});
    process.exit(1);
  `;
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const counter = join(mkdtempSync(join(tmpdir(), "retry-worker-crash-")), "runs");
  assert.equal(await main([process.execPath, "-e", script, counter]), 1);
  assert.equal(readFileSync(counter, "utf8"), "2");
});
