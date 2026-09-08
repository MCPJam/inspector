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

  it("carries a FRESH OBSERVATION with the refusal when the driver can take one", async () => {
    // Without this the refusal says "re-read the page" and the model spends a
    // call doing exactly that — the round trip the token exists to save.
    const fresh = token({ navCounter: 9, domHash: "moved" });
    const observeForRefusal = vi.fn(async () => ({
      ok: true,
      output: { url: "https://x.test/step-2", a11y: '- button "Retry" [ref=e1]' },
      stateToken: fresh,
    }));
    const driver = fakeDriver({
      currentStateToken: vi.fn(async () => fresh),
      observeForRefusal,
    });

    const result = await guardStaleness(driver)(actCmd(token()));

    expect(result).toEqual({
      ok: false,
      staleObservation: true,
      error: "stale_observation",
      stateToken: fresh,
      output: {
        url: "https://x.test/step-2",
        a11y: '- button "Retry" [ref=e1]',
      },
    });
    // The act still NEVER runs: this is a refusal that happens to be useful,
    // not a retry.
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it("drops an UNBOUND capture rather than pinning it to the old token", async () => {
    // `afterAct` omits the state token when the page moved under the capture,
    // on purpose: no token honestly describes what that picture shows.
    // Forwarding the picture anyway while falling back to the CURRENT token
    // hands the model two page states in one answer — a picture of B pinned
    // to A. And A is live, so the next act decided from that picture pins to
    // A, matches, and sails through this very guard: the stale targeting L3
    // exists to refuse, admitted by the refusal meant to prevent it.
    const live = token({ navCounter: 9, domHash: "moved" });
    const observeForRefusal = vi.fn(async () => ({
      ok: true as const,
      // A real capture, and deliberately no `stateToken`.
      output: { url: "https://x.test/step-2", screenshot: "aGk=" },
      settled: false,
    }));
    const driver = fakeDriver({
      currentStateToken: vi.fn(async () => live),
      observeForRefusal,
    });

    const result = await guardStaleness(driver)(actCmd(token()));

    // Degrades to exactly the bare refusal this had before the fresh look was
    // added: a token, and "look again".
    expect(result).toEqual({
      ok: false,
      staleObservation: true,
      error: "stale_observation",
      stateToken: live,
    });
    expect(result).not.toHaveProperty("output");
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it("asks for the shape the ACT asked for", async () => {
    // A model that wanted a tree back from its act wants a tree back from the
    // refusal too; handing it a screenshot instead is a different answer to
    // the question it asked.
    const fresh = token({ domHash: "moved" });
    const wants: Array<{ a11y: boolean; screenshot: boolean }> = [];
    const observeForRefusal = vi.fn(
      async (
        _command: BrowserCommand,
        asked: { a11y: boolean; screenshot: boolean },
      ) => {
        wants.push(asked);
        return { ok: true, stateToken: fresh };
      },
    );
    const driver = fakeDriver({
      currentStateToken: vi.fn(async () => fresh),
      observeForRefusal,
    });

    await guardStaleness(driver)(
      actCmd(token(), {
        action: {
          kind: "act",
          verb: "click",
          expectedState: token(),
          observe: "a11y",
        },
      }),
    );

    expect(wants).toEqual([{ a11y: true, screenshot: false }]);
  });

  it("returns a leaseBlocked recovery read AS IS, rather than calling it stale", async () => {
    // Two refusals are in play and only one is true. A person took the browser
    // during the recovery read, so "the page moved, go and look" would send
    // the model to read a page it is not allowed to see.
    const fresh = token({ domHash: "moved" });
    const blocked = {
      ok: false,
      leaseBlocked: true,
      error: "lease_held: a person has taken control of this browser",
    };
    const driver = fakeDriver({
      currentStateToken: vi.fn(async () => fresh),
      observeForRefusal: vi.fn(async () => blocked),
    });

    const result = await guardStaleness(driver)(actCmd(token()));

    expect(result).toEqual(blocked);
    expect(result.staleObservation).toBeUndefined();
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it("still refuses with the bare token when the recovery read THROWS", async () => {
    // The very thing that made this act stale — a navigation, a closing tab —
    // is what makes the recovery read throw, so this is the common case rather
    // than the exotic one. A generic command failure here is strictly worse
    // than the bare token refusal the guard gave before it could observe.
    const fresh = token({ navCounter: 9, domHash: "moved" });
    const driver = fakeDriver({
      currentStateToken: vi.fn(async () => fresh),
      observeForRefusal: vi.fn(async () => {
        throw new Error("Execution context was destroyed");
      }),
    });

    const result = await guardStaleness(driver)(actCmd(token()));

    expect(result).toEqual({
      ok: false,
      staleObservation: true,
      error: "stale_observation",
      stateToken: fresh,
    });
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it("still refuses with the bare token when the driver cannot observe", async () => {
    // `observeForRefusal` is optional — a unit fake, an engine with no such
    // read — and a driver without it degrades to today's shape rather than
    // failing the refusal.
    const fresh = token({ navCounter: 9, domHash: "moved" });
    const driver = fakeDriver({ currentStateToken: vi.fn(async () => fresh) });

    const result = await guardStaleness(driver)(actCmd(token()));

    expect(result).toEqual({
      ok: false,
      staleObservation: true,
      error: "stale_observation",
      stateToken: fresh,
    });
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
