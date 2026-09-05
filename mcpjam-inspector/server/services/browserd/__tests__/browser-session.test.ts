/**
 * `ensureBrowserSession` — the W2 durable-session orchestration, against fully
 * fake deps. What these tests pin:
 *
 *   - the replica-independence payoff: a verified-live row is reused with ZERO
 *     sandbox I/O;
 *   - health-check recovery (not kill-on-wake): only a failed verification —
 *     unhealthy, unauthorized, bootId mismatch, or transport failure — leads
 *     to connect → kill → relaunch;
 *   - every refusal path: a record that does not land stops the daemon; a
 *     stream failure stops the daemon; a lost boot race falls back to the
 *     winner's session;
 *   - the stream password is minted exactly once per relaunch and appears in
 *     both the record and the handle.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserdHandle } from "../boot-browserd";
import type { BrowserdLeaseState, BrowserdStatus } from "../browserd-client";
import { HandoffLease } from "../daemon/lease";
import type {
  BrowserSessionLookup,
  BrowserSessionRecord,
  BrowserSessionRecordResult,
} from "../browser-sessions-client";
import {
  attachBrowserSession,
  BROWSERD_PORT,
  BROWSERD_SCRIPT_PATH,
  BROWSERD_USER_DATA_DIR,
  BrowserSessionInUseError,
  ensureBrowserSession,
  type BrowserSessionDeps,
  type SessionClient,
  type SessionSandbox,
} from "../browser-session";
import { resetActivityThrottleForTests } from "../../../utils/computers/activity-touch.js";

const COMPUTER = "computer-1";
const HASH = "bundle-hash-1";
const ROW = {
  sessionId: "session-1",
  computerId: COMPUTER,
  bootId: "boot-old",
  browserdToken: "token-old",
  browserdPort: 8791,
  publicOrigin: "https://old.example",
  streamUrl: "https://stream.example/vnc.html",
  streamPassword: "pw-old",
  bundleHash: HASH,
  contextMode: "persistent" as const,
};

function liveLookup(
  over?: Partial<BrowserSessionRecord>,
): BrowserSessionLookup {
  const session = { ...ROW, ...over };
  return {
    reachable: true,
    session,
    observedSessionId: session.sessionId,
  };
}

type LeaseActionFn = (args: {
  action: "acquire" | "heartbeat" | "resume";
  holder: string;
  ttlMs?: number;
  kind?: "human" | "script";
}) => Promise<{ took: boolean; lease: BrowserdLeaseState }>;

/**
 * A `leaseAction` backed by the REAL `HandoffLease`, not by a hand-written
 * answer.
 *
 * The whole claim under test is that taking the lease is atomic — that a pane
 * pressing "Take control" while a relaunch is deciding LOSES. A fake that just
 * returns `{took:false}` when a test says so proves nothing about that; the
 * daemon's own class, wired to the same `took` rule the request handler uses,
 * is what makes a competing acquire in these tests fail for the production
 * reason.
 */
function leaseBackedBy(lease: HandoffLease): LeaseActionFn {
  return async (args) => {
    const state =
      args.action === "acquire"
        ? lease.acquire(args.holder, args.ttlMs, args.kind)
        : args.action === "heartbeat"
          ? lease.heartbeat(args.holder, args.ttlMs)
          : lease.resume(args.holder);
    // Mirrors request-handler.ts: only an acquire can fail to take.
    const took =
      args.action !== "acquire" ||
      (state.state === "held" && state.holder === args.holder);
    return {
      took,
      lease: { ...state, bootId: ROW.bootId } as BrowserdLeaseState,
    };
  };
}

