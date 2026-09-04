import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ensureLocalBrowserSession,
  getLocalBrowserProfileDir,
  killLocalBrowserSessions,
  listLocalBrowserSessions,
  LOCAL_BROWSER_IDLE_MS,
  LOCAL_BROWSER_MAX_LIFETIME_MS,
  LocalBrowserUnavailableError,
  resetLocalBrowserSessionsForTests,
  shutdownLocalBrowserSessions,
  sweepLocalBrowserSessions,
  touchLocalBrowserSession,
  type LocalBrowserDeps,
} from "../local-browser-session";
import { fakeContext } from "../../daemon/__tests__/fake-page";
import type { DriverContext } from "../../daemon/browser-page";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A profile root per test run.
 *
 * `startSession` CREATES (and chmods) the profile directory before it launches
 * anything, so a suite with a faked browser was still writing into the
 * developer's own `~/.mcpjam` tree — and a `chmod` there is not something a
 * unit test gets to do.
 */
let profileRoot = "";
beforeAll(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), "mcpjam-browser-profiles-"));
});
afterAll(async () => {
  if (profileRoot) await rm(profileRoot, { recursive: true, force: true });
});

function makeDeps(over: Partial<LocalBrowserDeps> = {}) {
  const launched: Array<Record<string, unknown>> = [];
  const contexts: Array<{
    ctx: DriverContext;
    setConnected(v: boolean): void;
  }> = [];
  let now = 1_000_000;
  const deps: LocalBrowserDeps = {
    async launch(options) {
      launched.push(options as unknown as Record<string, unknown>);
      const { context, setConnected } = fakeContext();
      contexts.push({ ctx: context, setConnected });
      return context;
    },
    async launchElectron() {
      launched.push({ electron: true });
      const { context, setConnected } = fakeContext();
      contexts.push({ ctx: context, setConnected });
      return context;
    },
    runtime: () => "playwright",
    chromiumInstalled: async () => true,
    probeProfileOwner: async () => ({ live: false }),
    profileDirFor: (projectId: string) =>
      join(profileRoot, projectId, "profile"),
    now: () => now,
    env: {},
    ...over,
  };
  return {
    deps,
    launched,
    contexts,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

afterEach(async () => {
  await resetLocalBrowserSessionsForTests();
});

describe("local browser session", () => {
  it("keeps ONE browser per project across turns", async () => {
    const { deps, launched } = makeDeps();
    const first = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );
    const second = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );

    expect(launched).toHaveLength(1);
    expect(second.bootId).toBe(first.bootId);
    expect(second.reused).toBe(true);
    // The persistent profile is the point: a login must survive the turn that
    // made it.
    expect(first.contextMode).toBe("persistent");
    expect(first.profileDir).toBe(join(profileRoot, "proj-a", "profile"));
  });

  it("gives each project its own profile", async () => {
    const { deps, launched } = makeDeps();
    await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    await ensureLocalBrowserSession({ projectId: "proj-b" }, deps);
    expect(launched).toHaveLength(2);
    expect(launched[0].userDataDir).not.toBe(launched[1].userDataDir);
  });

  it("gives every unattended run a throwaway browser of its own", async () => {
    // Two eval iterations on one project must not share cookies — that is one
    // iteration deciding the next one's verdict.
    const { deps, launched } = makeDeps();
    const a = await ensureLocalBrowserSession(
      { projectId: "proj-a", contextMode: "ephemeral", ownerKey: "iter-1" },
      deps,
    );
    const b = await ensureLocalBrowserSession(
      { projectId: "proj-a", contextMode: "ephemeral", ownerKey: "iter-2" },
      deps,
    );
    expect(a.bootId).not.toBe(b.bootId);
    expect(a.profileDir).toBeUndefined();
    expect(launched.every((l) => l.contextMode === "ephemeral")).toBe(true);
  });

  it("launches the full Chromium build, not the headless shell", async () => {
    // `headless: true` alone resolves to `chromium-headless-shell` — the old
    // headless, which public sites fingerprint and refuse.
    const { deps, launched } = makeDeps();
    await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    expect(launched[0]).toMatchObject({ channel: "chromium", headless: true });
  });

  it("opens a real window only when asked, and only where one can exist", async () => {
    const headed = makeDeps({
      env: { MCPJAM_BROWSER_HEADED: "1", DISPLAY: ":0" },
    });
    await ensureLocalBrowserSession({ projectId: "proj-a" }, headed.deps);
    expect(headed.launched[0]).toMatchObject({ headless: false });

    await resetLocalBrowserSessionsForTests();

    const noDisplay = makeDeps({ env: { MCPJAM_BROWSER_HEADED: "1" } });
    await ensureLocalBrowserSession({ projectId: "proj-a" }, noDisplay.deps);
    expect(noDisplay.launched[0]).toMatchObject({
      headless:
        process.platform === "win32" || process.platform === "darwin"
          ? false
          : true,
    });
  });

  it("refuses — with a way forward — when there is no Chromium yet", async () => {
    const { deps } = makeDeps({ chromiumInstalled: async () => false });
    await expect(
      ensureLocalBrowserSession({ projectId: "proj-a" }, deps),
    ).rejects.toMatchObject({ code: "chromium_not_installed" });
    // Never a download from inside a chat turn.
    await expect(
      ensureLocalBrowserSession({ projectId: "proj-a" }, deps),
    ).rejects.toBeInstanceOf(LocalBrowserUnavailableError);
  });

  it("refuses a profile another live process owns, rather than stealing it", async () => {
    const { deps, launched } = makeDeps({
      probeProfileOwner: async () => ({ live: true, pid: 4242 }),
    });
    await expect(
      ensureLocalBrowserSession({ projectId: "proj-a" }, deps),
    ).rejects.toMatchObject({ code: "profile_in_use" });
    expect(launched).toHaveLength(0);
  });

  it("refuses an ephemeral browser that will not name its run", async () => {
    // The old fallback collapsed a missing key to "anonymous", which handed
    // two unattended runs on one project ONE browser and one cookie jar.
    const { deps, launched } = makeDeps();
    await expect(
      ensureLocalBrowserSession(
        { projectId: "proj-a", contextMode: "ephemeral" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "owner_key_required" });
    await expect(
      ensureLocalBrowserSession(
        { projectId: "proj-a", contextMode: "ephemeral", ownerKey: "  " },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocalBrowserUnavailableError);
    expect(launched).toHaveLength(0);
  });

  it("does not probe the singleton for an ephemeral browser", async () => {
    // There is no shared profile directory to own.
    const probe = vi.fn().mockResolvedValue({ live: true, pid: 1 });
    const { deps } = makeDeps({ probeProfileOwner: probe });
    await ensureLocalBrowserSession(
      { projectId: "proj-a", contextMode: "ephemeral", ownerKey: "i1" },
      deps,
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("reaps a browser nobody has used", async () => {
    const { deps, advance, at } = makeDeps();
    await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    advance(LOCAL_BROWSER_IDLE_MS + 1);
    await sweepLocalBrowserSessions(at());
    expect(listLocalBrowserSessions()).toHaveLength(0);
  });

  it("reaps one nobody used even though the sweep keeps looking at it", async () => {
    // The sweep runs every 30 s and the idle window is ten minutes, so it sees
    // a session ~20 times before that session is old enough to take. Touching
    // `lastUsedAt` on any of those passes pushes the deadline forward by the
    // sweep interval every time and the idle reap can never fire at all — a
    // Chromium per project pinned open for the life of the server. Only a HELD
    // lease earns that refresh; merely being looked at does not.
    const { deps, advance, at } = makeDeps();
    await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);

    const step = Math.floor(LOCAL_BROWSER_IDLE_MS / 4);
    for (let i = 0; i < 4; i += 1) {
      advance(step);
      await sweepLocalBrowserSessions(at());
    }
    advance(LOCAL_BROWSER_IDLE_MS - step * 4 + 1);
    await sweepLocalBrowserSessions(at());

    expect(listLocalBrowserSessions()).toHaveLength(0);
  });

  it("does NOT reap a browser a person is holding", async () => {
    // Taking control IS using it. Reaping here closes the window someone is
    // typing a password into.
    const { deps, advance, at } = makeDeps();
    const handle = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );
    await handle.client.leaseAction!({ action: "acquire", holder: "rail-1" });

    advance(LOCAL_BROWSER_IDLE_MS + 1);
    await sweepLocalBrowserSessions(at());
    expect(listLocalBrowserSessions()).toHaveLength(1);

    // Even past the absolute lifetime, while they still hold it.
    advance(LOCAL_BROWSER_MAX_LIFETIME_MS);
    await sweepLocalBrowserSessions(at());
    expect(listLocalBrowserSessions()).toHaveLength(1);
  });

  it("reaps a browser whose hold was ABANDONED", async () => {
    // A hold that runs out PARKS rather than freeing, which is right: a timer
    // expiring is not evidence the private moment is over, so the agent stays
    // blocked. But deferring the reap for a parked lease too made any
    // abandoned hold immortal on a LIVE session — close the tab mid-login and
    // a Chromium sat pinned open past the hard lifetime with nobody on either
    // end, because `isBlocking()` is true for both states. Parking blocks the
    // AGENT; it is not a person at the keyboard.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
      const { deps, advance, at } = makeDeps();
      const handle = await ensureLocalBrowserSession(
        { projectId: "proj-a" },
        deps,
      );
      await handle.client.leaseAction!({ action: "acquire", holder: "rail-1" });

      // The pane went away: no heartbeat, so the hold expires into `parked`.
      vi.setSystemTime(new Date("2026-09-02T00:31:00Z"));
      expect((await handle.client.lease!()).state).toBe("parked");

      advance(LOCAL_BROWSER_IDLE_MS + 1);
      await sweepLocalBrowserSessions(at());
      expect(listLocalBrowserSessions()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaps once the person hands it back", async () => {
    const { deps, advance, at } = makeDeps();
    const handle = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );
    await handle.client.leaseAction!({ action: "acquire", holder: "rail-1" });
    advance(LOCAL_BROWSER_IDLE_MS + 1);
    await sweepLocalBrowserSessions(at());
    await handle.client.leaseAction!({ action: "resume", holder: "rail-1" });

    advance(LOCAL_BROWSER_IDLE_MS + 1);
    await sweepLocalBrowserSessions(at());
    expect(listLocalBrowserSessions()).toHaveLength(0);
  });

  it("watching the pane defers the reap", async () => {
    const { deps, advance, at } = makeDeps();
    const handle = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );
    advance(LOCAL_BROWSER_IDLE_MS - 1);
    touchLocalBrowserSession(handle, at());
    advance(LOCAL_BROWSER_IDLE_MS - 1);
    await sweepLocalBrowserSessions(at());
    expect(listLocalBrowserSessions()).toHaveLength(1);
  });

  it("replaces a browser that died instead of handing back a dead handle", async () => {
    const { deps, contexts, launched } = makeDeps();
    const first = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );
    // The user closed the window, or Chromium crashed.
    contexts[0].setConnected(false);
    const second = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );
    expect(launched).toHaveLength(2);
    expect(second.bootId).not.toBe(first.bootId);
  });

  it("closes every browser when the server stops", async () => {
    const { deps } = makeDeps();
    await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    await ensureLocalBrowserSession({ projectId: "proj-b" }, deps);
    await killLocalBrowserSessions();
    expect(listLocalBrowserSessions()).toHaveLength(0);
  });

  it("brings its own Chromium in the desktop app, with nothing to install", async () => {
    // The packaged app ships no `node_modules`, so the Playwright launcher
    // cannot work there at all. Asking `chromiumInstalled()` would also show
    // the consent screen a download prompt for a browser the user has open.
    const installed = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const { deps, launched } = makeDeps({
      runtime: () => "electron",
      chromiumInstalled: installed,
      launch: async () => {
        throw new Error("the Playwright launcher must not run under Electron");
      },
    });

    const handle = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );

    expect(handle.runtime).toBe("electron");
    // Still the LOCAL engine: the tools, the lease, the pane and the approval
    // rules are identical, and only the context factory differs.
    expect(handle.engine).toBe("local");
    expect(installed).not.toHaveBeenCalled();
    expect(launched).toEqual([{ electron: true }]);
  });

  it("does not probe a singleton lock it does not own", async () => {
    // Electron's profile is a session PARTITION, not a directory we create and
    // lock. The app's own `requestSingleInstanceLock` is what guarantees one
    // owner, which is the thing the probe exists to establish.
    const probe = vi.fn(async () => ({ live: false }));
    const { deps } = makeDeps({
      runtime: () => "electron",
      probeProfileOwner: probe,
    });

    const handle = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );

    expect(probe).not.toHaveBeenCalled();
    expect(handle.profileDir).toBeUndefined();
  });

  it("gives each project its own Electron partition", async () => {
    const partitions: Array<string | undefined> = [];
    const { deps } = makeDeps({
      runtime: () => "electron",
      async launchElectron(options) {
        partitions.push(options.partitionKey);
        return fakeContext().context;
      },
    });

    await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    await ensureLocalBrowserSession({ projectId: "proj-b" }, deps);
    await ensureLocalBrowserSession(
      { projectId: "proj-a", contextMode: "ephemeral", ownerKey: "run-1" },
      deps,
    );

    // An ephemeral run gets no partition key at all: naming one would make
    // Electron persist it, which is the opposite of what ephemeral means.
    expect(partitions).toEqual(["proj-a", "proj-b", undefined]);
  });

  it("rejects a project key that would escape the profile root", async () => {
    expect(() => getLocalBrowserProfileDir("../../etc")).toThrow();
  });
});

