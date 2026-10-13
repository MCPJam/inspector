import { describe, expect, it } from "vitest";
import {
  orgResumeAllowed,
  resetForReplacedKey,
  resumeStateToCommit,
  stampOrgCredentialRevision,
  stateForTurn,
  stateFromAnotherKey,
  unstampOrgCredentialRevision,
} from "../org-credential-continuity";

describe("org credential continuity", () => {
  const adapterState = { sessionId: "sess_1", cursor: 7 };

  it("round-trips the adapter's own state through a stamp", () => {
    const stamped = stampOrgCredentialRevision(adapterState, "rev_a");
    expect(unstampOrgCredentialRevision(stamped)).toEqual({
      resumeState: adapterState,
      credentialRevision: "rev_a",
    });
  });

  it("leaves a hosted (unstamped) state exactly as it is", () => {
    for (const state of [
      adapterState,
      null,
      "opaque",
      [1, 2],
      { resumeState: adapterState },
      // A third key means it is not our wrapper.
      {
        mcpjamOrgCredentialRevision: "rev_a",
        resumeState: adapterState,
        extra: true,
      },
    ]) {
      expect(unstampOrgCredentialRevision(state)).toEqual({
        resumeState: state,
      });
    }
  });

  it("a renamed connection resumes: the key, and so the revision, is unchanged", () => {
    const { credentialRevision } = unstampOrgCredentialRevision(
      stampOrgCredentialRevision(adapterState, "rev_a"),
    );
    expect(orgResumeAllowed(credentialRevision, "rev_a")).toBe(true);
  });

  it("a replaced key starts fresh", () => {
    const { credentialRevision } = unstampOrgCredentialRevision(
      stampOrgCredentialRevision(adapterState, "rev_a"),
    );
    expect(orgResumeAllowed(credentialRevision, "rev_b")).toBe(false);
  });

  it("a state never produced on an org key never resumes an org turn", () => {
    const { credentialRevision } = unstampOrgCredentialRevision(adapterState);
    expect(orgResumeAllowed(credentialRevision, "rev_a")).toBe(false);
  });

  it("an org turn sees the adapter's own state and the revision it was stamped with", () => {
    const claimed = {
      harnessSessionId: "s1",
      resumeState: stampOrgCredentialRevision(adapterState, "rev_a"),
    };
    expect(stateForTurn(claimed, true)).toEqual({
      state: { harnessSessionId: "s1", resumeState: adapterState },
      credentialRevision: "rev_a",
    });
    // A hosted turn reads the lane as it is; nothing to strip.
    expect(stateForTurn(claimed, false)).toEqual({ state: claimed });
    expect(stateForTurn(null, true)).toEqual({ state: null });
  });

  it("a lane holds another key's state unless it was stamped with this one", () => {
    const lane = { state: { resumeState: adapterState } };
    expect(stateFromAnotherKey(lane, "rev_a", "rev_a")).toBe(false);
    expect(stateFromAnotherKey(lane, "rev_a", "rev_b")).toBe(true);
    expect(stateFromAnotherKey(lane, undefined, "rev_a")).toBe(true);
    // No committed state: nothing to keep apart.
    expect(stateFromAnotherKey({ state: null }, undefined, "rev_a")).toBe(
      false,
    );
  });

  it("a replaced key resets the lane, a runtime change only when state was committed", () => {
    expect(
      resetForReplacedKey({ state: { x: 1 }, stateVersion: 3, leaseId: "l" }),
    ).toEqual({
      state: null,
      stateVersion: 3,
      leaseId: "l",
      runtimeChanged: true,
    });
    expect(resetForReplacedKey({ state: null, stateVersion: 0 })).toEqual({
      state: null,
      stateVersion: 0,
      runtimeChanged: false,
    });
  });

  it("commits an org turn's state stamped, a hosted turn's as written", () => {
    expect(
      resumeStateToCommit(adapterState, { credentialRevision: "rev_a" }),
    ).toEqual(stampOrgCredentialRevision(adapterState, "rev_a"));
    expect(resumeStateToCommit(adapterState, undefined)).toBe(adapterState);
  });
});