interface Fakes {
  deps: BrowserSessionDeps;
  sandbox: SessionSandbox & {
    killBrowserd: ReturnType<typeof vi.fn>;
    writeBundle: ReturnType<typeof vi.fn>;
    ensureStream: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  bootHandle: BrowserdHandle & { stop: ReturnType<typeof vi.fn> };
  connect: ReturnType<typeof vi.fn>;
  boot: ReturnType<typeof vi.fn>;
  claimRelaunch: ReturnType<typeof vi.fn>;
  releaseRelaunch: ReturnType<typeof vi.fn>;
  lookup: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  touch: ReturnType<typeof vi.fn>;
  touchActivity: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}

function makeFakes(over?: {
  lookups?: BrowserSessionLookup[];
  status?: () => Promise<BrowserdStatus>;
  /**
   * The daemon's lease ENDPOINT, when a test needs the relaunch to reach one.
   * Omitted ⇒ a client that predates it, which must not block recovery.
   */
  leaseAction?: LeaseActionFn;
  recordResult?: BrowserSessionRecordResult;
  /**
   * What the control plane says when this replica asks to relaunch. Omitted ⇒
   * granted, which is the ordinary case.
   */
  claim?: { ok: true } | { ok: false; reason: "claimed" | "unavailable" };
  bootError?: Error;
  streamError?: Error;
}): Fakes {
  const lookups = over?.lookups ?? [{ reachable: true, session: null }];
  let lookupCalls = 0;

  const bootHandle = {
    bearer: "token-new",
    bootId: "boot-new",
    port: BROWSERD_PORT,
    publicOrigin: "https://new.example",
    stop: vi.fn(async () => {}),
  };

  const sandbox = {
    writeBundle: vi.fn(async () => {}),
    browserd: {
      runBackground: async () => ({
        kill: async () => {},
        wait: async () => {},
      }),
      getHost: () => "new.example",
    },
    killBrowserd: vi.fn(async () => {}),
    ensureStream: vi.fn(async () => {
      if (over?.streamError) throw over.streamError;
      return {
        streamUrl: "https://stream-new.example/vnc.html",
        streamPassword: "pw-stream",
      };
    }),
    disconnect: vi.fn(async () => {}),
  };

  const status = vi.fn(
    over?.status ??
      (async (): Promise<BrowserdStatus> => ({
        kind: "ok",
        bootId: ROW.bootId,
      })),
  );
  const lookup = vi.fn(async () => {
    const result = lookups[Math.min(lookupCalls, lookups.length - 1)];
    lookupCalls += 1;
    return result;
  });
  const record = vi.fn(
    async (): Promise<BrowserSessionRecordResult> =>
      over?.recordResult ?? { status: "recorded", sessionId: "session-new" },
  );
  const touch = vi.fn(async () => ({ counted: true }));
  const claimRelaunch = vi.fn(
    async () => over?.claim ?? ({ ok: true } as const),
  );
  const releaseRelaunch = vi.fn(async () => {});
  const touchActivity = vi.fn(async () => ({ ok: true }));
  const sendCommand = vi.fn<SessionClient["sendCommand"]>(async () => ({
    status: "ok" as const,
    result: { ok: true, output: {} },
    bootId: ROW.bootId,
  }));
  const connect = vi.fn(async () => sandbox);
  const boot = vi.fn(async () => {
    if (over?.bootError) throw over.bootError;
    return bootHandle;
  });

  const deps: BrowserSessionDeps = {
    reserveDesktop: vi.fn(async () => ({ computerId: COMPUTER })),
    resolveSandboxId: vi.fn(async () => "sandbox-1"),
    connect,
    boot,
    createClient: vi.fn(() => ({
      status,
      sendCommand,
      ...(over?.leaseAction ? { leaseAction: over.leaseAction } : {}),
    })),
    store: {
      lookup,
      record,
      touch,
      claimRelaunch,
      releaseRelaunch,
    },
    touchActivity,
    bundle: () => new Uint8Array([1, 2, 3]),
    bundleHash: () => HASH,
  };

  return {
    deps,
    sandbox,
    bootHandle,
    connect,
    boot,
    claimRelaunch,
    releaseRelaunch,
    lookup,
    record,
    touch,
    touchActivity,
    sendCommand,
    status,
  };
}

const ARGS = { bearer: "user-bearer", projectId: "project-1" };

// The computer-activity throttle is module state keyed by computer id, and
// every case here uses the same one.
beforeEach(() => resetActivityThrottleForTests());

describe("ensureBrowserSession — verified reuse", () => {
  it("reuses a healthy daemon with matching bootId and NEVER touches the sandbox", async () => {
    const f = makeFakes({ lookups: [liveLookup()] });
    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(handle.reused).toBe(true);
    expect(handle.bootId).toBe(ROW.bootId);
    expect(handle.streamUrl).toBe(ROW.streamUrl);
    expect(handle.streamPassword).toBe(ROW.streamPassword);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(f.touch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: ROW.sessionId, kind: "command" }),
    );
  });

  it("asks the store with the CURRENT bundle hash", async () => {
    const f = makeFakes({ lookups: [liveLookup()] });
    await ensureBrowserSession(f.deps, ARGS);
    expect(f.lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        computerId: COMPUTER,
        expectedBundleHash: HASH,
      }),
    );
  });
});

