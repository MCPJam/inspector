import { describe, expect, it } from "vitest";
import { resolveIterationSkillsSource } from "../../evals-runner";

/**
 * The second seam of the two-channel skill decision (the first is
 * `runFrozenSkillOptions`), and a regression test for a bug that SHIPPED.
 *
 * #4146 wired a run's pinned skills into `pinnedSkillSource` for every eval
 * iteration, but neither iteration path learned that a harness must not receive
 * them — a harness gets its pins as SKILL.md on the box instead, and
 * `prepareChatV2` throws when handed both. The result: every harness eval run
 * whose environment carried at least one skill failed at setup with
 * `tokensUsed: 0`, while runs with no skills stayed green. That asymmetry is
 * why it went unnoticed, and it is what the third case below pins.
 */
describe("resolveIterationSkillsSource", () => {
  const pinned = {
    kind: "pinned" as const,
    skills: [{ name: "s", description: "d", content: "c", contentHash: "h" }],
  };

  it("forwards the run's pins on the EMULATED path", () => {
    expect(
      resolveIterationSkillsSource({
        harness: undefined,
        pinnedSkillSource: pinned,
      })
    ).toEqual(pinned);
  });

  it("is 'none' when an emulated run pinned nothing (never local-FS skills)", () => {
    expect(
      resolveIterationSkillsSource({
        harness: undefined,
        pinnedSkillSource: undefined,
      })
    ).toEqual({ kind: "none" });
  });

  it("REGRESSION: a harness run with pins gets 'none', not the pins", () => {
    // The pins are not dropped — they travel on `pinnedHarnessSkills` and are
    // materialized on the box. Handing them here as well is what threw.
    expect(
      resolveIterationSkillsSource({
        harness: "claude-code",
        pinnedSkillSource: pinned,
      })
    ).toEqual({ kind: "none" });
  });

  it("is 'none' for a harness run with no pins (unchanged behaviour)", () => {
    expect(
      resolveIterationSkillsSource({
        harness: "claude-code",
        pinnedSkillSource: undefined,
      })
    ).toEqual({ kind: "none" });
  });

  it("gates on the harness being SET, not on which harness it is", () => {
    for (const harness of ["claude-code", "codex"]) {
      expect(
        resolveIterationSkillsSource({ harness, pinnedSkillSource: pinned })
      ).toEqual({ kind: "none" });
    }
  });

  it("treats a `pinned-effective` source the same way", () => {
    // `pinned-effective` is chosen when a run needs the effective skill surface
    // (plugin pins, server-skill pins, or pins with supporting files). It is
    // still a pinned source, so it must not reach a harness turn either.
    const effective = { kind: "pinned-effective" as const, capabilities: {} };
    expect(
      resolveIterationSkillsSource({
        harness: "claude-code",
        pinnedSkillSource: effective as never,
      })
    ).toEqual({ kind: "none" });
  });
});
