import { afterEach, describe, expect, it, vi } from "vitest";
import { readAheadRuntime, runtimeReadAheadCommand } from "../runtime-read-ahead.js";
import { logger } from "../../logger.js";

const enabled = { NODE_ENV: "development", MCPJAM_HARNESS_READ_AHEAD: "1" };
afterEach(() => vi.restoreAllMocks());

describe("runtime read-ahead", () => {
  it.each([{}, { NODE_ENV: "development" }, { ...enabled, NODE_ENV: "production" }])(
    "does no work outside explicit development opt-in: %j", async (env) => {
      const run = vi.fn();
      await readAheadRuntime(run, { harnessId: "codex" }, undefined, env);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it("leaves unsupported adapters and unknown identity unchanged", async () => {
    const run = vi.fn();
    for (const id of [undefined, "cursor", "unknown"]) {
      await readAheadRuntime(run, { harnessId: id }, undefined, enabled);
    }
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["claude-code", "codex", "opencode", "copilot-cli"])("skips a resumed %s session", async (harnessId) => {
    const run = vi.fn();
    await readAheadRuntime(run, { harnessId, resuming: true }, undefined, enabled);
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["codex", "copilot-cli", "opencode"])("warms a fresh %s session with a bounded timeout and no credential environment", async (harnessId) => {
    const signal = new AbortController().signal;
    const run = vi.fn().mockResolvedValue({ stdout: '{"outcome":"cached","bytes":0,"durationMs":1}' });
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    await readAheadRuntime(run, { harnessId }, signal, enabled);
    const command = runtimeReadAheadCommand(harnessId);
    expect(command?.endsWith(`'${harnessId}'`)).toBe(true);
    expect(run).toHaveBeenCalledWith(command, { signal, timeoutMs: 5000 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[harness][read-ahead] outcome=cached bytes=0"), expect.objectContaining({ outcome: "cached", bytes: 0 }));
  });
  it("falls back without leaking output when the optional hint fails", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const run = vi.fn().mockRejectedValue(new Error("private output must stay private"));
    await expect(readAheadRuntime(run, { harnessId: "claude-code" }, undefined, enabled)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ outcome: "fallback", reason: "Error" }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private output");
  });
  it("does not turn cancellation into ordinary startup", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      return { stdout: '{"outcome":"cached","bytes":0,"durationMs":1}' };
    });
    await expect(readAheadRuntime(run, { harnessId: "codex" }, controller.signal, enabled)).rejects.toThrow();
    const stopped = vi.fn();
    await expect(readAheadRuntime(stopped, { harnessId: "codex" }, controller.signal, enabled)).rejects.toThrow();
    expect(stopped).not.toHaveBeenCalled();
  });
});
