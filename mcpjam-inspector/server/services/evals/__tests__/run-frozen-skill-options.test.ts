import { describe, expect, it } from "vitest";
import { runFrozenSkillOptions } from "../../evals-runner";
import type { PinnedSkillArtifact } from "@/shared/skill-types";

/**
 * The forwarding seam for a run's frozen skills.
 *
 * This exists because of a real bug: the suite runner accepted
 * `pinnedHarnessSkills` and forwarded only `pinnedSkillSource` into each case,
 * so every downstream hop received `undefined` and the harness fell through to
 * its LIVE project-wide fetch. Nothing errored — a frozen run just quietly
 * stopped being frozen, and the `skillsOverride: "exclude"` arm quietly ran
 * with the entire project pool.
 *
 * The leaf-level test passed throughout, because it called the turn helper
 * directly with the option the runner was failing to supply. So the guard has
 * to sit at the seam where the two channels are chosen, not at either end.
 */
const artifact: PinnedSkillArtifact = {
  name: "deploy",
  description: "ship it",
  content: "# Deploy",
  contentHash: "sha-1",
};

describe("runFrozenSkillOptions", () => {
  it("forwards BOTH channels together", () => {
    expect(
      runFrozenSkillOptions({
        pinnedSkillSource: { kind: "pinned", skills: [] },
        pinnedHarnessSkills: [artifact],
      })
    ).toEqual({
      pinnedSkillSource: { kind: "pinned", skills: [] },
      pinnedHarnessSkills: [artifact],
    });
  });

  it("forwards an EMPTY harness list — the skillsOverride:'exclude' arm", () => {
    // THE regression. `[]` means "this run delivers no skills". Dropped, the
    // harness falls through to the live pool and the without-skills arm of an
    // A/B runs with skills — while every other assertion still passes.
    const out = runFrozenSkillOptions({ pinnedHarnessSkills: [] });
    expect("pinnedHarnessSkills" in out).toBe(true);
    expect(out.pinnedHarnessSkills).toEqual([]);
  });

  it("forwards the harness channel even when the emulated one is absent", () => {
    // The two are independent: a quick run has no `pinnedSkillSource`, and that
    // must not suppress the harness delivery.
    expect(runFrozenSkillOptions({ pinnedHarnessSkills: [artifact] })).toEqual({
      pinnedHarnessSkills: [artifact],
    });
  });

  it("omits the harness channel only when it is genuinely undefined", () => {
    // Absent is the ONE case that legitimately falls through to a live fetch:
    // a run with no pins at all (a quick run, which has no run row to carry
    // them). Presence, not length, is what selects the pinned source.
    const out = runFrozenSkillOptions({
      pinnedSkillSource: { kind: "pinned", skills: [] },
    });
    expect("pinnedHarnessSkills" in out).toBe(false);
  });

  it("returns an empty object when the run froze nothing", () => {
    expect(runFrozenSkillOptions({})).toEqual({});
  });

  // ── Invalid input ────────────────────────────────────────────────────────
  // The type forbids these, but the value crosses a route boundary and a
  // persisted-data conversion before it gets here. Without the guard they are
  // not rejected anywhere: `null` passes every `!== undefined` presence check
  // downstream and only fails inside `pinnedArtifactsToRuntimeSkills`'s `.map`
  // — deep in the harness turn, after a sandbox has been provisioned and paid
  // for. Failing loudly at the seam turns that into an attributable error.

  it("REJECTS null rather than letting it crash mid-turn", () => {
    expect(() =>
      runFrozenSkillOptions({
        pinnedHarnessSkills: null as unknown as PinnedSkillArtifact[],
      })
    ).toThrow(/must be an array or undefined \(got null\)/);
  });

  it("REJECTS a non-array value, naming what it got", () => {
    for (const bad of ["deploy", 7, {}]) {
      expect(() =>
        runFrozenSkillOptions({
          pinnedHarnessSkills: bad as unknown as PinnedSkillArtifact[],
        })
      ).toThrow(/pinnedHarnessSkills must be an array or undefined/);
    }
  });

  it("does NOT inspect artifact contents — that is the adapter's job", () => {
    // The seam decides WHICH channels travel, not whether an artifact is
    // well-formed. `runPinnedSkillsToHarnessArtifacts` builds these from pin
    // rows and is where per-artifact validation (and the fail-the-run
    // behaviour for an unreachable file) lives, so re-checking here would
    // duplicate a rule that already has one owner.
    const malformed = [{ name: "x" }] as unknown as PinnedSkillArtifact[];
    expect(runFrozenSkillOptions({ pinnedHarnessSkills: malformed })).toEqual({
      pinnedHarnessSkills: malformed,
    });
  });
});