describe("local browser session — shutdown does not leave a browser behind", () => {
  it("refuses a new session once shutdown has been latched", async () => {
    const { deps, launched } = makeDeps();
    await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    await shutdownLocalBrowserSessions();

    await expect(
      ensureLocalBrowserSession({ projectId: "proj-a" }, deps),
    ).rejects.toMatchObject({ code: "disabled" });
    expect(launched).toHaveLength(1);
  });

  it("closes a browser whose launch finished after the drain", async () => {
    // The launch is the long await, and shutdown can begin inside it. A
    // Chromium registered after the drain is one nothing is left to reap — it
    // outlives the inspector still holding the profile lock.
    const closed: boolean[] = [];
    const { deps } = makeDeps({
      async launch() {
        // Shutdown begins while this browser is still starting — the one
        // ordering the latches before the launch cannot catch.
        await shutdownLocalBrowserSessions();
        const { context } = fakeContext();
        const original = context.close.bind(context);
        context.close = async () => {
          closed.push(true);
          await original();
        };
        return context;
      },
    });

    await expect(
      ensureLocalBrowserSession({ projectId: "proj-a" }, deps),
    ).rejects.toMatchObject({ code: "disabled" });
    expect(closed).toEqual([true]);
    expect(listLocalBrowserSessions()).toHaveLength(0);
  });

  it("keeps a DISCONNECTED browser out of the lease deferral", async () => {
    // Holding the browser defers the reap — but only while there is a browser
    // to hold. A dead session whose lease was never released used to refresh
    // its own timestamp on every sweep and never be collected.
    const { deps, contexts, advance, at } = makeDeps();
    const handle = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );
    const session = listLocalBrowserSessions().find(
      (s) => s.handle.bootId === handle.bootId,
    );
    expect(session).toBeDefined();

    await handle.client.leaseAction?.({
      action: "acquire",
      holder: "rail-1",
      ttlMs: 60 * 60_000,
    });
    contexts[0]?.setConnected(false);
    advance(LOCAL_BROWSER_IDLE_MS + 1);
    await sweepLocalBrowserSessions(at());

    expect(listLocalBrowserSessions()).toHaveLength(0);
  });
});

