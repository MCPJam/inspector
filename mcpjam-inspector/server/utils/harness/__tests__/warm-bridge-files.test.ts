import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { patchWarmBridgeExpiry, warmBridgeCommand } from "../warm-bridge-files.js";
import { WARM_BRIDGE_WINDOW_MS } from "../warm-bridge.js";

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
    const run = (park: boolean, token = args.token) => spawnSync("sh", ["-c", warmBridgeCommand({
      ...args, token, park, includeHome: !park,
    })], { cwd: workspace, env: { ...process.env, HOME: home }, encoding: "utf8" });
    const parked = run(true);
    expect(parked.status, parked.stderr).toBe(0);
    expect(readFileSync(join(directory, "mcpjam-warm.json"), "utf8")).not.toContain(args.token);
    const attached = run(false);
    expect(attached.status, attached.stderr).toBe(0);
    expect(JSON.parse(attached.stdout)).toEqual({ ready: true, home });
    expect(run(false, "another-channel-token").status).toBe(1);
    expect(existsSync(join(workspace, ".agent-runs"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function watchdog(hasStateDirectory = true, marker?: string) {
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

it("starts the whole idle window after a message shorter than one watchdog tick", async () => {
  const w = await watchdog();
  w.state("running"); w.advance(3200); w.state("waiting");
  w.advance(WARM_BRIDGE_WINDOW_MS - 1);
  w.run();
  expect(w.exit).not.toHaveBeenCalled();
  w.advance(1); w.run();
  expect(w.exit).toHaveBeenCalledWith(0);
});