describe("ensureBrowserSession — relaunch triggers", () => {
  async function expectRelaunch(f: Fakes) {
    const handle = await ensureBrowserSession(f.deps, ARGS);
    expect(handle.reused).toBe(false);
    expect(handle.bootId).toBe("boot-new");
    expect(f.sandbox.killBrowserd).toHaveBeenCalled();
    expect(f.sandbox.writeBundle).toHaveBeenCalledWith(
      BROWSERD_SCRIPT_PATH,
      expect.any(Uint8Array),
    );
    expect(f.boot).toHaveBeenCalledWith(
      f.sandbox.browserd,
      expect.objectContaining({
        scriptPath: BROWSERD_SCRIPT_PATH,
        port: BROWSERD_PORT,
        userDataDir: BROWSERD_USER_DATA_DIR,
      }),
    );
    expect(f.sandbox.disconnect).toHaveBeenCalled();
    return handle;
  }

  it("relaunches when no session row exists", async () => {
    const f = makeFakes();
    await expectRelaunch(f);
  });

  it("relaunches on a bootId mismatch (the row describes a previous boot)", async () => {
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "ok", bootId: "boot-someone-else" }),
    });
    await expectRelaunch(f);
  });

  it("wakes a paused box and reuses the daemon it finds there", async () => {
    // `tryReuse` deliberately never touches the sandbox, so a merely PAUSED
    // box fails its probe exactly like a dead daemon does. Connecting resumes
    // it — and the relaunch that used to follow rotates `bootId` and the
    // stream password, breaking every open pane and in-flight command against
    // that box, to replace a daemon that was only asleep.
    let probes = 0;
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => {
        probes += 1;
        // Asleep for the first probe; awake once `connect` has resumed it.
        return probes === 1
          ? { kind: "unhealthy", detail: "box is paused" }
          : { kind: "ok", bootId: ROW.bootId };
      },
    });

    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(handle.reused).toBe(true);
    expect(handle.bootId).toBe(ROW.bootId);
    // Woken, but nothing torn down.
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    // The connection is still released even on this early return.
    expect(f.sandbox.disconnect).toHaveBeenCalledTimes(1);
  });

  it("refuses to restart a browser somebody is holding", async () => {
    // The relaunch pkills their Chromium and rotates the boot, which from
    // their side is the page vanishing mid-login. The lease is the whole
    // reason we can know that.
    const lease = new HandoffLease();
    lease.acquire("panel-1");
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "unhealthy", detail: "no answer" }),
      leaseAction: leaseBackedBy(lease),
    });

    await expect(ensureBrowserSession(f.deps, ARGS)).rejects.toThrow(
      /lease_held/,
    );
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(f.sandbox.disconnect).toHaveBeenCalledTimes(1);
    // And their hold is untouched: a refusal must not cost them the lease.
    expect(lease.state()).toMatchObject({ state: "held", holder: "panel-1" });
  });

  it("refuses for a PARKED lease too, which is a hold nobody let go of", async () => {
    // Parking is what an expired hold becomes when a pane stops its
    // heartbeat — the tab was closed, or the machine slept. It is not
    // evidence the private moment is over.
    let clock = 1_000;
    const lease = new HandoffLease({ now: () => clock });
    lease.acquire("panel-1", 1_000);
    clock += 60_000; // their pane went quiet; the hold ran out
    expect(lease.state().state).toBe("parked");

    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "unhealthy", detail: "no answer" }),
      leaseAction: leaseBackedBy(lease),
    });

    await expect(ensureBrowserSession(f.deps, ARGS)).rejects.toThrow(
      /lease_held/,
    );
    expect(f.boot).not.toHaveBeenCalled();
  });

  it("relaunches when the lease is free, or cannot be asked", async () => {
    // A daemon that cannot answer is not one anybody is driving, and an older
    // daemon without the endpoint answers nothing at all — neither may block
    // recovery of a genuinely dead browser.
    await expectRelaunch(
      makeFakes({
        lookups: [liveLookup()],
        status: async () => ({ kind: "unhealthy", detail: "no answer" }),
        leaseAction: leaseBackedBy(new HandoffLease()),
      }),
    );
    await expectRelaunch(
      makeFakes({
        lookups: [liveLookup()],
        status: async () => ({ kind: "unhealthy", detail: "no answer" }),
        leaseAction: async () => {
          throw new Error("this daemon predates the endpoint");
        },
      }),
    );
    // A client with no lease endpoint at all — the optional-call path.
    await expectRelaunch(
      makeFakes({
        lookups: [liveLookup()],
        status: async () => ({ kind: "unhealthy", detail: "no answer" }),
      }),
    );
  });

  it("TAKES the lease before killing, so a pane cannot slip into the gap", async () => {
    // Reading the lease and then killing is a check-then-act with an HTTP
    // round trip in the middle: "Take control" pressed inside that window used
    // to be honoured and then annihilated a moment later. The relaunch now
    // takes the lease, so the pane's acquire is the one that loses — at the
    // daemon, once.
    const lease = new HandoffLease();
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "unhealthy", detail: "no answer" }),
      leaseAction: leaseBackedBy(lease),
    });
    // The moment the relaunch reaches the kill, a person presses the button.
    let paneTook: boolean | undefined;
    f.sandbox.killBrowserd.mockImplementation(async () => {
      const state = lease.acquire("panel-1");
      paneTook = state.state === "held" && state.holder === "panel-1";
    });

    await ensureBrowserSession(f.deps, ARGS);

    expect(f.sandbox.killBrowserd).toHaveBeenCalled();
    expect(paneTook, "the pane took a lease the relaunch was holding").toBe(
      false,
    );
  });

  it("hands the lease back when the kill fails, rather than wedging a live daemon", async () => {
    // The daemon is still alive and we are holding its lease. Left there it
    // blocks the agent AND every person, and on expiry it PARKS, which never
    // frees on its own.
    const lease = new HandoffLease();
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "unhealthy", detail: "no answer" }),
      leaseAction: leaseBackedBy(lease),
    });
    f.sandbox.killBrowserd.mockRejectedValue(new Error("sandbox exec failed"));

    await expect(ensureBrowserSession(f.deps, ARGS)).rejects.toThrow(
      "sandbox exec failed",
    );
    expect(lease.state()).toEqual({ state: "free" });
  });

  it("steps over its OWN debris instead of bricking the box forever", async () => {
    // A fence outlives its relaunch if this process dies between the take and
    // the kill. It then parks, and a parked lease never auto-frees — so a
    // refusal that could not tell that hold from a person's would refuse every
    // future relaunch, with no way back. Only the relaunch mints holders under
    // this prefix, so such a hold can only be an interrupted relaunch.
    let clock = 1_000;
    const lease = new HandoffLease({ now: () => clock });
    lease.acquire(
      "relaunch:11111111-2222-3333-4444-555555555555",
      1_000,
      "script",
    );
    clock += 60_000;
    expect(lease.state().state).toBe("parked");

    await expectRelaunch(
      makeFakes({
        lookups: [liveLookup()],
        status: async () => ({ kind: "unhealthy", detail: "no answer" }),
        leaseAction: leaseBackedBy(lease),
      }),
    );
  });

  it("ASKS A STALE DAEMON who holds it, rather than killing it blind", async () => {
    // The bundle hash is checked before everything, and every daemon change
    // rotates it — so right after each deploy the lookup answers `null` for a
    // box whose Chromium may have somebody signed in on it. Reading that as
    // "no row, nothing to protect" killed them on the FIRST relaunch after
    // every release, which is not a corner but the common path.
    const lease = new HandoffLease();
    lease.acquire("someone-mid-login", 60_000, "human");
    const f = makeFakes({
      lookups: [
        {
          reachable: true,
          session: null,
          stale: "bundle_changed",
          observedSessionId: ROW.sessionId,
          staleSession: {
            publicOrigin: ROW.publicOrigin,
            browserdToken: ROW.browserdToken,
            bootId: ROW.bootId,
            contextMode: "persistent",
          },
        },
      ],
      leaseAction: leaseBackedBy(lease),
    });
    await expect(
      ensureBrowserSession(f.deps, { bearer: "b", projectId: "p" }),
    ).rejects.toBeInstanceOf(BrowserSessionInUseError);
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
  });

  it("relaunches a stale daemon nobody is holding", async () => {
    // The address is for ASKING, not for refusing. A free lease means the
    // relaunch proceeds exactly as before.
    const lease = new HandoffLease();
    const f = makeFakes({
      lookups: [
        {
          reachable: true,
          session: null,
          stale: "bundle_changed",
          observedSessionId: ROW.sessionId,
          staleSession: {
            publicOrigin: ROW.publicOrigin,
            browserdToken: ROW.browserdToken,
            bootId: ROW.bootId,
            contextMode: "persistent",
          },
        },
      ],
      leaseAction: leaseBackedBy(lease),
    });
    await expect(
      ensureBrowserSession(f.deps, { bearer: "b", projectId: "p" }),
    ).resolves.toMatchObject({ reused: false });
    expect(f.sandbox.killBrowserd).toHaveBeenCalled();
  });

  it("relaunches when the control plane offers no stale address at all", async () => {
    // Absence means nobody to ask — the box is not serving, or the control
    // plane predates the field. Either way the relaunch proceeds as it always
    // did, which is what lets the inspector ship ahead of the backend.
    const lease = new HandoffLease();
    lease.acquire("someone-mid-login", 60_000, "human");
    const f = makeFakes({
      lookups: [
        {
          reachable: true,
          session: null,
          stale: "bundle_changed",
          observedSessionId: ROW.sessionId,
        },
      ],
      leaseAction: leaseBackedBy(lease),
    });
    await expect(
      ensureBrowserSession(f.deps, { bearer: "b", projectId: "p" }),
    ).resolves.toMatchObject({ reused: false });
    expect(f.sandbox.killBrowserd).toHaveBeenCalled();
  });

  it("REFUSES when another replica already claimed the relaunch", async () => {
    // The lease fence cannot cover this: the race that hurts is the one where
    // there is no daemon yet to hold a lease on — a first boot, or a row the
    // sweep took — and there the second replica's pkill reaps the daemon the
    // first has just booted. The record compare-and-swap fires long after the
    // kill, and the damage is the kill.
    const f = makeFakes({
      lookups: [{ reachable: true, session: null }],
      claim: { ok: false, reason: "claimed" },
    });
    await expect(
      ensureBrowserSession(f.deps, { bearer: "b", projectId: "p" }),
    ).rejects.toBeInstanceOf(BrowserSessionInUseError);
    // Nothing was killed and nothing was booted.
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
  });

  it("takes the claim BEFORE the kill, and gives it back after", async () => {
    // Taken after the kill it would protect nothing: the kill is the damage.
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    await ensureBrowserSession(f.deps, { bearer: "b", projectId: "p" });
    expect(f.claimRelaunch).toHaveBeenCalledTimes(1);
    const claimOrder = f.claimRelaunch.mock.invocationCallOrder[0]!;
    const killOrder = f.sandbox.killBrowserd.mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(killOrder);
    expect(f.releaseRelaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: f.claimRelaunch.mock.calls[0]![0].claimId,
      }),
    );
  });

  it("gives the claim back even when the relaunch throws", async () => {
    // Otherwise the next attempt waits out the whole TTL for a replica that
    // already failed and went away.
    const f = makeFakes({
      lookups: [{ reachable: true, session: null }],
      bootError: new Error("chromium would not start"),
    });
    await expect(
      ensureBrowserSession(f.deps, { bearer: "b", projectId: "p" }),
    ).rejects.toThrow(/chromium/);
    expect(f.releaseRelaunch).toHaveBeenCalledTimes(1);
  });

  it("relaunches unclaimed against a control plane that has no claim route", async () => {
    // The inspector ships before the backend does. `unavailable` must mean
    // "as before", not "refuse" — otherwise this change bricks every relaunch
    // in the window between the two deploys.
    const f = makeFakes({
      lookups: [{ reachable: true, session: null }],
      claim: { ok: false, reason: "unavailable" },
    });
    await expect(
      ensureBrowserSession(f.deps, { bearer: "b", projectId: "p" }),
    ).resolves.toMatchObject({ reused: false });
    expect(f.sandbox.killBrowserd).toHaveBeenCalled();
    // Nothing to give back.
    expect(f.releaseRelaunch).not.toHaveBeenCalled();
  });

  it("waits for ANOTHER replica's relaunch instead of killing it mid-boot", async () => {
    // The debris rule is about a fence nobody is behind any more. A `held`
    // relaunch hold is the opposite: a replica inside its own thirty seconds,
    // quite possibly mid-boot. Reading that as debris turns the fence into the
    // very collision it exists to prevent, with two of us instead of a person
    // and an agent.
    const lease = new HandoffLease();
    lease.acquire(
      "relaunch:99999999-8888-7777-6666-555555555555",
      30_000,
      "script",
    );
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "unhealthy", detail: "no answer" }),
      leaseAction: leaseBackedBy(lease),
    });

    await expect(ensureBrowserSession(f.deps, ARGS)).rejects.toThrow(
      /another replica is restarting/,
    );
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
  });

  it("asks about ownership across BOTH profile modes, not just its own", async () => {
    // The reuse lookup is mode-scoped, and rightly so: an eval must never
    // inherit a signed-in profile, so the backend answers `null` for a row in
    // the other mode. Ownership is a different question. Reusing that filtered
    // answer read "somebody is on this box" as "no row, nothing to protect",
    // and an ephemeral turn killed the persistent browser a person was
    // logging in on.
    const lease = new HandoffLease();
    lease.acquire("panel-1");
    const f = makeFakes({
      lookups: [
        {
          reachable: true,
          session: null,
          stale: "context_mode_changed",
          observedSessionId: ROW.sessionId,
        },
        liveLookup(),
      ],
      leaseAction: leaseBackedBy(lease),
    });

    await expect(
      ensureBrowserSession(f.deps, { ...ARGS, contextMode: "ephemeral" }),
    ).rejects.toThrow(/lease_held/);
    expect(f.lookup).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedContextMode: "ephemeral" }),
    );
    expect(f.lookup).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedContextMode: "any" }),
    );
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
  });

  it("protects an EPHEMERAL holder from a persistent turn just the same", async () => {
    // The mirror case, because the asymmetry would be invisible otherwise: an
    // eval's box is somebody's too while a person is driving it.
    const lease = new HandoffLease();
    lease.acquire("panel-1");
    const f = makeFakes({
      lookups: [
        {
          reachable: true,
          session: null,
          stale: "context_mode_changed",
          observedSessionId: ROW.sessionId,
        },
        liveLookup({ contextMode: "ephemeral" }),
      ],
      leaseAction: leaseBackedBy(lease),
    });

    await expect(ensureBrowserSession(f.deps, ARGS)).rejects.toThrow(
      /lease_held/,
    );
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
  });

  it("relaunches on an unhealthy daemon", async () => {
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "unhealthy", detail: "chromium exited" }),
    });
    await expectRelaunch(f);
  });

  it("relaunches when the stored bearer is not the daemon's secret", async () => {
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "unauthorized" }),
    });
    await expectRelaunch(f);
  });

  it("relaunches when the status probe cannot reach the daemon at all", async () => {
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => {
        throw new Error("network unreachable");
      },
    });
    await expectRelaunch(f);
  });
});

