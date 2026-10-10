import { describe, expect, it } from "vitest";
import {
  orgResumeAllowed,
  orgUpstreamProfileFor,
  stampOrgCredentialRevision,
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

  it("maps each brokered harness to its native profile", () => {
    expect(orgUpstreamProfileFor("claude-code")).toBe("anthropic-native");
    expect(orgUpstreamProfileFor("codex")).toBe("openai-native");
    expect(orgUpstreamProfileFor("cursor")).toBeUndefined();
  });
});
