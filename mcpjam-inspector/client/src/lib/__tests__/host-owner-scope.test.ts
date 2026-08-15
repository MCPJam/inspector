/**
 * Which clients are hidden from generic pickers, and which are not.
 *
 * The rule is one-sided on purpose and easy to over-apply: `user_testing`
 * clients are private backing and must never be offered, while `journeys`
 * clients are standalone clients the Clients surface is *meant* to show
 * (they are hidden from the chatbox surface instead, by a different rule).
 * Broadening this predicate to "any product-owned host" would silently empty
 * the Swarms client list, so both halves are locked here.
 */
import { describe, expect, it } from "vitest";
import {
  isPrivateScenarioBackingHost,
  withoutPrivateScenarioBackingHosts,
  type HostOwnerScope,
} from "../host-owner-scope";

describe("isPrivateScenarioBackingHost", () => {
  it("hides a User Testing scenario's private backing client", () => {
    expect(isPrivateScenarioBackingHost({ type: "user_testing" })).toBe(true);
  });

  it.each<[string, HostOwnerScope]>([
    ["a journeys client (standalone, but a real client)", { type: "journeys" }],
    ["a suite-created client", { type: "suite", testSuiteId: "ts1" }],
    ["a chatbox-created client", { type: "chatbox", chatboxId: "cb1" }],
    ["an explicitly untagged client", null],
  ])("keeps %s", (_label, ownerScope) => {
    expect(isPrivateScenarioBackingHost(ownerScope)).toBe(false);
  });

  it("keeps a legacy client whose backend omits the field entirely", () => {
    // Older backends don't send `ownerScope`; absent must read as visible, not
    // as an unknown to hide.
    expect(isPrivateScenarioBackingHost(undefined)).toBe(false);
  });
});

describe("withoutPrivateScenarioBackingHosts", () => {
  it("drops only the private backing clients, preserving order", () => {
    const hosts = [
      { hostId: "a", ownerScope: null },
      { hostId: "b", ownerScope: { type: "user_testing" as const } },
      { hostId: "c", ownerScope: { type: "journeys" as const } },
      { hostId: "d" },
      { hostId: "e", ownerScope: { type: "user_testing" as const } },
    ];

    expect(withoutPrivateScenarioBackingHosts(hosts).map((h) => h.hostId)).toEqual(
      ["a", "c", "d"],
    );
  });

  it("returns an empty list unchanged", () => {
    expect(withoutPrivateScenarioBackingHosts([])).toEqual([]);
  });

  it("can filter everything out — an all-backing project offers no clients", () => {
    const hosts = [
      { hostId: "a", ownerScope: { type: "user_testing" as const } },
      { hostId: "b", ownerScope: { type: "user_testing" as const } },
    ];
    expect(withoutPrivateScenarioBackingHosts(hosts)).toEqual([]);
  });
});