describe("ensureBrowserSession — the record is load-bearing", () => {
  it("starts the stream once and records the password the stream minted", async () => {
    const f = makeFakes();
    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(f.sandbox.ensureStream).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({
        computerId: COMPUTER,
        bootId: "boot-new",
        browserdToken: "token-new",
        browserdPort: BROWSERD_PORT,
        publicOrigin: "https://new.example",
        streamUrl: "https://stream-new.example/vnc.html",
        streamPassword: "pw-stream",
        bundleHash: HASH,
        contextMode: "persistent",
      }),
    );
    expect(handle.streamPassword).toBe("pw-stream");
    // Recorded: the daemon must outlive the call.
    expect(f.bootHandle.stop).not.toHaveBeenCalled();
  });

  it("passes the observed row id so the record is a compare-and-swap", async () => {
    // A relaunch after a STALE row must name that row; the backend refuses
    // the write if the current row is no longer it.
    const f = makeFakes({
      lookups: [
        {
          reachable: true,
          session: null,
          stale: "bundle_changed",
          observedSessionId: "session-old",
        },
      ],
    });
    await ensureBrowserSession(f.deps, ARGS);
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({ replacesSessionId: "session-old" }),
    );

    // A relaunch after NO row must omit it — absence is the claim "there was
    // nothing here", which the backend checks just as strictly.
    const fresh = makeFakes({ lookups: [{ reachable: true, session: null }] });
    await ensureBrowserSession(fresh.deps, ARGS);
    expect(fresh.record).toHaveBeenCalledWith(
      expect.not.objectContaining({ replacesSessionId: expect.anything() }),
    );
  });

  it("stops the daemon and refuses when the record does not land", async () => {
    const f = makeFakes({ recordResult: { status: "failed" } });
    await expect(ensureBrowserSession(f.deps, ARGS)).rejects.toThrow(
      /record did not land/,
    );
    expect(f.bootHandle.stop).toHaveBeenCalled();
    expect(f.sandbox.disconnect).toHaveBeenCalled();
  });

  it("stops the daemon when the stream cannot be started", async () => {
    const f = makeFakes({ streamError: new Error("no display") });
    await expect(ensureBrowserSession(f.deps, ARGS)).rejects.toThrow(
      "no display",
    );
    expect(f.bootHandle.stop).toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
});

