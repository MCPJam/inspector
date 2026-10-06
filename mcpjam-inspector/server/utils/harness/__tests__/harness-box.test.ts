import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { releaseSandboxMock, dataPlaneConfiguredMock } = vi.hoisted(() => ({
  releaseSandboxMock: vi.fn(async () => {}),
  dataPlaneConfiguredMock: vi.fn(() => true),
}));

vi.mock("../../computers/control-plane-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../computers/control-plane-client.js")
  >("../../computers/control-plane-client.js");
  return {
    ...actual,
    isComputersDataPlaneConfigured: () => dataPlaneConfiguredMock(),
    releaseSandbox: (...args: unknown[]) => releaseSandboxMock(...(args as [])),
  };
});

import {
  acquireHarnessBox,
  HARNESS_BOX_SCOPES,
  harnessBoxHeartbeatIntervalMs,
  harnessBoxUnavailableReason,
  type HarnessBoxSurface,
} from "../harness-box.js";
import type { TouchSandboxOutcome } from "../../computers/control-plane-client.js";

const MINUTE = 60_000;

/**
 * The control plane's view of one box, as far as the reaper cares: the row's
 * `lastUsedAt`, restarted by every touch, and the scope's idle TTL. The
 * backend twin of this test (`ephemeralSandboxLiveness.test.ts`) pins the same
 * rule against the real route and the real reap claim.
 */
function fakeControlPlane(ttlMs: number) {
  let lastUsedAt = Date.now();
  let gone = false;
  const touch = vi.fn(
    async (args: {
      sandboxRowId: string;
      sandboxId: string;
    }): Promise<TouchSandboxOutcome> => {
      if (gone || args.sandboxRowId !== "row-1") return "gone";
      lastUsedAt = Date.now();
      return "touched";
    },
  );
  return {
    touch,
    reapable: () => Date.now() - lastUsedAt > ttlMs,
    markGone: () => {
      gone = true;
    },
  };
}

function provisioned() {
  return async () => ({
    ok: true as const,
    box: {
      sandboxRowId: "row-1",
      sandboxId: "sbx-1",
      workdir: "/home/user",
    },
  });
}

