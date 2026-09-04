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
import { describe, expect, it, vi } from "vitest";
import type { BrowserdHandle } from "../boot-browserd";
import type { BrowserdStatus } from "../browserd-client";
import type {
  BrowserSessionLookup,
  BrowserSessionRecord,
  BrowserSessionRecordResult,
} from "../browser-sessions-client";
import {
  BROWSERD_PORT,
  BROWSERD_SCRIPT_PATH,
  BROWSERD_USER_DATA_DIR,
  ensureBrowserSession,
  type BrowserSessionDeps,
  type SessionSandbox,
} from "../browser-session";

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
  lookup: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  touch: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}

function makeFakes(over?: {
  lookups?: BrowserSessionLookup[];
  status?: () => Promise<BrowserdStatus>;
  /** The daemon's lease, when a test needs the relaunch to see one. */
  lease?: () => Promise<{ state: "free" | "held" | "parked"; holder?: string }>;
  recordResult?: BrowserSessionRecordResult;
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
      sendCommand: vi.fn(async () => {
        throw new Error("not under test");
      }),
      ...(over?.lease ? { lease: over.lease } : {}),
    })),
    store: { lookup, record, touch },
    bundle: () => new Uint8Array([1, 2, 3]),
    bundleHash: () => HASH,
  };

  return {
    deps,
    sandbox,
    bootHandle,
    connect,
    boot,
    lookup,
    record,
    touch,
    status,
  };
}

const ARGS = { bearer: "user-bearer", projectId: "project-1" };

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
          ? { kind: "unreachable", detail: "box is paused" }
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
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "unreachable", detail: "no answer" }),
      lease: async () => ({ state: "held", holder: "panel-1" }),
    });

    await expect(ensureBrowserSession(f.deps, ARGS)).rejects.toThrow(
      /lease_held/,
    );
    expect(f.sandbox.killBrowserd).not.toHaveBeenCalled();
    expect(f.boot).not.toHaveBeenCalled();
    expect(f.sandbox.disconnect).toHaveBeenCalledTimes(1);
  });

  it("refuses for a PARKED lease too, which is a hold nobody let go of", async () => {
    // Parking is what an expired hold becomes when a pane stops its
    // heartbeat — the tab was closed, or the machine slept. It is not
    // evidence the private moment is over.
    const f = makeFakes({
      lookups: [liveLookup()],
      status: async () => ({ kind: "unreachable", detail: "no answer" }),
      lease: async () => ({ state: "parked", holder: "panel-1" }),
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
        status: async () => ({ kind: "unreachable", detail: "no answer" }),
        lease: async () => ({ state: "free" }),
      }),
    );
    await expectRelaunch(
      makeFakes({
        lookups: [liveLookup()],
        status: async () => ({ kind: "unreachable", detail: "no answer" }),
        lease: async () => {
          throw new Error("this daemon predates the endpoint");
        },
      }),
    );
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

describe("ensureBrowserSession — cross-replica boot race", () => {
  it("adopts the winner's session when its record loses the compare-and-swap", async () => {
    // Both replicas missed the row and booted. Ours records SECOND: the
    // backend refuses (the row is no longer the one we observed), so our
    // daemon — which the winner's pkill may already have reaped — must be
    // stopped, and the winner's session adopted instead of overwriting it.
    const f = makeFakes({
      lookups: [
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
        liveLookup({ bootId: "boot-winner", browserdToken: "token-winner" }),
      ],
      bootError: new Error("port already in use"),
      status: async () => ({ kind: "ok", bootId: "boot-winner" }),
    });
    const handle = await ensureBrowserSession(f.deps, ARGS);
    expect(handle.reused).toBe(true);
    expect(handle.bootId).toBe("boot-winner");
    expect(f.lookup).toHaveBeenCalledTimes(2);
    expect(f.sandbox.disconnect).toHaveBeenCalled();
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
