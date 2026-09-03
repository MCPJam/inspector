import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureLocalBrowserSession,
  getLocalBrowserProfileDir,
  killLocalBrowserSessions,
  listLocalBrowserSessions,
  LOCAL_BROWSER_IDLE_MS,
  LOCAL_BROWSER_MAX_LIFETIME_MS,
  LocalBrowserUnavailableError,
  resetLocalBrowserSessionsForTests,
  sweepLocalBrowserSessions,
  touchLocalBrowserSession,
  type LocalBrowserDeps,
} from "../local-browser-session";
import { fakeContext } from "../../daemon/__tests__/fake-page";
import type { DriverContext } from "../../daemon/browser-page";

function makeDeps(over: Partial<LocalBrowserDeps> = {}) {
  const launched: Array<Record<string, unknown>> = [];
  const contexts: Array<{ ctx: DriverContext; setConnected(v: boolean): void }> =
    [];
  let now = 1_000_000;
  const deps: LocalBrowserDeps = {
    async launch(options) {
      launched.push(options as unknown as Record<string, unknown>);
      const { context, setConnected } = fakeContext();
      contexts.push({ ctx: context, setConnected });
      return context;
    },
    chromiumInstalled: async () => true,
    probeProfileOwner: async () => ({ live: false }),
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
    const first = await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    const second = await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);

    expect(launched).toHaveLength(1);
    expect(second.bootId).toBe(first.bootId);
    expect(second.reused).toBe(true);
    // The persistent profile is the point: a login must survive the turn that
    // made it.
    expect(first.contextMode).toBe("persistent");
    expect(first.profileDir).toBe(getLocalBrowserProfileDir("proj-a"));
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
    const headed = makeDeps({ env: { MCPJAM_BROWSER_HEADED: "1", DISPLAY: ":0" } });
    await ensureLocalBrowserSession({ projectId: "proj-a" }, headed.deps);
    expect(headed.launched[0]).toMatchObject({ headless: false });

    await resetLocalBrowserSessionsForTests();

    const noDisplay = makeDeps({ env: { MCPJAM_BROWSER_HEADED: "1" } });
    await ensureLocalBrowserSession({ projectId: "proj-a" }, noDisplay.deps);
    expect(noDisplay.launched[0]).toMatchObject({
      headless: process.platform === "win32" || process.platform === "darwin"
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

  it("does NOT reap a browser a person is holding", async () => {
    // Taking control IS using it. Reaping here closes the window someone is
    // typing a password into.
    const { deps, advance, at } = makeDeps();
    const handle = await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    await handle.client.leaseAction!({ action: "acquire", holder: "rail-1" });

    advance(LOCAL_BROWSER_IDLE_MS + 1);
    await sweepLocalBrowserSessions(at());
    expect(listLocalBrowserSessions()).toHaveLength(1);

    // Even past the absolute lifetime, while they still hold it.
    advance(LOCAL_BROWSER_MAX_LIFETIME_MS);
    await sweepLocalBrowserSessions(at());
    expect(listLocalBrowserSessions()).toHaveLength(1);
  });

  it("reaps once the person hands it back", async () => {
    const { deps, advance, at } = makeDeps();
    const handle = await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
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
    const handle = await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    advance(LOCAL_BROWSER_IDLE_MS - 1);
    touchLocalBrowserSession(handle, at());
    advance(LOCAL_BROWSER_IDLE_MS - 1);
    await sweepLocalBrowserSessions(at());
    expect(listLocalBrowserSessions()).toHaveLength(1);
  });

  it("replaces a browser that died instead of handing back a dead handle", async () => {
    const { deps, contexts, launched } = makeDeps();
    const first = await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
    // The user closed the window, or Chromium crashed.
    contexts[0].setConnected(false);
    const second = await ensureLocalBrowserSession({ projectId: "proj-a" }, deps);
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

  it("rejects a project key that would escape the profile root", async () => {
    expect(() => getLocalBrowserProfileDir("../../etc")).toThrow();
  });
});
