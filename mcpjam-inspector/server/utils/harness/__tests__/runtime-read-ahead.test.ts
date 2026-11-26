import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAheadRuntime, runtimeReadAheadCommand } from "../runtime-read-ahead.js";
import { logger } from "../../logger.js";

const enabled = { NODE_ENV: "development", MCPJAM_HARNESS_READ_AHEAD: "1" };
afterEach(() => vi.restoreAllMocks());

describe("runtime read-ahead", () => {
  it.each(["0", "false", " FALSE "])(
    "skips the remote command when the operator sets %j", async (setting) => {
      const run = vi.fn();
      await readAheadRuntime(run, { harnessId: "codex" }, undefined, {
        NODE_ENV: "production",
        MCPJAM_HARNESS_READ_AHEAD: setting,
      });
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
  it.each(["claude-code", "codex", "copilot-cli", "opencode"])("warms a fresh %s production session by default with a bounded timeout and no credential environment", async (harnessId) => {
    const signal = new AbortController().signal;
    const run = vi.fn().mockResolvedValue({ stdout: '{"outcome":"cached","bytes":0,"durationMs":1}' });
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    await readAheadRuntime(run, { harnessId }, signal, { NODE_ENV: "production" });
    const command = runtimeReadAheadCommand(harnessId);
    expect(command?.endsWith(`'${harnessId}'`)).toBe(true);
    expect(run).toHaveBeenCalledWith(command, { signal, timeoutMs: 5000 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[harness][read-ahead] outcome=cached bytes=0"), expect.objectContaining({ outcome: "cached", bytes: 0 }));
  });
  it("reads node before the agent's binary only when the operator orders it", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '{"outcome":"cached","bytes":0,"durationMs":1}' });
    vi.spyOn(logger, "info").mockImplementation(() => {});
    await readAheadRuntime(run, { harnessId: "claude-code" }, undefined, { MCPJAM_HARNESS_READ_AHEAD_ORDER: "node-first" });
    expect(run).toHaveBeenCalledWith(runtimeReadAheadCommand("claude-code", true), { timeoutMs: 5000 });
    expect(runtimeReadAheadCommand("claude-code", true)?.endsWith("'claude-code' node-first")).toBe(true);
    expect(runtimeReadAheadCommand("claude-code", false)?.endsWith("'claude-code'")).toBe(true);
  });
  it.runIf(process.platform === "linux" && process.arch === "x64")("still reads a whole layout in node-first order", () => {
    const root = mkdtempSync(join(tmpdir(), "read-ahead-"));
    try {
      const sdk = join(root, "claude-code/node_modules/@anthropic-ai/claude-agent-sdk");
      mkdirSync(sdk, { recursive: true });
      mkdirSync(join(sdk, "../claude-agent-sdk-linux-x64"), { recursive: true });
      writeFileSync(join(sdk, "../claude-agent-sdk-linux-x64/claude"), Buffer.alloc(64 * 1024, 1));
      const command = runtimeReadAheadCommand("claude-code", true)!;
      const script = command.slice("python3 -c '".length, command.indexOf("' '/"));
      const out = execFileSync("python3", ["-c", script.replace(/'\\''/g, "'"), root, "claude-code", "node-first"], { encoding: "utf8" });
      expect(["read", "cached"]).toContain(JSON.parse(out).outcome);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
