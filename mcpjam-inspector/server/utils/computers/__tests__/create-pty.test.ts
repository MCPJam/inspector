import { describe, expect, it, vi } from "vitest";
import {
  createPtyWithCwd,
  sanitizeTerminalCwd,
  type PtyBaseOpts,
} from "../create-pty.js";

const baseOpts: PtyBaseOpts = {
  cols: 80,
  rows: 24,
  timeoutMs: 1000,
  onData: () => {},
};

function fakeSandbox(create: (opts: PtyBaseOpts & { cwd?: string }) => Promise<string>) {
  return { pty: { create: vi.fn(create) } };
}

describe("createPtyWithCwd", () => {
  it("creates the PTY with the cwd when provided", async () => {
    const sandbox = fakeSandbox(async () => "handle");
    const handle = await createPtyWithCwd(sandbox, baseOpts, "/home/user/wd");
    expect(handle).toBe("handle");
    expect(sandbox.pty.create).toHaveBeenCalledTimes(1);
    expect(sandbox.pty.create).toHaveBeenCalledWith({
      ...baseOpts,
      cwd: "/home/user/wd",
    });
  });

  it("creates without cwd when none is given", async () => {
    const sandbox = fakeSandbox(async () => "handle");
    await createPtyWithCwd(sandbox, baseOpts, undefined);
    expect(sandbox.pty.create).toHaveBeenCalledTimes(1);
    expect(sandbox.pty.create).toHaveBeenCalledWith(baseOpts);
  });

  it("retries once WITHOUT cwd when the cwd attempt rejects", async () => {
    let call = 0;
    const sandbox = fakeSandbox(async (opts) => {
      call += 1;
      if (call === 1) {
        expect(opts.cwd).toBe("/stale/dir");
        throw new Error("chdir failed");
      }
      expect(opts.cwd).toBeUndefined();
      return "fallback-handle";
    });
    const handle = await createPtyWithCwd(sandbox, baseOpts, "/stale/dir");
    expect(handle).toBe("fallback-handle");
    expect(sandbox.pty.create).toHaveBeenCalledTimes(2);
  });
});

describe("sanitizeTerminalCwd", () => {
  it("accepts an absolute, bounded path", () => {
    expect(sanitizeTerminalCwd("/home/user/claude-code-1")).toBe(
      "/home/user/claude-code-1",
    );
  });

  it("rejects relative, empty, or over-long paths", () => {
    expect(sanitizeTerminalCwd(undefined)).toBeUndefined();
    expect(sanitizeTerminalCwd("")).toBeUndefined();
    expect(sanitizeTerminalCwd("relative/path")).toBeUndefined();
    expect(sanitizeTerminalCwd("/" + "a".repeat(2000))).toBeUndefined();
  });
});
