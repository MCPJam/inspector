/**
 * The E2B side of plugin colocation, against a stubbed vendor SDK.
 *
 * The property under test is the one the rest of the pipeline cannot enforce:
 * this module starts a process with NO vendor timeout inside the user's DURABLE
 * computer, so it is the only place that can guarantee an unsuccessful start
 * leaves nothing listening. A leaked shim would be exactly the unrecorded
 * runtime `computer-stdio.ts` refuses to admit — and every retry would add
 * another one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();
const getHostMock = vi.fn((port: number) => `${port}-sbx.e2b.app`);
const connectMock = vi.fn(async () => ({
  commands: { run: runMock },
  files: { write: vi.fn(), makeDir: vi.fn() },
  getHost: getHostMock,
}));

vi.mock("e2b", () => ({
  Sandbox: { connect: (...args: unknown[]) => connectMock(...(args as [])) },
  CommandExitError: class CommandExitError extends Error {
    exitCode = 2;
    stdout = "";
    stderr = "";
  },
}));

const BOX = {
  kind: "computer" as const,
  computerId: "computer-1",
  sandboxId: "sbx",
};

/** A vendor command handle whose kill is observable. */
function makeCommandHandle() {
  const kill = vi.fn(async () => true);
  // Never settles on its own: the shim is a long-lived server, so `wait()`
  // pending is the normal case and the ready line is what ends the start.
  return { kill, wait: () => new Promise<never>(() => {}) };
}

describe("e2bPluginBoxConnector — startShim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHostMock.mockImplementation((port: number) => `${port}-sbx.e2b.app`);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves on the ready line and hands back a stop that reaps the process", async () => {
    const { e2bPluginBoxConnector } = await import("../plugin-box.js");
    const command = makeCommandHandle();
    runMock.mockImplementation(async (_cmd: string, opts: any) => {
      // The shim writes exactly one JSON line once it is listening.
      opts.onStdout('{"event":"listening","host":"0.0.0.0","port":41234}\n');
      return command;
    });

    const handle = await e2bPluginBoxConnector(BOX);
    const started = await handle.startShim({
      scriptPath: "/home/user/.mcpjam/shim/shim.mjs",
      env: { MCPJAM_SHIM_PORT: "0" },
      readyTimeoutMs: 5_000,
    });

    expect(started.port).toBe(41234);
    expect(command.kill).not.toHaveBeenCalled();
    await started.stop();
    expect(command.kill).toHaveBeenCalledTimes(1);
  });

  it("kills the shim when it never reports listening", async () => {
    const { e2bPluginBoxConnector } = await import("../plugin-box.js");
    const command = makeCommandHandle();
    runMock.mockImplementation(async () => command);

    const handle = await e2bPluginBoxConnector(BOX);
    await expect(
      handle.startShim({
        scriptPath: "/home/user/.mcpjam/shim/shim.mjs",
        env: {},
        readyTimeoutMs: 20,
      })
    ).rejects.toThrow(/did not report listening/);

    // Nothing else would ever reap it: the command runs with no vendor timeout.
    await vi.waitFor(() => expect(command.kill).toHaveBeenCalledTimes(1));
  });

  it("kills a handle that arrives after the deadline already fired", async () => {
    const { e2bPluginBoxConnector } = await import("../plugin-box.js");
    const command = makeCommandHandle();
    // The vendor start is still in flight when the ready deadline expires, so
    // the rejection path had no handle to kill. It must be reaped on arrival
    // instead of leaking.
    runMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(command), 60))
    );

    const handle = await e2bPluginBoxConnector(BOX);
    await expect(
      handle.startShim({
        scriptPath: "/home/user/.mcpjam/shim/shim.mjs",
        env: {},
        readyTimeoutMs: 10,
      })
    ).rejects.toThrow(/did not report listening/);

    await vi.waitFor(() => expect(command.kill).toHaveBeenCalledTimes(1));
  });

  it("keeps the shim bearer out of the command line", async () => {
    const { e2bPluginBoxConnector } = await import("../plugin-box.js");
    const command = makeCommandHandle();
    runMock.mockImplementation(async (_cmd: string, opts: any) => {
      opts.onStdout('{"event":"listening","host":"0.0.0.0","port":41234}\n');
      return command;
    });

    const handle = await e2bPluginBoxConnector(BOX);
    await handle.startShim({
      scriptPath: "/home/user/.mcpjam/shim/shim.mjs",
      env: { MCPJAM_SHIM_TOKEN: "s".repeat(43) },
      readyTimeoutMs: 5_000,
    });

    const [commandLine, opts] = runMock.mock.calls[0];
    // argv is visible to every process in the box and to the vendor's log.
    expect(commandLine).not.toContain("s".repeat(43));
    expect(opts.envs.MCPJAM_SHIM_TOKEN).toBe("s".repeat(43));
    // A long-lived server must not be reaped by the vendor's 60s default.
    expect(opts.timeoutMs).toBe(0);
  });

  it("reassembles a ready line split across stdout chunks", async () => {
    const { e2bPluginBoxConnector } = await import("../plugin-box.js");
    const command = makeCommandHandle();
    runMock.mockImplementation(async (_cmd: string, opts: any) => {
      opts.onStdout('{"event":"listening","ho');
      opts.onStdout('st":"0.0.0.0","port":41999}\n');
      return command;
    });

    const handle = await e2bPluginBoxConnector(BOX);
    const started = await handle.startShim({
      scriptPath: "/home/user/.mcpjam/shim/shim.mjs",
      env: {},
      readyTimeoutMs: 5_000,
    });

    expect(started.port).toBe(41999);
  });
});
