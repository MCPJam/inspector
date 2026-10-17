import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHUTDOWN_LOG_FLUSH_MS,
  SHUTDOWN_TEARDOWN_MS,
  resolveShutdownSettings,
} from "../../bin/shutdown-settings.mjs";

test("the server keeps its five-second force-exit and one-second flush", () => {
  const settings = resolveShutdownSettings();
  assert.equal(settings.forceExitMs, SHUTDOWN_TEARDOWN_MS);
  assert.equal(settings.forceExitMs, 5_000);
  assert.equal(settings.logFlushMs, SHUTDOWN_LOG_FLUSH_MS);
  assert.equal(settings.logFlushMs, 1_000);
});

test("the launcher's SIGKILL lands only after the server's own exit and flush", () => {
  const { forceExitMs, logFlushMs, parentKillMs } = resolveShutdownSettings();
  // Strictly after: a tie lets the SIGKILL win the race and lose the
  // server's timeout log, which is what the shared timeline exists to stop.
  assert.ok(parentKillMs > forceExitMs + logFlushMs);
});