describe("ensureBrowserSession — contextMode", () => {
  it("boots an ephemeral session with no persistent profile (W6)", async () => {
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    const handle = await ensureBrowserSession(f.deps, {
      ...ARGS,
      contextMode: "ephemeral",
    });
    expect(handle.contextMode).toBe("ephemeral");
    // The daemon is told, so it launches with no user-data-dir at all: an
    // eval's isolation is a property of the browser, not of remembering to
    // clear cookies.
    expect(f.boot).toHaveBeenCalledWith(
      f.sandbox.browserd,
      expect.objectContaining({ contextMode: "ephemeral" }),
    );
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({ contextMode: "ephemeral" }),
    );
  });

  it("asks the store for the ephemeral mode, so a persistent row is never reused", async () => {
    const f = makeFakes({ lookups: [liveLookup()] });
    await ensureBrowserSession(f.deps, { ...ARGS, contextMode: "ephemeral" });
    expect(f.lookup).toHaveBeenCalledWith(
      expect.objectContaining({ expectedContextMode: "ephemeral" }),
    );
    // The live persistent row is NOT verified or reused for an eval.
    expect(f.status).not.toHaveBeenCalled();
    expect(f.boot).toHaveBeenCalled();
  });

  it("asks the store for the mode it intends to run in", async () => {
    const f = makeFakes({ lookups: [liveLookup()] });
    await ensureBrowserSession(f.deps, ARGS);
    expect(f.lookup).toHaveBeenCalledWith(
      expect.objectContaining({ expectedContextMode: "persistent" }),
    );
  });

  it("never reuses a daemon running the other profile mode", async () => {
    // Defence in depth: even if the backend handed back a mismatched row, the
    // orchestration relaunches rather than handing an eval a logged-in profile.
    const f = makeFakes({
      lookups: [liveLookup({ contextMode: "ephemeral" })],
    });
    const handle = await ensureBrowserSession(f.deps, ARGS);
    expect(handle.reused).toBe(false);
    expect(f.status).not.toHaveBeenCalled();
    expect(f.boot).toHaveBeenCalled();
  });
});

