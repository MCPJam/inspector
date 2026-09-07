import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endLocalHarnessSession,
  forgetLocalHarnessSession,
  getLocalHarnessSession,
  listLocalHarnessSessions,
  registerLocalHarnessSession,
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
    stats: () => ({ requests: 0, rejected: 0, forwarded: 0, upstreamErrors: 0 }),
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
  for (const session of listLocalHarnessSessions()) {
    forgetLocalHarnessSession(session.sessionId);
  }
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
        stop: () =>
          new Promise<{ stopped: boolean }>((r) => (released = r)),
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
