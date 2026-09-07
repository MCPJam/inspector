import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endLocalHarnessSession,
  forgetLocalHarnessSession,
  getLocalHarnessSession,
  listLocalHarnessSessions,
  registerLocalHarnessSession,
  resetLocalHarnessRegistryForTests,
  stopAllLocalHarnessSessions,
  type LocalHarnessSessionRecord,
} from "../session-registry.js";
import type { LocalModelGateway } from "../model-gateway.js";

/** A gateway stub that records when each of its two shutdown steps ran. */
function fakeGateway(order: string[], id = "gw"): LocalModelGateway {
  return {
    baseUrl: "http://127.0.0.1:1",
    port: 1,
    sessionCapability: "cap",
    revoke: () => {
      order.push(`${id}:revoke`);
    },
    close: async () => {
      order.push(`${id}:close`);
    },
    stats: () => ({
      requests: 0,
      rejected: 0,
      forwarded: 0,
      upstreamErrors: 0,
    }),
  };
}

function record(
  overrides: Partial<LocalHarnessSessionRecord> = {},
): LocalHarnessSessionRecord {
  return {
    sessionId: "s1",
    runtimeId: "rt_1",
    workspaceGrantId: "ws_1",
    brokerRunId: "run_1",
    gateway: null,
    stop: async () => ({ stopped: true }),
    revokeLease: null,
    releaseRuntime: null,
    startedAt: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  // Both collections, not just the map: a record kept only in the escaped set
  // has no map entry to iterate, and would leak into the next test.
  resetLocalHarnessRegistryForTests();
});

describe("what the registry holds", () => {
  it("carries ids only — this record is read by telemetry and a stop route", () => {
    registerLocalHarnessSession(record());
    const held = getLocalHarnessSession("s1");
    expect(held).toBeDefined();
    // Nothing here may be a path, an argv, an env, or a credential.
    const serializable = {
      sessionId: held!.sessionId,
      runtimeId: held!.runtimeId,
      workspaceGrantId: held!.workspaceGrantId,
      brokerRunId: held!.brokerRunId,
    };
    expect(JSON.stringify(serializable)).not.toMatch(/[/\\]|ANTHROPIC|sk-/);
  });

  it("replaces a record registered twice under one session id", () => {
    registerLocalHarnessSession(record({ runtimeId: "rt_old" }));
    registerLocalHarnessSession(record({ runtimeId: "rt_new" }));
    expect(listLocalHarnessSessions()).toHaveLength(1);
    expect(getLocalHarnessSession("s1")?.runtimeId).toBe("rt_new");
  });
});

