import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHUTDOWN_LOG_FLUSH_MS,
  SHUTDOWN_PARENT_MARGIN_MS,
  SHUTDOWN_TEARDOWN_MS,
  resolveShutdownSettings,
} from "../../bin/shutdown-settings.mjs";

test("without a drain the server keeps its five-second force-exit and one-second flush", () => {
  const settings = resolveShutdownSettings({});
  assert.equal(settings.drainMs, 0);
  assert.equal(settings.forceExitMs, 5_000);
  assert.equal(settings.logFlushMs, 1_000);
});

test("the launcher's SIGKILL lands only after the server's own exit and flush", () => {
  for (const env of [{}, { MCPJAM_SHUTDOWN_DRAIN_MS: "1800000" }]) {
    const { forceExitMs, logFlushMs, parentKillMs } =
      resolveShutdownSettings(env);
    // Strictly after: a tie lets the SIGKILL win the race and lose the
    // server's timeout log, which is what the shared timeline exists to stop.
    assert.ok(parentKillMs > forceExitMs + logFlushMs);
  }
});

test("a requested drain extends the force-exit by exactly its length", () => {
  const settings = resolveShutdownSettings({
    MCPJAM_SHUTDOWN_DRAIN_MS: "600000",
  });
  assert.equal(settings.drainMs, 600_000);
  assert.equal(settings.drainClamped, false);
  assert.equal(settings.forceExitMs, 600_000 + SHUTDOWN_TEARDOWN_MS);
});

test("a malformed or negative drain is no drain", () => {
  for (const raw of ["", "  ", "soon", "-5", "NaN"]) {
    assert.equal(
      resolveShutdownSettings({ MCPJAM_SHUTDOWN_DRAIN_MS: raw }).drainMs,
      0,
    );
  }
});

test("the drain is clamped so the whole shutdown fits the platform's SIGKILL window", () => {
  const settings = resolveShutdownSettings({
    MCPJAM_SHUTDOWN_DRAIN_MS: "1800000",
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "600",
  });
  assert.equal(settings.drainClamped, true);
  assert.equal(settings.parentKillMs, 600_000);
  assert.equal(
    settings.drainMs,
    600_000 -
      SHUTDOWN_TEARDOWN_MS -
      SHUTDOWN_LOG_FLUSH_MS -
      SHUTDOWN_PARENT_MARGIN_MS,
  );
});

test("a platform window too short for the teardown leaves no drain at all", () => {
  const settings = resolveShutdownSettings({
    MCPJAM_SHUTDOWN_DRAIN_MS: "60000",
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "3",
  });
  assert.equal(settings.drainMs, 0);
  assert.equal(settings.drainClamped, true);
});
