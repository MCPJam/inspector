import { describe, expect, it } from "vitest";
import { resolveEffectiveAuthMethod } from "../../../../../server/utils/effective-auth";

/**
 * Why a client-side concern is pinned against the SERVER's resolver.
 *
 * The score page creates a server row for a pasted URL and then relies on the
 * hosted connect path to tell it "this server wants authorization". That signal
 * is not a guess: the route converts a live 401 into a tagged `oauthRequired`
 * error, but ONLY when the row resolves to the `discover` auth mode. Any other
 * mode leaves the 401 as a plain transport failure, the score page's OAuth
 * branch never fires, and a visitor scanning an auth-required server just sees
 * a raw connect error with no way forward.
 *
 * The row shipped without `authMethod` at first, which lands in the legacy
 * branch below and resolves to `"none"` — so every OAuth server failed this
 * way. The value is one field on a create call, invisible in every unit test
 * that mocked the mutation, and the failure only appears against a real server
 * that actually demands auth. Hence this test, against the real resolver: it
 * fails if either side of the contract moves.
 */

describe("the score page's server row resolves to the discover ladder", () => {
  it("resolves authMethod 'auto' to discover, which is what tags a 401", () => {
    // Exactly the shape the score page creates.
    expect(
      resolveEffectiveAuthMethod({
        authMethod: "auto",
        transportType: "http",
      } as any),
    ).toBe("discover");
  });

  it("resolves an authMethod-less row to 'none' — the bug this guards", () => {
    // The original create call. `none` never escalates, so an auth-required
    // server reports a raw transport error and the visitor is stuck.
    expect(resolveEffectiveAuthMethod({ transportType: "http" } as any)).toBe(
      "none",
    );
  });

  it("does not select XAA for a plain pasted URL", () => {
    // `auto` picks XAA when the row carries XAA configuration. A score row
    // never does, so it must land on the discover ladder instead.
    expect(
      resolveEffectiveAuthMethod({
        authMethod: "auto",
        transportType: "http",
        url: "https://mcp.example.com/mcp",
      } as any),
    ).toBe("discover");
  });
});