/** Let the heartbeat's async touch settle after a timer fires. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  releaseSandboxMock.mockClear();
  dataPlaneConfiguredMock.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("acquireHarnessBox — a turn longer than the idle TTL keeps its box", () => {
  // Eval and journey are the owned boxes; a scenario box held by a Cursor turn
  // is the no-lease case — that harness renews no model lease, so nothing but
  // this heartbeat says its box is in use.
  const cases: Array<{ surface: HarnessBoxSurface; label: string }> = [
    { surface: "eval", label: "eval iteration" },
    { surface: "swarm", label: "journey attempt" },
    { surface: "scenario", label: "no-lease harness (Cursor) conversation" },
  ];

  for (const { surface, label } of cases) {
    it(`${label}: survives 3x its TTL of turn, and reaps after the turn ends`, async () => {
      const ttl = HARNESS_BOX_SCOPES[surface].idleTtlMs;
      const plane = fakeControlPlane(ttl);
      const acquired = await acquireHarnessBox({
        surface,
        provision: provisioned(),
        touch: plane.touch,
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      // A turn three times the TTL long. At every minute of it the box would
      // survive a reaper pass.
      for (let elapsed = 0; elapsed < 3 * ttl; elapsed += MINUTE) {
        await advance(MINUTE);
        expect(plane.reapable()).toBe(false);
      }
      expect(plane.touch).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxRowId: "row-1", sandboxId: "sbx-1" }),
      );

      // The turn ends. Nothing touches the box any more; inside the TTL it
      // still stands, past it the reaper may take it.
      await acquired.box.release();
      const touches = plane.touch.mock.calls.length;
      await advance(ttl - MINUTE);
      expect(plane.reapable()).toBe(false);
      await advance(2 * MINUTE);
      expect(plane.reapable()).toBe(true);
      expect(plane.touch).toHaveBeenCalledTimes(touches);
    });

    it(`${label}: without the heartbeat, the same turn would have lost its box`, async () => {
      const ttl = HARNESS_BOX_SCOPES[surface].idleTtlMs;
      const plane = fakeControlPlane(ttl);
      await advance(ttl + MINUTE);
      expect(plane.reapable()).toBe(true);
    });
  }

  it("beats at most every third of the TTL on every surface", () => {
    for (const surface of Object.keys(
      HARNESS_BOX_SCOPES,
    ) as HarnessBoxSurface[]) {
      expect(harnessBoxHeartbeatIntervalMs(surface)).toBeLessThanOrEqual(
        HARNESS_BOX_SCOPES[surface].idleTtlMs / 3,
      );
    }
  });
});

describe("acquireHarnessBox — ownership and release", () => {
  it("an owned box is released once, through the surface's own release", async () => {
    const release = vi.fn(async () => {});
    const acquired = await acquireHarnessBox({
      surface: "eval",
      provision: provisioned(),
      release,
      touch: vi.fn(async () => "touched" as const),
    });
    if (!acquired.ok) throw new Error("expected a box");
    await Promise.all([acquired.box.release(), acquired.box.release()]);
    await acquired.box.release();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("row-1");
    expect(releaseSandboxMock).not.toHaveBeenCalled();
  });

  it("an owned box with no release of its own uses the scope-agnostic one", async () => {
    const acquired = await acquireHarnessBox({
      surface: "swarm",
      provision: provisioned(),
      touch: vi.fn(async () => "touched" as const),
    });
    if (!acquired.ok) throw new Error("expected a box");
    await acquired.box.release();
    expect(releaseSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxRowId: "row-1" }),
    );
  });

  it("a conversation box outlives the turn: release only stops the heartbeat", async () => {
    const release = vi.fn(async () => {});
    const touch = vi.fn(async () => "touched" as const);
    const acquired = await acquireHarnessBox({
      surface: "scenario",
      provision: provisioned(),
      release,
      touch,
    });
    if (!acquired.ok) throw new Error("expected a box");
    await acquired.box.release();
    await advance(HARNESS_BOX_SCOPES.scenario.idleTtlMs * 2);
    expect(touch).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(releaseSandboxMock).not.toHaveBeenCalled();
  });

  it("a release that throws does not throw out of release()", async () => {
    const acquired = await acquireHarnessBox({
      surface: "eval",
      provision: provisioned(),
      release: async () => {
        throw new Error("control plane down");
      },
      touch: vi.fn(async () => "touched" as const),
    });
    if (!acquired.ok) throw new Error("expected a box");
    await expect(acquired.box.release()).resolves.toBeUndefined();
  });

  it("carries the box's workdir and what booted on the binding", async () => {
    const acquired = await acquireHarnessBox({
      surface: "eval",
      provision: async () => ({
        ok: true as const,
        box: {
          sandboxRowId: "row-1",
          sandboxId: "sbx-1",
          runtimeKind: "desktop-browser" as const,
          workdir: "/home/user",
        },
      }),
      touch: vi.fn(async () => "touched" as const),
    });
    if (!acquired.ok) throw new Error("expected a box");
    expect(acquired.box.binding).toEqual({
      sandboxRowId: "row-1",
      sandboxId: "sbx-1",
      runtimeKind: "desktop-browser",
      workdir: "/home/user",
    });
    await acquired.box.release();
  });

  it("a refusal comes back untouched, and no heartbeat starts", async () => {
    const touch = vi.fn(async () => "touched" as const);
    const refusal = { status: 409, code: "no_pin", error: "No image." };
    const acquired = await acquireHarnessBox({
      surface: "eval",
      provision: async () => ({ ok: false as const, refusal }),
      touch,
    });
    expect(acquired).toEqual({ ok: false, refusal });
    await advance(HARNESS_BOX_SCOPES.eval.idleTtlMs);
    expect(touch).not.toHaveBeenCalled();
  });
});

describe("acquireHarnessBox — the heartbeat", () => {
  it("stops for good once the control plane says the box is gone", async () => {
    const plane = fakeControlPlane(HARNESS_BOX_SCOPES.eval.idleTtlMs);
    const acquired = await acquireHarnessBox({
      surface: "eval",
      provision: provisioned(),
      touch: plane.touch,
    });
    if (!acquired.ok) throw new Error("expected a box");
    const beat = harnessBoxHeartbeatIntervalMs("eval");
    await advance(beat);
    expect(plane.touch).toHaveBeenCalledTimes(1);
    plane.markGone();
    await advance(beat);
    expect(plane.touch).toHaveBeenCalledTimes(2);
    await advance(beat * 4);
    expect(plane.touch).toHaveBeenCalledTimes(2);
    await acquired.box.release();
  });

  it("stops when the turn's signal aborts, and leaves teardown to release()", async () => {
    const release = vi.fn(async () => {});
    const touch = vi.fn(async () => "touched" as const);
    const turn = new AbortController();
    const acquired = await acquireHarnessBox({
      surface: "eval",
      provision: provisioned(),
      release,
      touch,
      signal: turn.signal,
    });
    if (!acquired.ok) throw new Error("expected a box");
    const beat = harnessBoxHeartbeatIntervalMs("eval");
    await advance(beat);
    expect(touch).toHaveBeenCalledTimes(1);

    // The iteration is abandoned past its budget grace: nothing will ever
    // call release(), so the abort alone has to stop the beat.
    turn.abort();
    await advance(beat * 8);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    // A late release still tears the owned box down, exactly once.
    await acquired.box.release();
    await acquired.box.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("starts no heartbeat for a turn that was already aborted", async () => {
    const touch = vi.fn(async () => "touched" as const);
    const acquired = await acquireHarnessBox({
      surface: "swarm",
      provision: provisioned(),
      touch,
      signal: AbortSignal.abort(),
    });
    if (!acquired.ok) throw new Error("expected a box");
    await advance(HARNESS_BOX_SCOPES.swarm.idleTtlMs * 2);
    expect(touch).not.toHaveBeenCalled();
    await acquired.box.release();
  });

  it("keeps beating through a failed touch", async () => {
    const touch = vi
      .fn<() => Promise<TouchSandboxOutcome>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce("failed")
      .mockResolvedValue("touched");
    const acquired = await acquireHarnessBox({
      surface: "eval",
      provision: provisioned(),
      touch,
    });
    if (!acquired.ok) throw new Error("expected a box");
    await advance(harnessBoxHeartbeatIntervalMs("eval") * 3);
    expect(touch).toHaveBeenCalledTimes(3);
    await acquired.box.release();
  });
});

describe("harnessBoxUnavailableReason", () => {
  it("is null on a data plane, and names the need and the fix otherwise", () => {
    expect(
      harnessBoxUnavailableReason("This eval runs on a harness"),
    ).toBeNull();
    dataPlaneConfiguredMock.mockReturnValue(false);
    const reason = harnessBoxUnavailableReason("This eval runs on a harness");
    expect(reason).toMatch(
      /^This eval runs on a harness, but this server isn't a computers data plane/,
    );
    expect(reason).toContain("INSPECTOR_SERVICE_TOKEN");
  });
});
