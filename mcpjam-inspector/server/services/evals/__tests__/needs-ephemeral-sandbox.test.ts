import { describe, expect, it } from "vitest";

import { needsEphemeralEvalSandbox } from "../needs-ephemeral-sandbox";

/**
 * Which iterations get a disposable box booted for them.
 *
 * Extracted from the runner so the rule can be exercised directly: as an inline
 * condition the only way to test it was to drive a whole iteration, which is
 * why the harness half of it was missing for so long. A harness run that boots
 * NO box does not fail — it silently runs on the acting member's personal
 * computer, because that is `runHarnessTurn`'s fallback when no sandbox binding
 * is supplied.
 */
describe("needsEphemeralEvalSandbox", () => {
  const RUN = "run-1";

  it("boots for a pinned environment, harness or not", () => {
    expect(
      needsEphemeralEvalSandbox({ pinnedEnvironmentId: "env-1", runId: RUN })
    ).toBe(true);
    expect(
      needsEphemeralEvalSandbox({
        pinnedEnvironmentId: "env-1",
        harness: "claude-code",
        runId: RUN,
      })
    ).toBe(true);
  });

  it("boots for a HARNESS run with no pinned environment", () => {
    // The case this function exists for. Before it, the runner keyed only on a
    // pinned image, so an unpinned harness run emitted no `harnessSandboxBinding`
    // and took the personal-computer path.
    expect(
      needsEphemeralEvalSandbox({ harness: "claude-code", runId: RUN })
    ).toBe(true);
  });

  it("boots NOTHING for an emulated run with no pinned environment", () => {
    // Unchanged, and deliberately so: booting a box here would start spending
    // for the entire emulated population, which needs no machine.
    expect(needsEphemeralEvalSandbox({ runId: RUN })).toBe(false);
    expect(
      needsEphemeralEvalSandbox({
        pinnedEnvironmentId: undefined,
        harness: undefined,
        runId: RUN,
      })
    ).toBe(false);
  });

  it("boots nothing without a run — the single-case surface", () => {
    // Both provisioning sites require a run id, so a single-case run can never
    // get a box; the admission gate refuses a harness there rather than letting
    // it reach the personal-computer fallback.
    for (const runId of [null, undefined]) {
      expect(
        needsEphemeralEvalSandbox({
          pinnedEnvironmentId: "env-1",
          harness: "claude-code",
          runId,
        })
      ).toBe(false);
    }
  });
});
