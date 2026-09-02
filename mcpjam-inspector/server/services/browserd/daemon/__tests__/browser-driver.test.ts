import { describe, expect, it, vi } from "vitest";
import {
  guardStaleness,
  stateTokensMatch,
  type BrowserDriver,
} from "../browser-driver";
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