describe("ensureBrowserSession — a driving agent is a busy computer", () => {
  it("touches the session row on EVERY command, not once per ensure", async () => {
    // A turn ensures once and then drives for minutes. The session sweep (30
    // min idle) reads this clock, so a long run of reads and clicks used to
    // look exactly like an abandoned box — and could be reaped mid-turn.
    const f = makeFakes({ lookups: [liveLookup()] });
    const handle = await ensureBrowserSession(f.deps, ARGS);
    const ensureTouches = f.touch.mock.calls.length;

    await handle.client.sendCommand({
      commandId: "c1",
      source: "chat",
      action: { kind: "navigate", url: "https://example.test/" },
    });
    await handle.client.sendCommand({
      commandId: "c2",
      source: "chat",
      action: { kind: "observe", mode: "url" },
    });

    const commandTouches = f.touch.mock.calls
      .slice(ensureTouches)
      .filter(([args]) => args.kind === "command");
    expect(commandTouches).toHaveLength(2);
    expect(commandTouches[0][0]).toMatchObject({ sessionId: ROW.sessionId });
  });

  it("touches the COMPUTER at most once a minute, however busy the agent is", async () => {
    // The row touch is cheap and per-command; this one crosses the control
    // plane, and an agent clicking twice a second must not turn into a
    // hundred hibernation pokes.
    const f = makeFakes({ lookups: [liveLookup()] });
    const handle = await ensureBrowserSession(f.deps, ARGS);
    for (let i = 0; i < 5; i += 1) {
      await handle.client.sendCommand({
        commandId: `c${i}`,
        source: "chat",
        action: { kind: "observe", mode: "url" },
      });
    }
    expect(f.touchActivity).toHaveBeenCalledTimes(1);
    expect(f.touchActivity).toHaveBeenCalledWith({ computerId: COMPUTER });
  });

  it("swallows a failed touch instead of leaving it unhandled", async () => {
    // Both touches are bookkeeping, and both are fired unawaited. "The command
    // still resolved" is NOT the property here — it resolves either way, so a
    // test asserting only that would pass with the `.catch` deleted. What the
    // `.catch` buys is that the rejection is HANDLED: an unawaited promise
    // that rejects takes the process down under Node's default policy, which
    // would be a control plane having a bad minute killing the server.
    const f = makeFakes({ lookups: [liveLookup()] });
    // PLAIN functions, not `vi.fn().mockRejectedValue()`. Vitest's mocks
    // attach their own handlers to returned promises to record settled
    // results, which marks every rejection as handled — so a mock here would
    // hide precisely the defect this test exists to catch.
    const failing = () => Promise.reject(new Error("convex is down"));
    (f.deps.store as unknown as { touch: unknown }).touch = failing;
    (f.deps as unknown as { touchActivity: unknown }).touchActivity = failing;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const handle = await ensureBrowserSession(f.deps, ARGS);
      await expect(
        handle.client.sendCommand({
          commandId: "c1",
          source: "chat",
          action: { kind: "observe", mode: "url" },
        }),
      ).resolves.toMatchObject({ status: "ok" });

      // Node raises `unhandledRejection` once the microtask queue has drained,
      // so give it two macrotask turns before deciding nothing was left.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("touches for a freshly booted daemon too, not only a reused one", async () => {
    // The relaunch path builds its own client from the boot handle; wrapping
    // only the reuse path would leave every new session untouched until its
    // second turn.
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    const handle = await ensureBrowserSession(f.deps, ARGS);
    f.touch.mockClear();

    await handle.client.sendCommand({
      commandId: "c1",
      source: "chat",
      action: { kind: "observe", mode: "url" },
    });
    expect(f.touch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-new", kind: "command" }),
    );
  });

  it("keeps the lease pair reachable through the wrapper", async () => {
    // The wrapper rebuilds the client method by method (a `BrowserdClient`'s
    // methods are on the prototype and would not survive a spread), so the
    // optional lease pair has to be carried across deliberately.
    const lease = new HandoffLease();
    const f = makeFakes({
      lookups: [liveLookup()],
      leaseAction: leaseBackedBy(lease),
    });
    const handle = await ensureBrowserSession(f.deps, ARGS);
    const outcome = await handle.client.leaseAction?.({
      action: "acquire",
      holder: "panel-1",
    });
    expect(outcome?.took).toBe(true);
  });
});

