import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { patchWarmBridgeExpiry } from "../warm-bridge-files.js";
import { WARM_BRIDGE_WINDOW_MS } from "../warm-bridge.js";

async function watchdog(hosted = true, marker?: string) {
  let now = 1000;
  let state = "waiting";
  let unreadable = false;
  let tick: (() => void) | undefined;
  const exit = vi.fn();
  // Replace only the filesystem import; execute the emitted timer/identity code.
  const source = patchWarmBridgeExpiry("").replace(
    'await import("node:fs")',
    "globalThis.fixtureFs",
  );
  vm.runInNewContext(source, {
    process: {
      pid: 42,
      argv: ["node", "bridge.mjs", "--bridge-state-dir", "/bridge"],
      env: hosted ? { MCPJAM_HOSTED_BRIDGE: "1" } : {},
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
  await Promise.resolve();
  return {
    exit,
    run: () => tick?.(),
    advance: (ms: number) => {
      now += ms;
    },
    state: (next: string) => {
      state = next;
    },
    unreadable: () => {
      unreadable = true;
    },
    armed: () => tick !== undefined,
  };
}

describe("bridge expiry watchdog", () => {
  it("does not install a hosted timer in local runtimes", async () => {
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
    const once = patchWarmBridgeExpiry("");
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
