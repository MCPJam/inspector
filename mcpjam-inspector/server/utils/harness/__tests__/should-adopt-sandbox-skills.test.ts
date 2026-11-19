import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deployment = vi.hoisted(() => ({ hosted: false }));
vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  get HOSTED_MODE() {
    return deployment.hosted;
  },
}));

import { shouldAdoptSandboxSkills } from "../adopt-sandbox-skills";

/**
 * Turn-end adoption is a WRITE back into the live project pool, so the question
 * "may this turn adopt?" is a correctness question, not a convenience one.
 *
 * The case that matters most is `skillsArePinned`. Before it was checked, a
 * pinned harness eval run could sync a skill its agent authored on box up into
 * the project — mutating the pool the NEXT arm of a skill A/B resolves against.
 * Two runs meant to differ only in their pinned skills would then differ in the
 * pool too, and nothing would say so.
 */
const base = {
  runSucceeded: true,
  aborted: false,
  pausedForApproval: false,
  supportsSkills: true,
  runtimeSkillsKnown: true,
  skillsArePinned: false,
  hasExecutionScope: false,
  hasCredentials: true,
  hasFileSession: true,
};

beforeEach(() => {
  // A self-hosted Inspector with no operator setting, whatever the shell has.
  deployment.hosted = false;
  vi.stubEnv("HARNESS_SKILL_ADOPTION_DISABLED", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shouldAdoptSandboxSkills", () => {
  it("adopts on a clean, unpinned, in-scope turn on a self-hosted Inspector", () => {
    expect(shouldAdoptSandboxSkills(base)).toBe(true);
  });

  it("REGRESSION: never adopts out of a PINNED turn", () => {
    expect(
      shouldAdoptSandboxSkills({ ...base, skillsArePinned: true })
    ).toBe(false);
  });

  it("does not adopt when the turn did not cleanly succeed", () => {
    expect(shouldAdoptSandboxSkills({ ...base, runSucceeded: false })).toBe(
      false
    );
    expect(shouldAdoptSandboxSkills({ ...base, aborted: true })).toBe(false);
    expect(
      shouldAdoptSandboxSkills({ ...base, pausedForApproval: true })
    ).toBe(false);
  });

  it("does not adopt when the live skills set is UNKNOWN", () => {
    // A failed fetch is not "no skills" — adopting against an unknown set could
    // re-adopt something already managed.
    expect(shouldAdoptSandboxSkills({ ...base, runtimeSkillsKnown: false })).toBe(
      false
    );
  });

  it("does not adopt inside a guest/swarm execution scope", () => {
    expect(shouldAdoptSandboxSkills({ ...base, hasExecutionScope: true })).toBe(
      false
    );
  });

  it("does not adopt without credentials, a file session, or a skills-capable adapter", () => {
    expect(shouldAdoptSandboxSkills({ ...base, hasCredentials: false })).toBe(
      false
    );
    expect(shouldAdoptSandboxSkills({ ...base, hasFileSession: false })).toBe(
      false
    );
    expect(shouldAdoptSandboxSkills({ ...base, supportsSkills: false })).toBe(
      false
    );
  });

  it("honours the operator kill switch on a self-hosted Inspector", () => {
    vi.stubEnv("HARNESS_SKILL_ADOPTION_DISABLED", "1");
    expect(shouldAdoptSandboxSkills(base)).toBe(false);
  });

  it("never adopts on the hosted app, with no operator setting", () => {
    // An agent's SKILL.md on a hosted box must not become a project skill.
    deployment.hosted = true;
    expect(shouldAdoptSandboxSkills(base)).toBe(false);
  });

  it("the operator setting cannot turn adoption back on for the hosted app", () => {
    deployment.hosted = true;
    vi.stubEnv("HARNESS_SKILL_ADOPTION_DISABLED", "0");
    expect(shouldAdoptSandboxSkills(base)).toBe(false);
  });
});
