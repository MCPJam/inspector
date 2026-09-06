import { describe, expect, it, vi } from "vitest";
import {
  guardLease,
  guardStaleness,
  stateTokensMatch,
  type BrowserDriver,
} from "../browser-driver";
import { HandoffLease } from "../lease";
import type {
  BrowserCommand,
  BrowserCommandResult,
  ObservationStateToken,
} from "../../protocol";

function token(over: Partial<ObservationStateToken> = {}): ObservationStateToken {
  return { tabId: "tab-1", navCounter: 1, urlHash: "u1", domHash: "d1", ...over };
}

/** A driver whose execute result and current token are set per test. */
function fakeDriver(over: Partial<BrowserDriver> = {}): BrowserDriver {
  return {
    execute: vi.fn(
      async (): Promise<BrowserCommandResult> => ({ ok: true, output: "ran" }),
    ),
    currentStateToken: vi.fn(async () => token()),
    health: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => {}),
    ...over,
  };
}

function actCmd(
  expectedState?: ObservationStateToken,
  over: Partial<BrowserCommand> = {},
): BrowserCommand {
  return {
    commandId: "c1",
    tabId: "tab-1",
    source: "chat",
    action: { kind: "act", verb: "click", expectedState },
    ...over,
  };
}

describe("stateTokensMatch", () => {
  it("is true only when every field matches", () => {
    expect(stateTokensMatch(token(), token())).toBe(true);
    expect(stateTokensMatch(token(), token({ navCounter: 2 }))).toBe(false);
    expect(stateTokensMatch(token(), token({ domHash: "d2" }))).toBe(false);
    expect(stateTokensMatch(token(), token({ urlHash: "u2" }))).toBe(false);
    expect(stateTokensMatch(token(), token({ tabId: "tab-2" }))).toBe(false);
  });
});

describe("guardStaleness", () => {
  it("executes an act whose expectedState still matches the live tab", async () => {
    const driver = fakeDriver({ currentStateToken: vi.fn(async () => token()) });
    const result = await guardStaleness(driver)(actCmd(token()));
    expect(result).toEqual({ ok: true, output: "ran" });
    expect(driver.execute).toHaveBeenCalledOnce();
  });

  it("REFUSES an act whose expectedState is stale, returning the fresh token (L3)", async () => {
    const fresh = token({ navCounter: 9, domHash: "moved" });
    const driver = fakeDriver({ currentStateToken: vi.fn(async () => fresh) });
    const result = await guardStaleness(driver)(actCmd(token()));
    expect(result).toEqual({
      ok: false,
      staleObservation: true,
      error: "stale_observation",
      stateToken: fresh,
    });
    expect(driver.execute).not.toHaveBeenCalled(); // the click NEVER lands
  });

  it("executes an act with NO expectedState (opt-out) without reading state", async () => {
    const driver = fakeDriver();
    await guardStaleness(driver)(actCmd(undefined));
    expect(driver.currentStateToken).not.toHaveBeenCalled();
    expect(driver.execute).toHaveBeenCalledOnce();
  });

  it("passes a non-act command straight through even if a token is present", async () => {
    const driver = fakeDriver();
    const navigate: BrowserCommand = {
      commandId: "c2",
      source: "chat",
      action: { kind: "navigate", url: "https://x.test" },
    };
    await guardStaleness(driver)(navigate);
    expect(driver.currentStateToken).not.toHaveBeenCalled();
    expect(driver.execute).toHaveBeenCalledOnce();
  });

  it("executes when the tab is unknown (no current token to compare against)", async () => {
    const driver = fakeDriver({ currentStateToken: vi.fn(async () => undefined) });
    const result = await guardStaleness(driver)(actCmd(token()));
    expect(result).toMatchObject({ ok: true });
    expect(driver.execute).toHaveBeenCalledOnce();
  });
});

describe("guardLease — the refusal a queued command gets at DEQUEUE", () => {
  const cmd = (over: Partial<BrowserCommand> = {}): BrowserCommand => ({
    commandId: "q1",
    source: "chat",
    action: { kind: "observe", mode: "screenshot" },
    ...over,
  });

  it("refuses a command admitted BEFORE the handoff, without touching the driver", async () => {
    // The handler's 423 only sees commands as they arrive. A per-tab FIFO can
    // hold several, and one admitted a moment before someone clicked "Take
    // control" would otherwise run — and capture — under their hands.
    const lease = new HandoffLease();
    const executor = vi.fn().mockResolvedValue({ ok: true });
    const guarded = guardLease(lease, executor);

    lease.acquire("rail-1", 60_000);
    const result = await guarded(cmd());

    expect(result.ok).toBe(false);
    expect(result.leaseBlocked).toBe(true);
    expect(result.error).toMatch(/^lease_held:/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("lets everything through while nobody holds it", async () => {
    const lease = new HandoffLease();
    const executor = vi.fn().mockResolvedValue({ ok: true });
    const result = await guardLease(lease, executor)(cmd());
    expect(result).toEqual({ ok: true });
    expect(executor).toHaveBeenCalledOnce();
  });

  it("lets the holder's own command through", async () => {
    const lease = new HandoffLease();
    lease.acquire("rail-1", 60_000);
    const executor = vi.fn().mockResolvedValue({ ok: true });
    const result = await guardLease(lease, executor)(
      cmd({ source: "manual", holder: "rail-1" }),
    );
    expect(result).toEqual({ ok: true });
    expect(executor).toHaveBeenCalledOnce();
  });
});

describe("guardStaleness — the lease, re-asked after the state read", () => {
  it("refuses when a handoff lands while the current token is being read", async () => {
    const lease = new HandoffLease();
    const driver = fakeDriver({
      // Reading the token touches the page. `guardLease` upstream can only
      // vouch for the moment before this began — so the guard re-asks after.
      currentStateToken: vi.fn(async () => {
        lease.acquire("rail-1", 60_000);
        return token();
      }),
    });

    const result = await guardStaleness(driver, lease)(actCmd(token()));

    expect(result.ok).toBe(false);
    expect(result.leaseBlocked).toBe(true);
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it("still runs the holder's own act", async () => {
    const lease = new HandoffLease();
    lease.acquire("rail-1", 60_000);
    const driver = fakeDriver();

    const result = await guardStaleness(
      driver,
      lease,
    )(actCmd(token(), { source: "manual", holder: "rail-1" }));

    expect(result).toEqual({ ok: true, output: "ran" });
  });

  it("is a no-op without a lease, as a fake-driver test composes it", async () => {
    const driver = fakeDriver();
    const result = await guardStaleness(driver)(actCmd(token()));
    expect(result).toEqual({ ok: true, output: "ran" });
  });
});
