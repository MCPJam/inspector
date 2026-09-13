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
import { BROWSERD_PROTOCOL_VERSION } from "../protocol";
import { BrowserProtocolMismatchError } from "../browser-session";
import { logger } from "../../../utils/logger.js";
import type {
  BrowserSessionLookup,
  BrowserSessionRecordResult,
  ComputerBrowserSessionRecord,
  SandboxBrowserSessionRecord,
} from "../browser-sessions-client";
import {
  attachBrowserSession,
  BROWSERD_PORT,
  BROWSERD_SCRIPT_PATH,
  BROWSERD_USER_DATA_DIR,
  BrowserSessionInUseError,
  BrowserSessionTargetError,
  ensureBrowserSession,
  type BrowserSessionDeps,
  type SessionClient,
  type SessionSandbox,
} from "../browser-session";
import { resetActivityThrottleForTests } from "../../../utils/computers/activity-touch.js";

const COMPUTER = "computer-1";
const HASH = "bundle-hash-1";
const SANDBOX_ROW = "sbxrow-1";
const SANDBOX_ID = "sbx-1";
const ROW = {
  target: "computer" as const,
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

/** The same row on a per-run box: no computer, and no stream at all. */
const SANDBOX_SESSION = {
  target: "sandbox" as const,
  sessionId: "session-sbx",
  sandboxRowId: SANDBOX_ROW,
  bootId: "boot-old",
  browserdToken: "token-old",
  browserdPort: 8791,
  publicOrigin: "https://old.example",
  bundleHash: HASH,
  contextMode: "ephemeral" as const,
};

function liveLookup(
  over?: Partial<ComputerBrowserSessionRecord>,
): BrowserSessionLookup {
  const session = { ...ROW, ...over };
  return {
    reachable: true,
    session,
    observedSessionId: session.sessionId,
  };
}

function liveSandboxLookup(
  over?: Partial<SandboxBrowserSessionRecord>,
): BrowserSessionLookup {
  const session = { ...SANDBOX_SESSION, ...over };
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
    // The ready line announces the wire, and the row records it — so a later
    // lookup can answer "can I talk to it?" without a probe.
    protocolVersion: BROWSERD_PROTOCOL_VERSION,
    stop: vi.fn(async () => {}),
  };

  const sandbox = {
    writeBundle: vi.fn(async () => {}),
    browserd: {
      runBackground: async () => ({
        kill: async () => {},
        wait: async () => {},
      }),
      // The display probe `bootBrowserd` runs first; 0 means "already up".
      run: async () => ({ exitCode: 0 }),
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
        // A daemon that cannot prove which wire it speaks is not reusable
        // (V-4a), so every healthy fake announces the current one. The
        // `protocolVersion`-less cases have their own tests below.
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
        bundleHash: HASH,
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
    // Cast: the real store's `lookup`/`record` are OVERLOADED per target, and a
    // single-signature spy cannot satisfy both arms. The cases below drive the
    // production entry points, which are where the target types are checked.
    store: {
      lookup,
      record,
      touch,
      claimRelaunch,
      releaseRelaunch,
    } as unknown as BrowserSessionDeps["store"],
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
      status: async () => ({
        kind: "ok",
        bootId: "boot-someone-else",
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
        bundleHash: HASH,
      }),
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
          : {
              kind: "ok",
              bootId: ROW.bootId,
              protocolVersion: BROWSERD_PROTOCOL_VERSION,
              bundleHash: HASH,
            };
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

    // Driven through the ATTACH, which is the surface that still names an
    // ephemeral mode on a computer: `ensureBrowserSession` now refuses one
    // outright, and the ownership question this pins is the same either way.
    await expect(
      attachBrowserSession(f.deps, {
        computerId: COMPUTER,
        contextMode: "ephemeral",
      }),
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
        stream: {
          url: "https://stream-new.example/vnc.html",
          password: "pw-stream",
        },
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
  it("REFUSES ephemeral on a computer target, before reserving anything", async () => {
    // There is one hosted computer per (project, member), so an ephemeral
    // session on it would be shared by every unattended run in the project —
    // one profile, one cookie jar — and the mode mismatch against a persistent
    // daemon relaunches it, pkilling the Chromium a person may be using. The
    // refusal lands BEFORE `reserveDesktop`, so nothing is provisioned on the
    // way to the error.
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    await expect(
      ensureBrowserSession(f.deps, { ...ARGS, contextMode: "ephemeral" }),
    ).rejects.toMatchObject({ code: "ephemeral_requires_sandbox" });

    expect(f.deps.reserveDesktop).not.toHaveBeenCalled();
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
  });

  it("throws BrowserSessionTargetError, not a bare Error", async () => {
    const f = makeFakes();
    await expect(
      ensureBrowserSession(f.deps, { ...ARGS, contextMode: "ephemeral" }),
    ).rejects.toBeInstanceOf(BrowserSessionTargetError);
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
      status: async () => ({
        kind: "ok",
        bootId: "boot-winner",
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
        bundleHash: HASH,
      }),
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
      status: async () => ({
        kind: "ok",
        bootId: "boot-winner",
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
        bundleHash: HASH,
      }),
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
      status: async () => ({
        kind: "ok",
        bootId: "boot-winner",
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
        bundleHash: HASH,
      }),
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
      status: async () => ({
        kind: "ok",
        bootId: "boot-winner",
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
        bundleHash: HASH,
      }),
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

describe("ensureBrowserSession — sandbox target", () => {
  const SANDBOX_ARGS = {
    ...ARGS,
    contextMode: "ephemeral" as const,
    target: {
      kind: "sandbox" as const,
      sandboxRowId: SANDBOX_ROW,
      sandboxId: SANDBOX_ID,
    },
  };

  it("boots on the run's OWN box: no reserve, no lease, no stream", async () => {
    // Everything this path skips is a decision, not an omission. The box is
    // already provisioned (so nothing reserves or bills), one run owns it (so
    // there is no relaunch claim and no lease to fence), and nobody is
    // watching (so no stream is started and none is recorded).
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    const handle = await ensureBrowserSession(f.deps, SANDBOX_ARGS);

    expect(handle.target).toBe("sandbox");
    expect(handle.sandboxRowId).toBe(SANDBOX_ROW);
    expect(handle.sandboxId).toBe(SANDBOX_ID);
    expect(handle.contextMode).toBe("ephemeral");
    expect(handle.reused).toBe(false);

    expect(f.deps.reserveDesktop).not.toHaveBeenCalled();
    expect(f.deps.resolveSandboxId).not.toHaveBeenCalled();
    expect(f.sandbox.ensureStream).not.toHaveBeenCalled();
    expect(f.claimRelaunch).not.toHaveBeenCalled();
    // The vendor id came straight from the caller.
    expect(f.connect).toHaveBeenCalledWith(SANDBOX_ID);
    expect(f.boot).toHaveBeenCalledWith(
      f.sandbox.browserd,
      expect.objectContaining({ contextMode: "ephemeral" }),
    );
    // Recorded against the ROW, with no stream fields at all.
    const recorded = f.record.mock.calls[0]![0];
    expect(recorded).toMatchObject({
      sandboxRowId: SANDBOX_ROW,
      contextMode: "ephemeral",
    });
    expect(recorded).not.toHaveProperty("computerId");
    expect(recorded).not.toHaveProperty("stream");
  });

  it("protects a watched Playground sandbox with the relaunch claim and stream", async () => {
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    const handle = await ensureBrowserSession(f.deps, {
      ...SANDBOX_ARGS,
      contextMode: "persistent",
      target: { ...SANDBOX_ARGS.target, watched: true },
    });

    expect(handle.target).toBe("sandbox");
    expect(handle.watched).toBe(true);
    expect(f.claimRelaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxRowId: SANDBOX_ROW,
        watched: true,
        claimId: expect.any(String),
      }),
    );
    expect(f.releaseRelaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxRowId: SANDBOX_ROW,
        watched: true,
        claimId: f.claimRelaunch.mock.calls[0]![0].claimId,
      }),
    );
    expect(f.sandbox.ensureStream).toHaveBeenCalledTimes(1);
    expect(f.record.mock.calls[0]![0]).toMatchObject({
      sandboxRowId: SANDBOX_ROW,
      watched: true,
      stream: { url: expect.any(String), password: expect.any(String) },
    });
  });

  it("reuses a verified daemon with zero sandbox I/O", async () => {
    const f = makeFakes({
      lookups: [liveSandboxLookup()],
      // ANNOUNCES ITS WIRE, like every healthy fake on the computer path: a
      // daemon that cannot prove which protocol it speaks is not reusable on
      // EITHER target. The mismatch case has its own test below.
      status: async () => ({
        kind: "ok",
        bootId: SANDBOX_SESSION.bootId,
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
      }),
    });
    const handle = await ensureBrowserSession(f.deps, SANDBOX_ARGS);

    expect(handle.reused).toBe(true);
    expect(handle.bootId).toBe(SANDBOX_SESSION.bootId);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(f.lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxRowId: SANDBOX_ROW,
        expectedContextMode: "ephemeral",
      }),
    );
  });

  it("never boots or kills while attaching a missing watched boot", async () => {
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    await expect(
      ensureBrowserSession(f.deps, {
        ...SANDBOX_ARGS,
        contextMode: "persistent",
        target: { ...SANDBOX_ARGS.target, watched: true },
        expectedExistingBootId: "saved-boot",
      }),
    ).rejects.toThrow(/not ready/);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(f.deps.reserveDesktop).not.toHaveBeenCalled();
  });

  it("does NOT reuse a daemon whose bootId has moved", async () => {
    const f = makeFakes({
      lookups: [liveSandboxLookup()],
      status: async () => ({ kind: "ok", bootId: "boot-somebody-else" }),
    });
    const handle = await ensureBrowserSession(f.deps, SANDBOX_ARGS);
    expect(handle.reused).toBe(false);
    expect(f.boot).toHaveBeenCalled();
  });

  it("REFUSES a persistent profile on a box that dies with the run", async () => {
    const f = makeFakes();
    await expect(
      ensureBrowserSession(f.deps, {
        ...SANDBOX_ARGS,
        contextMode: "persistent",
      } as never),
    ).rejects.toMatchObject({ code: "persistent_requires_computer" });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("refuses an unsupported target BEFORE connecting or booting", async () => {
    // A backend that predates sandbox-target sessions will refuse the record
    // too, so booting first would pay a cold DESKTOP boot — the most expensive
    // thing on this path — on every attempt, to reach the same failure.
    const f = makeFakes({
      lookups: [{ reachable: true, unsupportedTarget: true, session: null }],
    });
    await expect(
      ensureBrowserSession(f.deps, SANDBOX_ARGS),
    ).rejects.toMatchObject({ code: "unsupported_target" });

    expect(f.connect).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
  });

  it("stops its own daemon when the control plane refuses the record shape", async () => {
    // The same refusal arriving at RECORD time (a backend that answers the
    // lookup but not the write). A daemon nothing can address must not be left
    // running on a box that will be billed until the run ends.
    const f = makeFakes({
      lookups: [{ reachable: true, session: null }],
      recordResult: { status: "unsupported_target" },
    });
    await expect(
      ensureBrowserSession(f.deps, SANDBOX_ARGS),
    ).rejects.toMatchObject({ code: "unsupported_target" });
    expect(f.bootHandle.stop).toHaveBeenCalled();
    expect(f.sandbox.disconnect).toHaveBeenCalled();
  });

  /**
   * The sandbox arm refuses a mismatched wire too.
   *
   * It did not, and the asymmetry was invisible because the failure arrived
   * somewhere else entirely: the daemon's per-command gate refused each
   * stamped command with `protocol_mismatch`, so the session LOOKED broken in
   * a named way. But nothing on this path ever decided the daemon was
   * unusable, so `ensureBrowserSession` handed the same incompatible one back
   * on the next turn and the next — the relaunch this mechanism exists to
   * trigger never happened, and a per-run browser stayed stuck until its
   * sandbox died.
   */
  it("does NOT reuse a sandbox daemon on a different wire", async () => {
    const f = makeFakes({
      lookups: [liveSandboxLookup()],
      status: async () => ({
        kind: "ok",
        bootId: SANDBOX_SESSION.bootId,
        protocolVersion: BROWSERD_PROTOCOL_VERSION + 1,
      }),
    });
    const handle = await ensureBrowserSession(f.deps, SANDBOX_ARGS);
    // RELAUNCHED, which is the whole point: a fresh boot on the current wire.
    expect(handle.reused).toBe(false);
    expect(f.boot).toHaveBeenCalled();
    expect(f.sandbox.killBrowserd).toHaveBeenCalled();
  });

  it("does NOT reuse a sandbox daemon that cannot say which wire it speaks", async () => {
    // An older daemon announces nothing. Unproven is not the same as
    // compatible — continuing would produce wrong answers rather than merely
    // old ones, which is the case the version number exists for.
    const f = makeFakes({
      lookups: [liveSandboxLookup()],
      status: async () => ({ kind: "ok", bootId: SANDBOX_SESSION.bootId }),
    });
    expect((await ensureBrowserSession(f.deps, SANDBOX_ARGS)).reused).toBe(
      false,
    );
    expect(f.boot).toHaveBeenCalled();
  });

  it("adopts a winner that appeared while we were connecting, WITHOUT killing it", async () => {
    // `killBrowserd` is a pkill on the box, so it would reap a daemon somebody
    // booted during our connect and leave their row addressing nothing — and
    // the record CAS cannot repair that, because it fires after the kill and
    // the damage IS the kill. Hence the re-read immediately before it.
    const f = makeFakes({
      lookups: [
        { reachable: true, session: null },
        liveSandboxLookup({ bootId: "boot-winner" }),
      ],
      status: async () => ({
        kind: "ok",
        bootId: "boot-winner",
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
      }),
    });
    const handle = await ensureBrowserSession(f.deps, SANDBOX_ARGS);
    expect(handle.reused).toBe(true);
    expect(handle.bootId).toBe("boot-winner");
    // The whole point: their daemon survives, and we never paid the boot.
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
  });

  it("adopts the winner when its record loses the compare-and-swap", async () => {
    // The record CAS is the cross-replica backstop of last resort on this path
    // — there is no claim and no fence — so it has to still work when the
    // winner appears too late for the pre-kill re-read to see it.
    const f = makeFakes({
      lookups: [
        { reachable: true, session: null },
        { reachable: true, session: null },
        liveSandboxLookup({ bootId: "boot-winner" }),
      ],
      recordResult: { status: "conflict" },
      status: async () => ({
        kind: "ok",
        bootId: "boot-winner",
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
      }),
    });
    const handle = await ensureBrowserSession(f.deps, SANDBOX_ARGS);
    expect(handle.reused).toBe(true);
    expect(handle.bootId).toBe("boot-winner");
    expect(f.bootHandle.stop).toHaveBeenCalled();
  });

  it("serializes two ensures of ONE row, and runs two rows concurrently", async () => {
    const order: string[] = [];
    const slowStatus = (label: string) =>
      vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push(`${label}-start`);
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push(`${label}-end`);
          return {
            kind: "ok",
            bootId: SANDBOX_SESSION.bootId,
            protocolVersion: BROWSERD_PROTOCOL_VERSION,
          };
        })
        .mockImplementation(async () => {
          order.push(`${label}-second`);
          return {
            kind: "ok",
            bootId: SANDBOX_SESSION.bootId,
            protocolVersion: BROWSERD_PROTOCOL_VERSION,
          };
        });

    const statusA = slowStatus("row-a");
    const one = makeFakes({ lookups: [liveSandboxLookup()] });
    (one.deps.createClient as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ status: statusA, sendCommand: vi.fn() }),
    );
    await Promise.all([
      ensureBrowserSession(one.deps, SANDBOX_ARGS),
      ensureBrowserSession(one.deps, SANDBOX_ARGS),
    ]);
    // Same row ⇒ strictly in sequence (one fixed port, one daemon per box).
    expect(order).toEqual(["row-a-start", "row-a-end", "row-a-second"]);

    // A DIFFERENT row must not wait behind it: two iterations of one eval run
    // concurrently, which is the whole point of a box per run.
    //
    // Row A gets a FRESH slow status here. Reusing the one above would leave
    // its `mockImplementationOnce` already spent, so row A would resolve
    // instantly and the interleaving this half exists to prove would look
    // identical under a single global lock.
    order.length = 0;
    const statusA2 = slowStatus("row-a");
    const oneAgain = makeFakes({ lookups: [liveSandboxLookup()] });
    (oneAgain.deps.createClient as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ status: statusA2, sendCommand: vi.fn() }),
    );
    const statusB = slowStatus("row-b");
    const two = makeFakes({
      lookups: [liveSandboxLookup({ sandboxRowId: "sbxrow-2" })],
    });
    (two.deps.createClient as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ status: statusB, sendCommand: vi.fn() }),
    );
    await Promise.all([
      ensureBrowserSession(oneAgain.deps, SANDBOX_ARGS),
      ensureBrowserSession(two.deps, {
        ...SANDBOX_ARGS,
        target: {
          kind: "sandbox" as const,
          sandboxRowId: "sbxrow-2",
          sandboxId: "sbx-2",
        },
      }),
    ]);
    // THE assertion that separates a keyed lock from a global one: row B got
    // in while row A was still holding. A single lock would order these
    // ["row-a-start", "row-a-end", "row-b-start", "row-b-end"].
    expect(order.indexOf("row-b-start")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("row-b-start")).toBeLessThan(
      order.indexOf("row-a-end"),
    );
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
        return {
          kind: "ok",
          bootId: ROW.bootId,
          protocolVersion: BROWSERD_PROTOCOL_VERSION,
          bundleHash: HASH,
        };
      })
      .mockImplementation(async () => {
        order.push("second-start");
        return {
          kind: "ok",
          bootId: ROW.bootId,
          protocolVersion: BROWSERD_PROTOCOL_VERSION,
          bundleHash: HASH,
        };
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

/**
 * V-4a. The bundle hash used to be an admission test, and every daemon edit
 * rotates it — so a deploy carrying a comment change killed every live hosted
 * browser mid-use, including one somebody was typing a password into. The wire
 * version is the admission test now; the hash is an upgrade, taken when nobody
 * is looking.
 */
describe("ensureBrowserSession — compatibility and the lazy upgrade", () => {
  const IDLE = {
    lease: "free" as const,
    watchers: 0,
    msSinceActivity: 10 * 60_000,
  };
  const BUSY = { lease: "held" as const, watchers: 1, msSinceActivity: 0 };

  it("reuses a daemon whose bytes moved but whose wire did not", async () => {
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({
        kind: "ok",
        bootId: ROW.bootId,
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
        // A DIFFERENT bundle: this is the deploy that used to kill the session.
        bundleHash: "hash-from-two-deploys-ago",
        ...BUSY,
      }),
    });

    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(handle.reused).toBe(true);
    expect(handle.upgradeAvailable).toBe(true);
    // Nothing touched the sandbox: no kill, no boot, no bootId rotation.
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(handle.bootId).toBe(ROW.bootId);
  });

  it("takes the upgrade the moment nothing is using the browser", async () => {
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({
        kind: "ok",
        bootId: ROW.bootId,
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
        bundleHash: "hash-from-two-deploys-ago",
        ...IDLE,
      }),
    });

    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(f.boot).toHaveBeenCalled();
    expect(handle.reused).toBe(false);
  });

  it("waits when ANY idle fact is unknown", async () => {
    // A daemon too old to report `watchers` answers undefined, and reading
    // undefined as "nobody is watching" would relaunch a browser somebody has
    // open — the exact behaviour this step removes.
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({
        kind: "ok",
        bootId: ROW.bootId,
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
        bundleHash: "hash-from-two-deploys-ago",
        lease: "free" as const,
      }),
    });

    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(handle.reused).toBe(true);
    expect(handle.upgradeAvailable).toBe(true);
    expect(f.boot).not.toHaveBeenCalled();
  });

  it("relaunches NOW when the wire itself changed", async () => {
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({
        kind: "ok",
        bootId: ROW.bootId,
        protocolVersion: BROWSERD_PROTOCOL_VERSION + 1,
        bundleHash: HASH,
        ...BUSY,
      }),
    });

    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(f.boot).toHaveBeenCalled();
    expect(handle.reused).toBe(false);
  });

  it("logs a structured protocol_mismatch event when the wire changed and it relaunches", async () => {
    // The relaunch itself is unchanged and stays silent to the caller. What
    // was missing is any record that it happened for THIS reason: three gates
    // refuse on the wire by returning `null`, and a `null` carries nothing.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const f = makeFakes({
        lookups: [liveLookup()],
        status: async () => ({
          kind: "ok",
          bootId: ROW.bootId,
          protocolVersion: BROWSERD_PROTOCOL_VERSION + 1,
          bundleHash: HASH,
          ...BUSY,
        }),
      });
      const handle = await ensureBrowserSession(f.deps, ARGS);
      expect(handle.reused).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        "[browser-session] browser.protocol_mismatch",
        expect.objectContaining({
          expected: BROWSERD_PROTOCOL_VERSION,
          running: BROWSERD_PROTOCOL_VERSION + 1,
          source: "reuse",
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not log a mismatch event when the versions match", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const f = makeFakes({ lookups: [liveLookup()] });
      await ensureBrowserSession(f.deps, ARGS);
      expect(warn).not.toHaveBeenCalledWith(
        "[browser-session] browser.protocol_mismatch",
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("throws BrowserProtocolMismatchError naming both versions when the relaunch fails", async () => {
    // What the user used to see here: `browserd did not report listening
    // within 30000ms` — a timeout from a boot that had nothing to do with the
    // cause, and nothing anywhere naming the wire.
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({
        kind: "ok",
        bootId: ROW.bootId,
        protocolVersion: BROWSERD_PROTOCOL_VERSION + 1,
        bundleHash: HASH,
        ...BUSY,
      }),
      bootError: new Error("browserd did not report listening within 30000ms"),
    });

    const error = await ensureBrowserSession(f.deps, ARGS).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(BrowserProtocolMismatchError);
    const mismatch = error as BrowserProtocolMismatchError;
    expect(mismatch.code).toBe("protocol_mismatch");
    expect(mismatch.expected).toBe(BROWSERD_PROTOCOL_VERSION);
    expect(mismatch.running).toBe(BROWSERD_PROTOCOL_VERSION + 1);
    // Prefixed with the code so `parseBrowserdErrorCode` reads it back.
    expect(mismatch.message.startsWith("protocol_mismatch:")).toBe(true);
    expect(mismatch.message).toContain(String(BROWSERD_PROTOCOL_VERSION));
    expect(mismatch.message).toContain(mismatch.hint);
  });

  it("rethrows the PUBLICATION error when the replacement daemon did come up", async () => {
    // The mismatch is RECOVERED here: a daemon on the expected wire is
    // running, and what failed afterwards — the stream, the row, the logical
    // boot — has nothing to do with the protocol. Naming the wire would report
    // a solved problem as the cause of a live one, and dress a transient
    // failure as the single thing a retry cannot fix.
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({
        kind: "ok",
        bootId: ROW.bootId,
        protocolVersion: BROWSERD_PROTOCOL_VERSION + 1,
        bundleHash: HASH,
        ...BUSY,
      }),
      streamError: new Error("the stream would not start"),
    });

    const error = await ensureBrowserSession(f.deps, ARGS).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).not.toBeInstanceOf(BrowserProtocolMismatchError);
    expect((error as Error).message).toBe("the stream would not start");
  });

  it("rethrows the raw boot error when the relaunch fails with no mismatch observed", async () => {
    // The other half, and the one that keeps this from becoming a wrapper that
    // hides real faults: a boot that failed for its own reasons must keep
    // reporting its own reason.
    const f = makeFakes({
      lookups: [{ reachable: true, session: null }],
      bootError: new Error("chromium would not start"),
    });

    const error = await ensureBrowserSession(f.deps, ARGS).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).not.toBeInstanceOf(BrowserProtocolMismatchError);
    expect((error as Error).message).toBe("chromium would not start");
  });

  it("records a mismatch the CONTROL PLANE saw, without ever reaching the daemon", async () => {
    // `stale: "protocol_changed"` has been parsed off the wire since V-4a and
    // read by nothing. The relaunch was already right; the reason was lost.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const f = makeFakes({
        lookups: [
          {
            reachable: true,
            session: null,
            stale: "protocol_changed",
            observedSessionId: ROW.sessionId,
          },
        ],
        bootError: new Error("browserd did not report listening within 30000ms"),
      });
      const error = await ensureBrowserSession(f.deps, ARGS).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(BrowserProtocolMismatchError);
      expect((error as BrowserProtocolMismatchError).stale).toBe(
        "protocol_changed",
      );
      expect(warn).toHaveBeenCalledWith(
        "[browser-session] browser.protocol_mismatch",
        expect.objectContaining({ source: "lookup" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("relaunches a daemon too old to say which wire it speaks", async () => {
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "ok", bootId: ROW.bootId }),
    });

    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(f.boot).toHaveBeenCalled();
    expect(handle.reused).toBe(false);
  });

  it("asks the control plane about the WIRE, not the bytes", async () => {
    const f = makeFakes({ lookups: [liveLookup()] });
    await ensureBrowserSession(f.deps, ARGS);
    expect(f.lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedProtocolVersion: BROWSERD_PROTOCOL_VERSION,
      }),
    );
  });

  it("records the wire version with a freshly booted daemon", async () => {
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    await ensureBrowserSession(f.deps, ARGS);
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({ protocolVersion: BROWSERD_PROTOCOL_VERSION }),
    );
  });

  it("the kill switch restores relaunch-on-hash", async () => {
    process.env.MCPJAM_BROWSER_LAZY_UPGRADE = "false";
    try {
      const f = makeFakes({
        lookups: [liveLookup()],
        status: async () => ({
          kind: "ok",
          bootId: ROW.bootId,
          protocolVersion: BROWSERD_PROTOCOL_VERSION,
          bundleHash: "hash-from-two-deploys-ago",
          ...BUSY,
        }),
      });

      const handle = await ensureBrowserSession(f.deps, ARGS);

      // Off, the hash is not consulted at all and the row (whose hash the
      // backend matched) is reused exactly as it was before V-4a.
      expect(handle.reused).toBe(true);
      expect(handle.upgradeAvailable).toBeUndefined();
      expect(f.lookup).not.toHaveBeenCalledWith(
        expect.objectContaining({
          expectedProtocolVersion: BROWSERD_PROTOCOL_VERSION,
        }),
      );
    } finally {
      delete process.env.MCPJAM_BROWSER_LAZY_UPGRADE;
    }
  });
});

