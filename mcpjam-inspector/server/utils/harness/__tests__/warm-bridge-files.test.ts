import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { patchWarmBridgeExpiry, warmBridgeCommand } from "../warm-bridge-files.js";
import { WARM_BRIDGE_WINDOW_ENV } from "../warm-bridge.js";

/** The box's idle window, as the backend sends it. */
const WARM_BRIDGE_WINDOW_MS = 5 * 60_000;

const lifecycleFixture = `const writeBridgeMeta = async (state) => {};
globalThis.lifecycle = writeBridgeMeta; void writeBridgeMeta("waiting");`;

it.skipIf(process.platform !== "linux")("parks and verifies the real process under HOME with an encoded session id", () => {
  const root = mkdtempSync(join(tmpdir(), "warm-private-home-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const directory = join(home, ".ai-sdk-harness/.agent-runs/..%2Fshared%2Fsession/bridge");
  try {
    mkdirSync(workspace);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "bridge-meta.json"), JSON.stringify({
      pid: process.pid, port: 8080, state: "waiting",
    }));
    const args = { sessionId: "../shared/session", configuration: "configuration", token: "private-channel-token", port: 8080 };
    const run = (park: boolean, token = args.token, windowMs = WARM_BRIDGE_WINDOW_MS) => spawnSync("sh", ["-c", warmBridgeCommand({
      ...args, token, park, includeHome: !park, windowMs,
    })], { cwd: workspace, env: { ...process.env, HOME: home }, encoding: "utf8" });
    const parked = run(true);
    expect(parked.status, parked.stderr).toBe(0);
    expect(readFileSync(join(directory, "mcpjam-warm.json"), "utf8")).not.toContain(args.token);
    const attached = run(false);
    expect(attached.status, attached.stderr).toBe(0);
    expect(JSON.parse(attached.stdout)).toEqual({ ready: true, home });
    expect(run(false, "another-channel-token").status).toBe(1);
    // A window shorter than the one it was parked for: no longer reusable.
    expect(run(false, args.token, 60_000).status).toBe(1);
    // No window at all: refused rather than guessed.
    expect(run(false, args.token, 0).status).toBe(1);
    expect(existsSync(join(workspace, ".agent-runs"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function watchdog(
  hasStateDirectory = true,
  marker?: string,
  windowMs: number | null = WARM_BRIDGE_WINDOW_MS,
) {
  let now = 1000;
  let state = "waiting";
  let unreadable = false;
  let tick: (() => void) | undefined;
  const exit = vi.fn();
  // Replace only the filesystem import; execute the emitted timer/identity code.
  const source = patchWarmBridgeExpiry(lifecycleFixture).replace(
    'await import("node:fs")',
    "globalThis.fixtureFs",
  );
  const context = vm.createContext({
    process: {
      pid: 42,
      argv: hasStateDirectory
        ? ["node", "bridge.mjs", "--bridge-state-dir", "/bridge"]
        : ["node", "bridge.mjs"],
      env:
        windowMs === null
          ? {}
          : { [WARM_BRIDGE_WINDOW_ENV]: String(windowMs) },
      exit,
    },
    Date: { now: () => now },
    fixtureFs: {
      readFileSync: (path: string) => {
        if (path.endsWith("mcpjam-warm.json") && marker !== undefined)
          return marker;
        if (unreadable) throw new Error("unreadable");
        return JSON.stringify({ pid: 42, state });
      },
      existsSync: () => marker !== undefined,
    },
    setInterval: (callback: () => void) => {
      tick = callback;
      return { unref() {} };
    },
  });
  vm.runInContext(source, context);
  await Promise.resolve();
  return {
    exit,
    run: () => tick?.(),
    advance: (ms: number) => {
      now += ms;
    },
    state: (next: string) => {
      state = next;
      context.lifecycle(next);
    },
    unreadable: () => {
      unreadable = true;
    },
    armed: () => tick !== undefined,
  };
}

describe("bridge expiry watchdog", () => {
  it("only installs a timer for an instrumented bridge with a state directory", async () => {
    expect((await watchdog(false)).armed()).toBe(false);
  });

  it("exits an idle bridge after its warm window without requiring a new turn", async () => {
    const w = await watchdog();
    w.advance(WARM_BRIDGE_WINDOW_MS - 1);
    w.run();
    expect(w.exit).not.toHaveBeenCalled();
    w.advance(1);
    w.run();
    expect(w.exit).toHaveBeenCalledWith(0);
  });

  it("preserves active and approval-paused turns and starts a new idle window afterward", async () => {
    const w = await watchdog();
    w.state("running");
    w.advance(WARM_BRIDGE_WINDOW_MS * 2);
    w.run();
    expect(w.exit).not.toHaveBeenCalled();
    w.state("waiting");
    w.run();
    expect(w.exit).not.toHaveBeenCalled();
    w.advance(WARM_BRIDGE_WINDOW_MS);
    w.run();
    expect(w.exit).toHaveBeenCalledWith(0);
  });

  it("does not kill a process whose lifecycle state cannot be established", async () => {
    const w = await watchdog();
    w.advance(WARM_BRIDGE_WINDOW_MS * 2);
    w.unreadable();
    w.run();
    expect(w.exit).not.toHaveBeenCalled();
  });

  it("never reaps itself when it was started without a window", async () => {
    expect((await watchdog(true, undefined, null)).armed()).toBe(false);
  });

  it("reads its window at run time, so the patched source does not carry it", () => {
    const source = patchWarmBridgeExpiry(lifecycleFixture);
    expect(source).toContain(`process.env.${WARM_BRIDGE_WINDOW_ENV}`);
    expect(source).not.toContain(String(WARM_BRIDGE_WINDOW_MS));
  });

  it("patches a recipe only once", () => {
    const once = patchWarmBridgeExpiry(lifecycleFixture);
    expect(patchWarmBridgeExpiry(once)).toBe(once);
  });

  it.each([
    "{",
    JSON.stringify({ pid: 7, expiresAt: 999999999 }),
    JSON.stringify({ pid: 42, expiresAt: 999999999 }),
  ])(
    "expires a replacement even when its old marker is invalid: %s",
    async (marker) => {
      const w = await watchdog(true, marker);
      w.advance(WARM_BRIDGE_WINDOW_MS);
      w.run();
      expect(w.exit).toHaveBeenCalledWith(0);
    },
  );
});

it("keeps a bridge kept through its box's pause until the ceiling, then exits", async () => {
  // The fixture's clock reads 1000 when the bridge starts waiting.
  const ceiling = 1000 + 4 * 60 * 60_000;
  const w = await watchdog(
    true,
    JSON.stringify({ pid: 42, expiresAt: ceiling }),
    ceiling - 1000,
  );
  // Its box pauses at the idle deadline and wakes an hour later.
  for (const step of [WARM_BRIDGE_WINDOW_MS, 60 * 60_000]) {
    w.advance(step);
    w.run();
    expect(w.exit).not.toHaveBeenCalled();
  }
  w.advance(ceiling - 1000 - WARM_BRIDGE_WINDOW_MS - 60 * 60_000 - 1);
  w.run();
  expect(w.exit).not.toHaveBeenCalled();
  w.advance(1);
  w.run();
  expect(w.exit).toHaveBeenCalledWith(0);
});

/** A parked bridge's state under a private HOME, its meta naming this process. */
function keptBridge() {
  const root = mkdtempSync(join(tmpdir(), "warm-kept-home-"));
  const home = join(root, "home");
  const directory = join(home, ".ai-sdk-harness/.agent-runs/session/bridge");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "bridge-meta.json"),
    JSON.stringify({
      pid: process.pid,
      port: 8080,
      state: "waiting",
    }),
  );
  const marker = join(directory, "mcpjam-warm.json");
  const run = (options: {
    park: boolean;
    retainUntil?: number;
    spawned?: boolean;
    configuration?: string;
  }) =>
    spawnSync(
      "sh",
      [
        "-c",
        warmBridgeCommand({
          sessionId: "session",
          configuration: "configuration",
          token: "private-channel-token",
          port: 8080,
          windowMs: WARM_BRIDGE_WINDOW_MS,
          includeHome: !options.park,
          ...options,
        }),
      ],
      { cwd: root, env: { ...process.env, HOME: home }, encoding: "utf8" },
    ).status;
  return {
    run,
    read: () =>
      JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>,
    write: (saved: Record<string, unknown>) =>
      writeFileSync(marker, JSON.stringify(saved)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe.skipIf(process.platform !== "linux")(
  "a bridge kept through its box's pause",
  () => {
    const HOUR = 60 * 60_000;

    it("parks to the box's ceiling and re-attaches after a wake while nothing changed", () => {
      const bridge = keptBridge();
      try {
        const ceiling = Date.now() + 4 * HOUR;
        expect(
          bridge.run({ park: true, retainUntil: ceiling, spawned: true }),
        ).toBe(0);
        expect(bridge.read().expiresAt).toBe(ceiling);
        // The wake restarted the box's ceiling later than the one it parked for.
        expect(bridge.run({ park: false, retainUntil: ceiling + HOUR })).toBe(
          0,
        );
        // The process keeps the window it was started with, so its marker does too.
        expect(
          bridge.run({
            park: true,
            retainUntil: ceiling + HOUR,
            spawned: false,
          }),
        ).toBe(0);
        expect(bridge.read().expiresAt).toBe(ceiling);
      } finally {
        bridge.cleanup();
      }
    });

    it("resumes from saved files once process identity, configuration or expiry fails", () => {
      const bridge = keptBridge();
      try {
        const ceiling = Date.now() + 4 * HOUR;
        expect(
          bridge.run({ park: true, retainUntil: ceiling, spawned: true }),
        ).toBe(0);
        const parked = bridge.read();
        expect(
          bridge.run({
            park: false,
            retainUntil: ceiling,
            configuration: "changed",
          }),
        ).toBe(1);
        for (const replaced of [
          { pid: process.pid + 1 },
          { birthIdentity: "0" },
        ]) {
          bridge.write({ ...parked, ...replaced });
          expect(bridge.run({ park: false, retainUntil: ceiling })).toBe(1);
        }
        // Woken after the ceiling it was parked for: the clock passed its expiry.
        bridge.write({ ...parked, expiresAt: Date.now() - 1 });
        expect(bridge.run({ park: false, retainUntil: ceiling + HOUR })).toBe(
          1,
        );
      } finally {
        bridge.cleanup();
      }
    });

    it("keeps the idle window with the switch off, refusing a bridge parked to the ceiling", () => {
      const bridge = keptBridge();
      try {
        expect(
          bridge.run({
            park: true,
            retainUntil: Date.now() + 4 * HOUR,
            spawned: true,
          }),
        ).toBe(0);
        expect(bridge.run({ park: false })).toBe(1);
        expect(bridge.run({ park: true })).toBe(0);
        expect(bridge.read().expiresAt).toBeLessThanOrEqual(
          Date.now() + WARM_BRIDGE_WINDOW_MS,
        );
        expect(bridge.run({ park: false })).toBe(0);
      } finally {
        bridge.cleanup();
      }
    });

    it("never parks a process started with the idle window to the ceiling", () => {
      const bridge = keptBridge();
      try {
        expect(bridge.run({ park: true })).toBe(0);
        const ceiling = Date.now() + 4 * HOUR;
        expect(bridge.run({ park: false, retainUntil: ceiling })).toBe(0);
        expect(
          bridge.run({ park: true, retainUntil: ceiling, spawned: false }),
        ).toBe(0);
        expect(bridge.read().expiresAt).toBeLessThanOrEqual(
          Date.now() + WARM_BRIDGE_WINDOW_MS,
        );
      } finally {
        bridge.cleanup();
      }
    });
  },
);

it("starts the whole idle window after a message shorter than one watchdog tick", async () => {
  const w = await watchdog();
  w.state("running"); w.advance(3200); w.state("waiting");
  w.advance(WARM_BRIDGE_WINDOW_MS - 1);
  w.run();
  expect(w.exit).not.toHaveBeenCalled();
  w.advance(1); w.run();
  expect(w.exit).toHaveBeenCalledWith(0);
});
