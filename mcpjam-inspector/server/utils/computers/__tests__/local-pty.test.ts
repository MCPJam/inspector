import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * node-pty is an OPTIONAL native dependency: an npx install with no build
 * toolchain, the packaged Electron app (no node_modules at all), and an ABI
 * mismatch all leave it absent. None of those may throw — they must degrade to
 * "terminal unavailable", with chat bash still working. That degrade IS the
 * contract these tests pin.
 */

const engineState = vi.hoisted(() => ({
  availability: { available: true } as
    | { available: true }
    | { available: false; reason: string },
}));

vi.mock("../local-machine.js", () => ({
  isLocalComputerEngineAvailable: () => engineState.availability,
}));

import {
  getLocalTerminalAvailability,
  loadLocalPtyModule,
  resetLocalPtyCachesForTests,
  setLocalPtyModuleForTests,
} from "../local-pty.js";

beforeEach(() => {
  engineState.availability = { available: true };
  resetLocalPtyCachesForTests();
});

afterEach(() => {
  resetLocalPtyCachesForTests();
});

describe("loadLocalPtyModule", () => {
  it("reports a clean failure when node-pty cannot be required (never throws)", async () => {
    // node-pty is not installed in CI, so this exercises the REAL import path.
    const loaded = await loadLocalPtyModule();
    if (loaded.ok) {
      expect(typeof loaded.pty.spawn).toBe("function");
    } else {
      expect(loaded.reason).toBe("node-pty is not available on this server");
    }
  });

  it("memoizes the answer — resolution is not re-attempted per connection", async () => {
    const first = await loadLocalPtyModule();
    const second = await loadLocalPtyModule();
    expect(second).toBe(first);
  });
});

describe("getLocalTerminalAvailability", () => {
  it("is unavailable — with the ENGINE's reason — whenever the engine is off", async () => {
    engineState.availability = {
      available: false,
      reason: "hosted servers never execute locally",
    };
    // Even with a perfectly good node-pty: a terminal on a machine that may not
    // execute bash would be a second, ungated execution path.
    setLocalPtyModuleForTests({ spawn: (() => {}) as never });

    await expect(getLocalTerminalAvailability()).resolves.toEqual({
      available: false,
      reason: "hosted servers never execute locally",
    });
  });

  it("is available when the engine is on and node-pty loads", async () => {
    setLocalPtyModuleForTests({ spawn: (() => {}) as never });
    await expect(getLocalTerminalAvailability()).resolves.toEqual({
      available: true,
    });
  });

  it("degrades with node-pty's reason when the module is missing", async () => {
    setLocalPtyModuleForTests(null);
    await expect(getLocalTerminalAvailability()).resolves.toEqual({
      available: false,
      reason: "node-pty is not available on this server",
    });
  });

  it("caches the probe for the process lifetime", async () => {
    setLocalPtyModuleForTests(null);
    const first = await getLocalTerminalAvailability();
    // Flipping the engine after the probe must NOT change the cached answer —
    // the config route calls this on every SPA boot and it cannot change
    // without a restart.
    engineState.availability = { available: true };
    expect(await getLocalTerminalAvailability()).toEqual(first);
  });
});