describe("local browser session — the reaper decides on current facts", () => {
  it("does not close a session that was used while the sweep queued for the lock", async () => {
    // Everything the scan reads is read BEFORE queueing for the per-key lock.
    // A turn that lands in that window has already been handed this browser,
    // and closing it now acts on a reading that is no longer true.
    const { deps, advance, at } = makeDeps();
    const handle = await ensureLocalBrowserSession(
      { projectId: "proj-a" },
      deps,
    );
    advance(LOCAL_BROWSER_IDLE_MS + 1);

    // The sweep decides synchronously, then awaits the lock. The use lands in
    // between — which is exactly the ordering the re-check exists for.
    const sweeping = sweepLocalBrowserSessions(at());
    touchLocalBrowserSession(handle, at());
    await sweeping;

    expect(listLocalBrowserSessions()).toHaveLength(1);
    expect(listLocalBrowserSessions()[0]?.handle.bootId).toBe(handle.bootId);
  });

  it("still reaps one nobody came back for", async () => {
    const { deps, advance, at } = makeDeps();
    await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    advance(LOCAL_BROWSER_IDLE_MS + 1);
    await sweepLocalBrowserSessions(at());
    expect(listLocalBrowserSessions()).toHaveLength(0);
  });

  it("closes a browser whose launch outlived a kill during the INSTALL probe", async () => {
    // The generation has to be read before the FIRST await in the launch path,
    // not just before `launch()`. `chromiumInstalled()` is an await too — it
    // shells out to Playwright — and a kill landing during it bumped the
    // generation before this launch had read one, so the launch adopted the
    // post-kill generation and registered a browser the sweep had already run
    // past.
    const closed: boolean[] = [];
    const { deps } = makeDeps({
      async chromiumInstalled() {
        await killLocalBrowserSessions();
        return true;
      },
      async launch() {
        const { context } = fakeContext();
        const original = context.close.bind(context);
        context.close = async () => {
          closed.push(true);
          await original();
        };
        return context;
      },
    });

    await expect(
      ensureLocalBrowserSession({ projectId: "proj-a" }, deps),
    ).rejects.toMatchObject({ code: "disabled" });
    expect(closed).toEqual([true]);
    expect(listLocalBrowserSessions()).toHaveLength(0);
  });

  it("closes a browser whose launch outlived a NON-latching kill", async () => {
    // Electron's window-all-closed sweep must not latch, or every browser
    // opened after reopening the window would be refused. So it cannot use
    // `shuttingDown` to stop a launch already in flight — the generation can.
    const closed: boolean[] = [];
    const { deps } = makeDeps({
      async launch() {
        await killLocalBrowserSessions();
        const { context } = fakeContext();
        const original = context.close.bind(context);
        context.close = async () => {
          closed.push(true);
          await original();
        };
        return context;
      },
    });

    await expect(
      ensureLocalBrowserSession({ projectId: "proj-a" }, deps),
    ).rejects.toMatchObject({ code: "disabled" });
    expect(closed).toEqual([true]);
    expect(listLocalBrowserSessions()).toHaveLength(0);
  });
});