/**
 * V-8. The desktop image starts browserd itself, so on a fresh box there is a
 * healthy daemon listening before any inspector has done anything — and the
 * whole relaunch (kill, upload, boot Chromium) would replace it with an
 * identical one several seconds later.
 *
 * Every refusal below costs one round trip and saves a relaunch; every one of
 * them exists because adopting a daemon that cannot prove what it is would be
 * worse than a cold start.
 */
describe("ensureBrowserSession — adopting a daemon the box started", () => {
  const PRELAUNCHED = {
    kind: "ok" as const,
    bootId: "boot-baked",
    protocolVersion: BROWSERD_PROTOCOL_VERSION,
    bundleHash: HASH,
    contextMode: "persistent" as const,
    startedBy: "prelaunch" as const,
  };

  function withPrelaunched(over: Record<string, unknown> = {}) {
    const f = makeFakes({
      lookups: [{ reachable: true, session: null }],
      status: async () => ({ ...PRELAUNCHED, ...over }),
    });
    f.sandbox.readTextFile = vi.fn(async () => "baked-token");
    return f;
  }

  it("adopts one, without killing or booting anything", async () => {
    const f = withPrelaunched();
    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(handle.reused).toBe(true);
    expect(handle.bootId).toBe("boot-baked");
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    // And it is RECORDED, or no other replica could ever find it.
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({
        bootId: "boot-baked",
        browserdToken: "baked-token",
        protocolVersion: BROWSERD_PROTOCOL_VERSION,
      }),
    );
  });

  it("refuses a daemon an INSPECTOR booted", async () => {
    // One an inspector booted has a row of its own; adopting it here would
    // write a second row for the same process under a token the first does
    // not know.
    const f = withPrelaunched({ startedBy: "inspector" });
    await ensureBrowserSession(f.deps, ARGS);
    expect(f.boot).toHaveBeenCalled();
  });

  it("refuses one that speaks a different wire", async () => {
    const f = withPrelaunched({
      protocolVersion: BROWSERD_PROTOCOL_VERSION + 1,
    });
    await ensureBrowserSession(f.deps, ARGS);
    expect(f.boot).toHaveBeenCalled();
  });

  it("refuses one running the other profile mode", async () => {
    // Its browser state is the wrong kind: a persistent profile's cookies for
    // an eval, or an ephemeral one's blank slate for a signed-in user.
    const f = withPrelaunched({ contextMode: "ephemeral" });
    await ensureBrowserSession(f.deps, ARGS);
    expect(f.boot).toHaveBeenCalled();
  });

  it("boots when there is no token file to read", async () => {
    // An image that predates prelaunch. Every ensure on it takes this path.
    const f = makeFakes({ lookups: [{ reachable: true, session: null }] });
    f.sandbox.readTextFile = vi.fn(async () => undefined);
    await ensureBrowserSession(f.deps, ARGS);
    expect(f.boot).toHaveBeenCalled();
  });

  it("boots when the token does not open the daemon", async () => {
    // A stale file next to a daemon that has since restarted.
    const f = makeFakes({
      lookups: [{ reachable: true, session: null }],
      status: async () => ({ kind: "unauthorized" as const }),
    });
    f.sandbox.readTextFile = vi.fn(async () => "stale-token");
    await ensureBrowserSession(f.deps, ARGS);
    expect(f.boot).toHaveBeenCalled();
  });

  it("marks a baked daemon running old bytes as upgradeable", async () => {
    // Baked bytes ARE old bytes by design: the image pins a commit. The lazy
    // upgrade replaces it the first moment nobody is looking, rather than
    // spending a relaunch on a fresh box that is working perfectly.
    const f = withPrelaunched({ bundleHash: "hash-from-the-image" });
    const handle = await ensureBrowserSession(f.deps, ARGS);
    expect(handle.upgradeAvailable).toBe(true);
    expect(f.boot).not.toHaveBeenCalled();
  });

  it("the kill switch skips adoption entirely", async () => {
    process.env.MCPJAM_BROWSER_PRELAUNCH_ADOPT = "false";
    try {
      const f = withPrelaunched();
      await ensureBrowserSession(f.deps, ARGS);
      expect(f.boot).toHaveBeenCalled();
      expect(f.sandbox.readTextFile).not.toHaveBeenCalled();
    } finally {
      delete process.env.MCPJAM_BROWSER_PRELAUNCH_ADOPT;
    }
  });

  it("falls through when another replica recorded first", async () => {
    // Their row describes this same daemon or a newer one; re-reading and
    // verifying is a better answer than guessing here.
    const f = withPrelaunched();
    f.record.mockResolvedValue({ status: "conflict" } as never);
    await ensureBrowserSession(f.deps, ARGS).catch(() => {});
    expect(f.boot).toHaveBeenCalled();
  });
});