describe("ending one session", () => {
  it("revokes the gateway before anything that can block", async () => {
    // The ordering is the security property, not a style choice: revoking the
    // lease is a network call that can hang, and stopping a tree takes a
    // SIGTERM grace. Through both of those the child must ALREADY be unable to
    // spend anything, and the gateway revoke is the only step that is
    // immediate and local.
    const order: string[] = [];
    registerLocalHarnessSession(
      record({
        gateway: fakeGateway(order),
        revokeLease: async () => {
          order.push("lease");
        },
        stop: async () => {
          order.push("stop");
          return { stopped: true };
        },
      }),
    );
    await endLocalHarnessSession("s1");
    expect(order).toEqual(["gw:revoke", "gw:close", "lease", "stop"]);
  });

  it("stops the tree even when revoking the lease throws", async () => {
    // A lease we failed to revoke expires on its own. A process tree nobody
    // stopped does not.
    const order: string[] = [];
    const result = await (async () => {
      registerLocalHarnessSession(
        record({
          gateway: fakeGateway(order),
          revokeLease: async () => {
            throw new Error("network down");
          },
          stop: async () => {
            order.push("stop");
            return { stopped: true };
          },
        }),
      );
      return endLocalHarnessSession("s1");
    })();
    expect(order).toContain("stop");
    expect(result.stopped).toBe(true);
    expect(result.errors).toEqual(["lease revoke: network down"]);
  });

  it("reports a tree it could not stop, and still revoked the gateway", async () => {
    const order: string[] = [];
    registerLocalHarnessSession(
      record({
        gateway: fakeGateway(order),
        stop: async () => {
          throw new Error("kill refused");
        },
      }),
    );
    const result = await endLocalHarnessSession("s1");
    expect(result.stopped).toBe(false);
    expect(result.errors).toEqual(["stop: kill refused"]);
    expect(order).toEqual(["gw:revoke", "gw:close"]);
  });

  it("gives up the runtime reservation, after the stop", async () => {
    // Two paths end a session and only one of them used to release the
    // reservation. Ending one here freed the tree and still left the version
    // directory claimed for the life of the process, so every later reinstall
    // and repair refused with "in use by N running session(s)" — counting
    // sessions that had already stopped.
    //
    // Order matters as much as the call: the reservation is what stops another
    // process replacing the directory these children execute from, and they
    // are provably gone only once `stop` has returned.
    const order: string[] = [];
    registerLocalHarnessSession(
      record({
        stop: async () => {
          order.push("stop");
          return { stopped: true };
        },
        releaseRuntime: async () => {
          order.push("release");
        },
      }),
    );
    await endLocalHarnessSession("s1");
    expect(order).toEqual(["stop", "release"]);
  });

  it("keeps the reservation when the tree escaped the stop", async () => {
    // `stopSession` reports escaped children in its RESULT, not by throwing.
    // Releasing on "the call did not reject" handed the version directory back
    // while those children were still executing from it, which is exactly what
    // `activateVerifiedPack` consults the reservation to avoid.
    const releaseRuntime = vi.fn(async () => undefined);
    registerLocalHarnessSession(
      record({
        stop: async () => ({ stopped: false, escaped: 2 }),
        releaseRuntime,
      }),
    );
    const result = await endLocalHarnessSession("s1");
    expect(result.stopped).toBe(false);
    expect(result.errors.join(" ")).toMatch(/escaped/);
    // Held, deliberately: an over-held reservation is reclaimed once its owner
    // is provably gone. A released one is a tree executing from a directory
    // another process is free to replace.
    expect(releaseRuntime).not.toHaveBeenCalled();
  });

  it("keeps the reservation when the stop throws", async () => {
    const releaseRuntime = vi.fn(async () => undefined);
    registerLocalHarnessSession(
      record({
        stop: async (): Promise<{ stopped: boolean }> => {
          throw new Error("SIGKILL refused");
        },
        releaseRuntime,
      }),
    );
    const result = await endLocalHarnessSession("s1");
    expect(result.stopped).toBe(false);
    expect(releaseRuntime).not.toHaveBeenCalled();
  });

  it("keeps a session that would not stop listed, so it can be stopped again", async () => {
    // The record is deleted up front so two concurrent callers cannot both run
    // the teardown — but deleting it for good on a FAILED stop threw away the
    // only handle this process had on a tree that is still running, and with
    // it the reservation that tree still holds. `stop-all` reads this map, so
    // the retry went out with the record and nothing short of quitting the
    // Inspector could free the runtime directory again.
    let escaped = 2;
    const stop = vi.fn(async () =>
      escaped > 0 ? { stopped: false, escaped } : { stopped: true },
    );
    const releaseRuntime = vi.fn(async () => undefined);
    registerLocalHarnessSession(record({ stop, releaseRuntime }));

    const first = await endLocalHarnessSession("s1");
    expect(first.stopped).toBe(false);
    expect(releaseRuntime).not.toHaveBeenCalled();
    // Still listed — for the stop-all button and for the telemetry count,
    // which would otherwise report a running session as gone.
    expect(getLocalHarnessSession("s1")).toBeDefined();
    expect(listLocalHarnessSessions()).toHaveLength(1);

    // Pressed again, and this time the tree goes down: the retry the retained
    // record made possible is what finally hands the reservation back.
    escaped = 0;
    const second = await endLocalHarnessSession("s1");
    expect(second.stopped).toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(releaseRuntime).toHaveBeenCalledTimes(1);
    expect(getLocalHarnessSession("s1")).toBeUndefined();
  });

  it("still reaches an escaped tree whose id a newer turn has claimed", async () => {
    // One map slot cannot hold two live trees. Re-registering the escaped one
    // over the newer record would put a running session beyond `stop-all`;
    // declining to re-register lost the escaped tree's only stop handle, and
    // with it the runtime reservation that tree still holds. Both are the same
    // harm in opposite directions, so the escaped record is kept BY RECORD as
    // well, and `stop-all` reads both.
    let escapedStops = 0;
    let escapes = 1;
    const escapedRelease = vi.fn(async () => undefined);
    let resolveStop: (v: {
      stopped: boolean;
      escaped?: number;
    }) => void = () => {};
    const hangingStop = new Promise<{ stopped: boolean; escaped?: number }>(
      (resolve) => {
        resolveStop = resolve;
      },
    );
    const stopCalled = vi.fn();
    registerLocalHarnessSession(
      record({
        runtimeId: "rt_escaped",
        stop: () => {
          escapedStops += 1;
          stopCalled();
          if (escapedStops === 1) return hangingStop;
          return Promise.resolve(
            escapes > 0
              ? { stopped: false, escaped: escapes }
              : { stopped: true },
          );
        },
        releaseRuntime: escapedRelease,
      }),
    );
    const ending = endLocalHarnessSession("s1");
    await vi.waitFor(() => expect(stopCalled).toHaveBeenCalled());

    // A newer turn claims the id while the old stop is still hanging.
    const newerStop = vi.fn(async () => ({ stopped: true }));
    const newerRelease = vi.fn(async () => undefined);
    registerLocalHarnessSession(
      record({
        runtimeId: "rt_newer",
        stop: newerStop,
        releaseRuntime: newerRelease,
      }),
    );

    resolveStop({ stopped: false, escaped: 2 });
    await ending;
    // The newer record keeps the slot, so nothing puts it out of reach.
    expect(getLocalHarnessSession("s1")?.runtimeId).toBe("rt_newer");
    expect(escapedRelease).not.toHaveBeenCalled();

    // …and the brake still reaches BOTH: the newer session through the map,
    // the escaped tree through the record kept beside it.
    escapes = 0;
    const all = await stopAllLocalHarnessSessions();
    expect(newerStop).toHaveBeenCalledTimes(1);
    expect(newerRelease).toHaveBeenCalledTimes(1);
    expect(escapedStops).toBe(2);
    expect(escapedRelease).toHaveBeenCalledTimes(1);
    expect(all).toMatchObject({ ok: true, stopped: 2, failed: 0 });
  });

  it("keeps an escaped tree when the id it used is forgotten", async () => {
    // `forgetLocalHarnessSession` is a map operation. The abandoned-setup path
    // calls it by id, and sweeping the escaped set by id too would take an
    // escaped predecessor's only stop handle whenever a later turn had already
    // claimed the slot — the exact loss that set exists to prevent.
    let escapes = 1;
    const escapedStop = vi.fn(async () =>
      escapes > 0 ? { stopped: false, escaped: escapes } : { stopped: true },
    );
    const escapedRelease = vi.fn(async () => undefined);
    registerLocalHarnessSession(
      record({ stop: escapedStop, releaseRuntime: escapedRelease }),
    );
    expect((await endLocalHarnessSession("s1")).stopped).toBe(false);

    // A later turn takes the id, then its own setup is abandoned by id.
    registerLocalHarnessSession(record({ runtimeId: "rt_newer" }));
    forgetLocalHarnessSession("s1");
    expect(getLocalHarnessSession("s1")).toBeUndefined();

    // The escaped tree is still reachable, and the brake still stops it.
    escapes = 0;
    const all = await stopAllLocalHarnessSessions();
    expect(escapedStop).toHaveBeenCalledTimes(2);
    expect(escapedRelease).toHaveBeenCalledTimes(1);
    expect(all).toMatchObject({ ok: true, stopped: 1, failed: 0 });
  });

  it("does not put a stale record back over a newer one for the same id", async () => {
    // A session id reused by a later turn must win: the retry path exists to
    // keep an escaped tree reachable, not to resurrect a record the caller has
    // already replaced.
    let resolveStop: (v: {
      stopped: boolean;
      escaped?: number;
    }) => void = () => {};
    const hangingStop = new Promise<{ stopped: boolean; escaped?: number }>(
      (resolve) => {
        resolveStop = resolve;
      },
    );
    const stopCalled = vi.fn();
    registerLocalHarnessSession(
      record({
        stop: () => {
          stopCalled();
          return hangingStop;
        },
        releaseRuntime: async () => undefined,
      }),
    );
    const ending = endLocalHarnessSession("s1");
    // Wait until the teardown is actually parked on the stop, so the record is
    // already deleted and the re-register below is the only thing in the map.
    await vi.waitFor(() => expect(stopCalled).toHaveBeenCalled());
    // A new turn claims the id while the old stop is still hanging.
    registerLocalHarnessSession(record({ runtimeId: "rt_2" }));
    resolveStop({ stopped: false, escaped: 1 });
    await ending;

    expect(getLocalHarnessSession("s1")?.runtimeId).toBe("rt_2");
    expect(listLocalHarnessSessions()).toHaveLength(1);
  });

  it("still ends the session when the reservation will not release", async () => {
    const stop = vi.fn(async () => ({ stopped: true }));
    registerLocalHarnessSession(
      record({
        stop,
        releaseRuntime: async () => {
          throw new Error("lock timeout");
        },
      }),
    );
    const result = await endLocalHarnessSession("s1");
    // The tree is down, which is the part that matters; the failure is
    // reported rather than thrown, exactly as the other steps are.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe(true);
    expect(result.errors.join(" ")).toMatch(/runtime release/);
  });

  it("tears a session down exactly once, however many callers ask", async () => {
    // The abort path, the stop-all button and the turn's own teardown can all
    // arrive together. The record is dropped before any of the slow steps, so
    // the second caller finds nothing rather than sending a second SIGTERM.
    const stop = vi.fn(async () => ({ stopped: true }));
    registerLocalHarnessSession(record({ stop }));
    const [first, second] = await Promise.all([
      endLocalHarnessSession("s1"),
      endLocalHarnessSession("s1"),
    ]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(first.stopped && second.stopped).toBe(true);
    expect(getLocalHarnessSession("s1")).toBeUndefined();
  });
});

describe("the stop-all brake", () => {
  it("ends every session even when one of them hangs on its grace", async () => {
    // Ended in parallel, so a tree sitting out a SIGTERM grace does not hold
    // up the rest — the whole point of the button is that it acts now.
    let released: ((outcome: { stopped: boolean }) => void) | null = null;
    registerLocalHarnessSession(
      record({
        sessionId: "slow",
        stop: () => new Promise<{ stopped: boolean }>((r) => (released = r)),
      }),
    );
    registerLocalHarnessSession(record({ sessionId: "quick" }));
    const all = stopAllLocalHarnessSessions();
    await new Promise((r) => setTimeout(r, 20));
    expect(released).not.toBeNull();
    // Resolved WITH an outcome: an empty resolve now means "not stopped", which
    // is the point of the tightened contract.
    (released as unknown as (o: { stopped: boolean }) => void)({
      stopped: true,
    });
    expect(await all).toEqual({ ok: true, stopped: 2, failed: 0 });
    expect(listLocalHarnessSessions()).toEqual([]);
  });

  it("counts the ones that would not stop", async () => {
    registerLocalHarnessSession(record({ sessionId: "ok" }));
    registerLocalHarnessSession(
      record({
        sessionId: "stuck",
        stop: async () => {
          throw new Error("no");
        },
      }),
    );
    expect(await stopAllLocalHarnessSessions()).toEqual({
      ok: false,
      stopped: 1,
      failed: 1,
    });
  });

  it("is fine with nothing to stop", async () => {
    expect(await stopAllLocalHarnessSessions()).toEqual({
      ok: true,
      stopped: 0,
      failed: 0,
    });
  });
});
