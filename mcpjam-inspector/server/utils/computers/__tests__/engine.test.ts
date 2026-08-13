import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The engine resolver is the single decision point for WHERE the personal
 * computer executes, so its matrix is pinned exhaustively — the load-bearing
 * rows are the refusals: hosted never local, absent preference never local,
 * explicit local without flag/consent/bash resolves `unavailable` (never a
 * silent cloud fallback), and the actor coercion strips `local` from every
 * non-direct-member context.
 */
const state = vi.hoisted(() => ({
  hosted: false,
  localEnabled: true,
  dataPlaneConfigured: false,
  remoteUrl: null as string | null,
  localAvailable: true,
}));

vi.mock("../../../config.js", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
  get LOCAL_COMPUTER_ENABLED() {
    return state.localEnabled;
  },
}));
vi.mock("../control-plane-client.js", () => ({
  isComputersDataPlaneConfigured: () => state.dataPlaneConfigured,
}));
vi.mock("../remote-data-plane.js", () => ({
  getComputersRemoteDataPlaneUrl: () => state.remoteUrl,
}));
vi.mock("../local-machine.js", () => ({
  isLocalComputerEngineAvailable: () =>
    state.localAvailable
      ? { available: true }
      : { available: false, reason: "no bash" },
}));

import {
  coercePersonalEngineForActor,
  resolvePersonalComputerEngine,
} from "../engine.js";

const directMember = {
  isGuest: false,
  isChatboxSession: false,
  isJourneySession: false,
  executionScopeKind: undefined,
};

describe("resolvePersonalComputerEngine", () => {
  beforeEach(() => {
    state.hosted = false;
    state.localEnabled = true;
    state.dataPlaneConfigured = false;
    state.remoteUrl = null;
    state.localAvailable = true;
  });

  it("absent preference reproduces the legacy cloud fork exactly", () => {
    state.dataPlaneConfigured = true;
    expect(resolvePersonalComputerEngine({ localConsentValid: true })).toBe(
      "e2b"
    );
    state.dataPlaneConfigured = false;
    state.remoteUrl = "https://dp.example.com";
    expect(resolvePersonalComputerEngine({ localConsentValid: true })).toBe(
      "delegated"
    );
    state.remoteUrl = null;
    expect(resolvePersonalComputerEngine({ localConsentValid: true })).toBe(
      "unavailable"
    );
  });

  it("absent preference NEVER resolves local, however available it is", () => {
    expect(resolvePersonalComputerEngine({ localConsentValid: true })).toBe(
      "unavailable"
    );
  });

  it("hosted short-circuits before the preference is read", () => {
    state.hosted = true;
    expect(
      resolvePersonalComputerEngine({
        preference: "local",
        localConsentValid: true,
      })
    ).not.toBe("local");
  });

  it("resolves local only with flag + consent + bash all present", () => {
    expect(
      resolvePersonalComputerEngine({
        preference: "local",
        localConsentValid: true,
      })
    ).toBe("local");
  });

  it("explicit local without the kill switch resolves unavailable — never silent cloud", () => {
    state.localEnabled = false;
    state.dataPlaneConfigured = true; // cloud WOULD work; must not be used
    expect(
      resolvePersonalComputerEngine({
        preference: "local",
        localConsentValid: true,
      })
    ).toBe("unavailable");
  });

  it("explicit local without valid consent resolves unavailable", () => {
    state.dataPlaneConfigured = true;
    expect(
      resolvePersonalComputerEngine({
        preference: "local",
        localConsentValid: false,
      })
    ).toBe("unavailable");
  });

  it("explicit local without bash resolves unavailable", () => {
    state.localAvailable = false;
    expect(
      resolvePersonalComputerEngine({
        preference: "local",
        localConsentValid: true,
      })
    ).toBe("unavailable");
  });

  it("explicit cloud with no remote resolves unavailable — never engine-switches", () => {
    expect(
      resolvePersonalComputerEngine({
        preference: "cloud",
        localConsentValid: true,
      })
    ).toBe("unavailable");
  });
});

describe("coercePersonalEngineForActor", () => {
  beforeEach(() => {
    state.hosted = false;
    state.dataPlaneConfigured = false;
    state.remoteUrl = null;
  });

  it("keeps local for a signed-in member's direct turn (project scope too)", () => {
    expect(coercePersonalEngineForActor("local", directMember)).toBe("local");
    expect(
      coercePersonalEngineForActor("local", {
        ...directMember,
        executionScopeKind: "project",
      })
    ).toBe("local");
  });

  it.each([
    ["guest", { ...directMember, isGuest: true }],
    ["chatbox session", { ...directMember, isChatboxSession: true }],
    ["journey session", { ...directMember, isJourneySession: true }],
    [
      "swarm scope",
      { ...directMember, executionScopeKind: "swarm" as const },
    ],
  ])("re-resolves cloud-family for a %s actor", (_label, actor) => {
    state.remoteUrl = "https://dp.example.com";
    expect(coercePersonalEngineForActor("local", actor)).toBe("delegated");
    state.remoteUrl = null;
    expect(coercePersonalEngineForActor("local", actor)).toBe("unavailable");
  });

  it("passes every non-local engine through untouched", () => {
    for (const engine of ["e2b", "delegated", "unavailable"] as const) {
      expect(
        coercePersonalEngineForActor(engine, {
          ...directMember,
          isGuest: true,
        })
      ).toBe(engine);
    }
  });
});