describe("attachBrowserSession — adopt what is running, do not replace it", () => {
  it("reuses an EPHEMERAL daemon instead of relaunching it as persistent", async () => {
    // The panel's attach names no mode; it wants "the browser on this
    // machine". Defaulting to persistent made that a mode mismatch, and a
    // mismatch is a relaunch — so opening a panel to LOOK at what was running
    // destroyed it and replaced it with a different profile.
    const f = makeFakes({
      lookups: [liveLookup({ contextMode: "ephemeral" })],
    });
    const handle = await attachBrowserSession(f.deps, { computerId: COMPUTER });

    expect(handle.reused).toBe(true);
    expect(handle.contextMode).toBe("ephemeral");
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
    expect(f.lookup).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedContextMode: "any" }),
    );
  });

  it("still boots a persistent profile when nothing is running", async () => {
    // The default this replaced was written for exactly this case, and it is
    // the right answer for a person.
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    await attachBrowserSession(f.deps, { computerId: COMPUTER });
    expect(f.boot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contextMode: "persistent" }),
    );
  });

  it("obeys an explicitly named mode over whatever is running", async () => {
    const f = makeFakes({
      lookups: [liveLookup({ contextMode: "ephemeral" })],
    });
    await attachBrowserSession(f.deps, {
      computerId: COMPUTER,
      contextMode: "persistent",
    });
    expect(f.boot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contextMode: "persistent" }),
    );
  });
});

