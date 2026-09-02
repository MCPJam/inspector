import { describe, expect, it } from "vitest";
import { bootBrowserd, type BrowserdSandbox } from "../boot-browserd";

const tick = () => new Promise((r) => setTimeout(r, 0));
const READY = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify({ event: "listening", host: "0.0.0.0", port: 8791, bootId: "boot-1", ...over })}\n`;

function fakeSandbox() {
  const state = {
    command: "",
    envs: {} as Record<string, string>,
    onStdout: (_c: string) => {},
    kills: 0,
  };
  let resolveWait!: () => void;
  let rejectWait!: (e: unknown) => void;
  const waitPromise = new Promise<void>((res, rej) => {
    resolveWait = res;
    rejectWait = rej;
  });
  const sandbox: BrowserdSandbox = {
    async runBackground(command, options) {
      state.command = command;
      state.envs = options.envs;
      state.onStdout = options.onStdout;
      return {
        kill: async () => {
          state.kills++;
          return true;
        },
        wait: () => waitPromise,
      };
    },
    getHost: (port) => `box-${port}.e2b.dev`,
  };
  return {
    sandbox,
    state,
    emit: (chunk: string) => state.onStdout(chunk),
    exit: () => resolveWait(),
    exitWith: (e: Error) => rejectWait(e),
  };
}

const OPTS = {
  scriptPath: "/opt/mcpjam/mcpjam-browserd.mjs",
  port: 8791,
  userDataDir: "/home/user/.mcpjam-browserd",
};

describe("bootBrowserd", () => {
  it("resolves with the bearer, bootId, and public origin once browserd reports listening", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, OPTS);
    await tick();
    fake.emit(READY());
    const handle = await p;
    expect(handle.bearer).toMatch(/^[0-9a-f]{64}$/); // a real per-boot secret
    expect(handle.bootId).toBe("boot-1");
    expect(handle.port).toBe(8791);
    expect(handle.publicOrigin).toBe("https://box-8791.e2b.dev");
  });

  it("passes the token in envs, NEVER on the command line", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, {
      ...OPTS,
      windowSize: "1600,1200",
      headless: true,
    });
    await tick();
    fake.emit(READY());
    const handle = await p;
    expect(fake.state.command).toBe('node "/opt/mcpjam/mcpjam-browserd.mjs"');
    expect(fake.state.command).not.toContain(handle.bearer);
    expect(fake.state.envs).toMatchObject({
      MCPJAM_BROWSERD_TOKEN: handle.bearer,
      MCPJAM_BROWSERD_PORT: "8791",
      MCPJAM_BROWSERD_USER_DATA_DIR: "/home/user/.mcpjam-browserd",
      MCPJAM_BROWSERD_WINDOW_SIZE: "1600,1200",
      MCPJAM_BROWSERD_HEADLESS: "true",
    });
  });

  it("omits the optional envs when not configured", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, OPTS);
    await tick();
    fake.emit(READY());
    await p;
    expect(fake.state.envs.MCPJAM_BROWSERD_WINDOW_SIZE).toBeUndefined();
    expect(fake.state.envs.MCPJAM_BROWSERD_HEADLESS).toBeUndefined();
  });

  it("reassembles a ready line split across chunks and ignores noise before it", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, OPTS);
    await tick();
    fake.emit("starting up...\n");
    const line = READY({ bootId: "boot-9" });
    fake.emit(line.slice(0, 20));
    fake.emit(line.slice(20));
    const handle = await p;
    expect(handle.bootId).toBe("boot-9");
  });

  it("rejects and reaps the process if browserd exits before listening", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, OPTS);
    await tick();
    fake.exit(); // the daemon process ended without a ready line
    await expect(p).rejects.toThrow(/exited before it reported listening/);
    expect(fake.state.kills).toBeGreaterThanOrEqual(1);
  });

  it("rejects if browserd does not report listening within the deadline", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, { ...OPTS, readyTimeoutMs: 20 });
    await expect(p).rejects.toThrow(/within 20ms/);
  });

  it("stop() reaps the daemon", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, OPTS);
    await tick();
    fake.emit(READY());
    const handle = await p;
    await handle.stop();
    expect(fake.state.kills).toBe(1);
  });
});