/**
 * R-3. Capabilities survive the client rebuild.
 *
 * `withActivityTouches` wraps every hosted client and rebuilds it METHOD BY
 * METHOD — a `BrowserdClient` instance keeps its methods on the prototype, so
 * a spread would drop all of them. That makes the wrapper a place where a
 * capability added to the client and not added there silently stops existing
 * at every hosted call site, with nothing in a log to say so. For recording
 * that is a run that quietly leaves no evidence.
 */
describe("ensureBrowserSession — the activity wrapper forwards every capability", () => {
  const recordingClient = () => {
    const record = vi.fn(async () => ({ ok: true as const }));
    const recordStatus = vi.fn(async () => ({ active: false }));
    return { record, recordStatus };
  };

  it("forwards record and recordStatus to the wrapped client", async () => {
    const spies = recordingClient();
    const f = makeFakes({ lookups: [liveLookup()] });
    (f.deps.createClient as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({
        status: async () =>
          ({
            kind: "ok",
            bootId: ROW.bootId,
            protocolVersion: BROWSERD_PROTOCOL_VERSION,
            bundleHash: HASH,
          } as BrowserdStatus),
        sendCommand: async () => ({ kind: "ok" } as never),
        ...spies,
      }),
    );

    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(handle.client.record).toBeTypeOf("function");
    expect(handle.client.recordStatus).toBeTypeOf("function");
    await handle.client.record!({ action: "start", id: "run-1", fps: 15 });
    await handle.client.recordStatus!();
    // Delegated, not reimplemented: the wrapper adds touches, not behaviour.
    expect(spies.record).toHaveBeenCalledWith({
      action: "start",
      id: "run-1",
      fps: 15,
    });
    expect(spies.recordStatus).toHaveBeenCalledTimes(1);
  });

  /**
   * …AND SO DO THE ARGUMENTS, which is the other half of the same lesson.
   *
   * The block above protects capabilities — a METHOD the wrapper forgot to
   * rebuild. This protects the arguments of the one method it does rebuild by
   * hand. `sendCommand` was written `(command, expectedBootId)` and called
   * `client.sendCommand(command, expectedBootId)`, so a third argument added
   * later was dropped on every hosted call with nothing in a log to say so.
   *
   * That happened with the abort signal: a cancelled turn went on holding a
   * lease read nobody was waiting for, and the per-command timeout was lost
   * the same way.
   */
  it("forwards the third argument of sendCommand, not just the first two", async () => {
    const sendCommand = vi.fn(async () => ({ kind: "ok" }) as never);
    const f = makeFakes({ lookups: [liveLookup()] });
    (f.deps.createClient as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({
        status: async () =>
          ({
            kind: "ok",
            bootId: ROW.bootId,
            protocolVersion: BROWSERD_PROTOCOL_VERSION,
            bundleHash: HASH,
          }) as BrowserdStatus,
        sendCommand,
      }),
    );

    const handle = await ensureBrowserSession(f.deps, ARGS);
    const controller = new AbortController();
    const options = {
      signal: controller.signal,
      timeoutMs: 1234,
    };
    await handle.client.sendCommand(
      { commandId: "c1", source: "chat", action: { kind: "reload" } },
      "boot-old",
      options,
    );

    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: "c1" }),
      "boot-old",
      options,
    );
  });

  it("forwards exportProfile too", async () => {
    // The capability this describe block exists to protect, and the one that
    // was actually dropped: without forwarding, a daemon that CAN export a
    // profile reaches the panel looking like one that cannot, and the route
    // answers `profile_export_unavailable` on a perfectly good browser.
    const exportProfile = vi.fn(async () => new Uint8Array([7, 8, 9]));
    const f = makeFakes({ lookups: [liveLookup()] });
    (f.deps.createClient as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({
        status: async () =>
          ({
            kind: "ok",
            bootId: ROW.bootId,
            protocolVersion: BROWSERD_PROTOCOL_VERSION,
            bundleHash: HASH,
          } as BrowserdStatus),
        sendCommand: async () => ({ kind: "ok" } as never),
        exportProfile,
      }),
    );

    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(handle.client.exportProfile).toBeTypeOf("function");
    await expect(handle.client.exportProfile!()).resolves.toEqual(
      new Uint8Array([7, 8, 9]),
    );
    expect(exportProfile).toHaveBeenCalledTimes(1);
  });

  it("does not invent a capability the client lacks", async () => {
    // The other half of the contract: forwarding is conditional, so a daemon
    // that genuinely cannot export must still report that honestly rather than
    // get a wrapper method that throws when called.
    const f = makeFakes({ lookups: [liveLookup()] });
    (f.deps.createClient as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({
        status: async () =>
          ({
            kind: "ok",
            bootId: ROW.bootId,
            protocolVersion: BROWSERD_PROTOCOL_VERSION,
            bundleHash: HASH,
          } as BrowserdStatus),
        sendCommand: async () => ({ kind: "ok" } as never),
      }),
    );

    const handle = await ensureBrowserSession(f.deps, ARGS);

    expect(handle.client.exportProfile).toBeUndefined();
  });

  it("omits them entirely for a client that has neither", async () => {
    // Absent, not present-and-throwing: the caller gates on the method
    // existing, exactly as it does for `lease`.
    const f = makeFakes({ lookups: [liveLookup()] });
    const handle = await ensureBrowserSession(f.deps, ARGS);
    expect(handle.client.record).toBeUndefined();
    expect(handle.client.recordStatus).toBeUndefined();
  });
});
