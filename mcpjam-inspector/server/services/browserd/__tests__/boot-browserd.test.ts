import { describe, expect, it } from "vitest";
import {
  bootBrowserd,
  DISPLAY_GEOMETRY,
  type BrowserdSandbox,
} from "../boot-browserd";

const tick = () => new Promise((r) => setTimeout(r, 0));
const READY = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify({ event: "listening", host: "0.0.0.0", port: 8791, bootId: "boot-1", ...over })}\n`;

function fakeSandbox(over: { displayUp?: boolean } = {}) {
  const state = {
    command: "",
    envs: {} as Record<string, string>,
    onStdout: (_c: string) => {},
    kills: 0,
    /** Every foreground command the boot ran, in order. */
    ran: [] as string[],
    /** Every background command, in order — Xvfb and xfce4 land here. */
    background: [] as string[],
  };
  let displayUp = over.displayUp ?? true;
  let resolveWait!: () => void;
  let rejectWait!: (e: unknown) => void;
  const waitPromise = new Promise<void>((res, rej) => {
    resolveWait = res;
    rejectWait = rej;
  });
  const sandbox: BrowserdSandbox = {
    async runBackground(command, options) {
      state.background.push(command);
      if (command.startsWith("Xvfb")) {
        // A started Xvfb is what makes the next probe answer "up".
        displayUp = true;
        return { kill: async () => true, wait: () => new Promise(() => {}) };
      }
      if (command === "startxfce4") {
        return { kill: async () => true, wait: () => new Promise(() => {}) };
      }
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
    async run(command) {
      state.ran.push(command);
      return { exitCode: displayUp ? 0 : 1 };
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

  it("gives the daemon a DISPLAY — Chromium is headed and E2B shells inherit no image ENV", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, OPTS);
    await tick();
    fake.emit(READY());
    await p;
    expect(fake.state.envs.DISPLAY).toBe(":0");
  });

  it("starts Xvfb (and xfce) when the box has no X server, then boots the daemon", async () => {
    // The hosted path only ever `connect`s to a backend-provisioned desktop,
    // and nothing in that flow runs `@e2b/desktop`'s `_start()`.
    const fake = fakeSandbox({ displayUp: false });
    const p = bootBrowserd(fake.sandbox, OPTS);
    await tick();
    fake.emit(READY());
    const handle = await p;
    expect(handle.bootId).toBe("boot-1");
    expect(fake.state.background[0]).toMatch(/^Xvfb :0 /);
    expect(fake.state.background).toContain("startxfce4");
    expect(fake.state.command).toContain("mcpjam-browserd.mjs");
  });

  it("does not start Xvfb when the display is already up", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, OPTS);
    await tick();
    fake.emit(READY());
    await p;
    expect(fake.state.background.some((c) => c.startsWith("Xvfb"))).toBe(false);
    expect(fake.state.ran[0]).toContain("xdpyinfo -display :0");
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


/**
 * V-4a. The ready line is where the inspector first learns which wire it is
 * talking to. An older baked daemon prints the pre-V-4a line, and refusing
 * that would turn a boot into a hard failure over a field nothing needs in
 * order to boot.
 */
describe("the ready line's wire version", () => {
  it("carries it through to the handle when the daemon says one", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, OPTS);
    await tick();
    fake.emit(READY({ protocolVersion: 7 }));
    expect((await p).protocolVersion).toBe(7);
  });

  it("boots a daemon that predates the field", async () => {
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, OPTS);
    await tick();
    fake.emit(READY());
    // Absent, not zero: the reuse ladder reads this as "cannot prove
    // compatibility", which relaunches.
    const handle = await p;
    expect(handle.protocolVersion).toBeUndefined();
    expect(handle.bootId).toBe("boot-1");
  });

  it("does not accept a line whose version is nonsense", async () => {
    // A field that IS there and is garbage is a daemon we do not understand.
    // Treating it as absent would let a garbled build be adopted as a
    // compatible one, so the line is not a ready line at all.
    const fake = fakeSandbox();
    const p = bootBrowserd(fake.sandbox, { ...OPTS, readyTimeoutMs: 40 });
    await tick();
    fake.emit(READY({ protocolVersion: "one" }));
    await expect(p).rejects.toThrow();
  });
});


describe("the X geometry", () => {
  it("is the one the desktop template brings the display up at", () => {
    // The template's own `geometry.json` (backend repo,
    // `templates/desktop/geometry.json`, pinned there by
    // `tests/scripts/desktopTemplateBuild.test.ts`) says the same thing. Two
    // repositories agreeing by hand is two repositories drifting silently, and
    // the drift shows up as a browser painting a page larger than the display
    // it is captured from — a picture with its right-hand edge missing, and
    // nothing in either repository to say so.
    expect(DISPLAY_GEOMETRY).toBe("1024x768x24");
  });

  it("is what the fallback Xvfb is started with", async () => {
    const fake = fakeSandbox({ displayUp: false });
    const p = bootBrowserd(fake.sandbox, OPTS);
    await vi.waitFor(() =>
      expect(
        fake.state.background.some((command) => command.startsWith("Xvfb")),
      ).toBe(true),
    );
    fake.emit(READY());
    await p;
    const xvfb = fake.state.background.find((command) =>
      command.startsWith("Xvfb"),
    );
    expect(xvfb).toContain(DISPLAY_GEOMETRY);
  });
});