describe("ensureBrowserSession — cross-replica boot race", () => {
  it("adopts the winner's session when its record loses the compare-and-swap", async () => {
    // Both replicas missed the row and booted. Ours records SECOND: the
    // backend refuses (the row is no longer the one we observed), so our
    // daemon — which the winner's pkill may already have reaped — must be
    // stopped, and the winner's session adopted instead of overwriting it.
    const f = makeFakes({
      lookups: [
        { reachable: true, session: null },
        // The ownership lookup, before the kill: still nothing here, so this
        // case exercises the RECORD race rather than the pre-kill one.
        { reachable: true, session: null },
        liveLookup({ bootId: "boot-winner", browserdToken: "token-winner" }),
      ],
      recordResult: { status: "conflict" },
      status: async () => ({ kind: "ok", bootId: "boot-winner" }),
    });
    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(handle.reused).toBe(true);
    expect(handle.bootId).toBe("boot-winner");
    expect(f.bootHandle.stop).toHaveBeenCalled();
    expect(f.sandbox.disconnect).toHaveBeenCalled();
  });

  it("fails loudly when it loses the race AND the winner does not verify", async () => {
    const f = makeFakes({
      lookups: [
        { reachable: true, session: null },
        { reachable: true, session: null },
        liveLookup({ bootId: "boot-winner" }),
      ],
      recordResult: { status: "conflict" },
      status: async () => ({ kind: "unhealthy", detail: "chromium exited" }),
    });
    await expect(ensureBrowserSession(f.deps, ARGS)).rejects.toThrow(
      /lost a boot race/,
    );
    expect(f.bootHandle.stop).toHaveBeenCalled();
  });

  it("falls back to the winner's verified session when its own boot fails", async () => {
    const f = makeFakes({
      lookups: [
        { reachable: true, session: null },
        { reachable: true, session: null },
        liveLookup({ bootId: "boot-winner", browserdToken: "token-winner" }),
      ],
      bootError: new Error("port already in use"),
      status: async () => ({ kind: "ok", bootId: "boot-winner" }),
    });
    const handle = await ensureBrowserSession(f.deps, ARGS);
    expect(handle.reused).toBe(true);
    expect(handle.bootId).toBe("boot-winner");
    // Three: the mode-scoped reuse lookup, the mode-agnostic ownership lookup
    // the fence takes before killing, and the post-boot-failure retry.
    expect(f.lookup).toHaveBeenCalledTimes(3);
    expect(f.sandbox.disconnect).toHaveBeenCalled();
  });

  it("adopts a winner that recorded while we were connecting, instead of reaping it", async () => {
    // Resuming a paused sandbox takes seconds, and a replica that lost none of
    // them can boot and record inside that window. Our lookup is from before
    // all that, so the daemon it names is dead — and `killBrowserd` is a
    // `pkill` on the box, which would reap the winner's BRAND NEW daemon and
    // leave their row pointing at nothing. The record CAS cannot help: it
    // fires after the kill.
    const f = makeFakes({
      lookups: [
        { reachable: true, session: null },
        // The ownership lookup is fresh, and by now the winner is recorded.
        liveLookup({ bootId: "boot-winner", browserdToken: "token-winner" }),
      ],
      status: async () => ({ kind: "ok", bootId: "boot-winner" }),
    });

    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(handle.reused).toBe(true);
    expect(handle.bootId).toBe("boot-winner");
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(f.sandbox.disconnect).toHaveBeenCalledTimes(1);
  });

  it("hands the fence back before adopting that winner", async () => {
    // The fence was taken against whatever row the ownership lookup named —
    // which in this case IS the winner's daemon. Returning a session whose
    // lease we are still holding would block the agent out of the browser we
    // just handed it.
    const lease = new HandoffLease();
    const f = makeFakes({
      lookups: [
        { reachable: true, session: null },
        liveLookup({ bootId: "boot-winner", browserdToken: "token-winner" }),
      ],
      status: async () => ({ kind: "ok", bootId: "boot-winner" }),
      leaseAction: leaseBackedBy(lease),
    });

    const handle = await ensureBrowserSession(f.deps, ARGS);
    expect(handle.bootId).toBe("boot-winner");
    expect(lease.state()).toEqual({ state: "free" });
  });

  it("rethrows the boot failure when no winner appears", async () => {
    const f = makeFakes({
      lookups: [{ reachable: true, session: null }],
      bootError: new Error("port already in use"),
    });
    await expect(ensureBrowserSession(f.deps, ARGS)).rejects.toThrow(
      "port already in use",
    );
    expect(f.sandbox.disconnect).toHaveBeenCalled();
  });
});

describe("ensureBrowserSession — per-computer serialization", () => {
  it("runs two ensures for the same computer strictly in sequence", async () => {
    const order: string[] = [];
    const f = makeFakes({ lookups: [liveLookup()] });
    const slowStatus = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push("first-end");
        return { kind: "ok", bootId: ROW.bootId };
      })
      .mockImplementation(async () => {
        order.push("second-start");
        return { kind: "ok", bootId: ROW.bootId };
      });
    (f.deps.createClient as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ status: slowStatus, sendCommand: vi.fn() }),
    );

    await Promise.all([
      ensureBrowserSession(f.deps, ARGS),
      ensureBrowserSession(f.deps, ARGS),
    ]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });
});

describe("ensureBrowserSession — the caller went away (review follow-up)", () => {
  it("does NOT kill and reboot a live daemon because the lookup was aborted", async () => {
    // An aborted lookup returns `{reachable:false, session:null}` — the client
    // never throws — which is indistinguishable from "there is no session".
    // Acting on that would let a cancelled chat turn take down a durable
    // daemon that is serving someone else perfectly well.
    const controller = new AbortController();
    const f = makeFakes({
      lookups: [{ reachable: false, session: null }],
    });
    controller.abort();

    await expect(
      ensureBrowserSession(f.deps, { ...ARGS, signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);

    expect(f.connect).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
  });

  it("still relaunches normally when nothing was aborted", async () => {
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    const handle = await ensureBrowserSession(f.deps, ARGS);
    expect(handle.reused).toBe(false);
    expect(f.boot).toHaveBeenCalledOnce();
  });
});
