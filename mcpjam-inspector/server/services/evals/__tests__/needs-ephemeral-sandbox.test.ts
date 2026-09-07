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
  const POLICY = { mode: "allow_all" as const };

  it("boots for a pinned environment, harness or not", () => {
    expect(
      needsEphemeralEvalSandbox({ pinnedEnvironmentId: "env-1", runId: RUN })
    ).toEqual({ needed: true, runtimeKind: "terminal" });
    expect(
      needsEphemeralEvalSandbox({
        pinnedEnvironmentId: "env-1",
        harness: "claude-code",
        runId: RUN,
      })
    ).toEqual({ needed: true, runtimeKind: "terminal" });
  });

  it("boots for a HARNESS run with no pinned environment", () => {
    // The case this function exists for. Before it, the runner keyed only on a
    // pinned image, so an unpinned harness run emitted no `harnessSandboxBinding`
    // and took the personal-computer path.
    expect(
      needsEphemeralEvalSandbox({ harness: "claude-code", runId: RUN })
    ).toEqual({ needed: true, runtimeKind: "terminal" });
  });

  it("boots NOTHING for an emulated run with no pinned environment", () => {
    // Unchanged, and deliberately so: booting a box here would start spending
    // for the entire emulated population, which needs no machine.
    expect(needsEphemeralEvalSandbox({ runId: RUN })).toEqual({
      needed: false,
      runtimeKind: "terminal",
    });
    expect(
      needsEphemeralEvalSandbox({
        pinnedEnvironmentId: undefined,
        harness: undefined,
        runId: RUN,
      })
    ).toEqual({ needed: false, runtimeKind: "terminal" });
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
      ).toEqual({ needed: false, runtimeKind: "terminal" });
    }
  });

  it("boots a DESKTOP box for a declared browser policy", () => {
    // The third trigger, and the only one that changes the image class: the
    // hosted engine has one computer per (project, member), so without a box
    // of its own every unattended run in a project would drive the same
    // Chromium, the same tab and the same cookie jar.
    expect(
      needsEphemeralEvalSandbox({
        builtInToolIds: ["browser"],
        browserToolPolicy: POLICY,
        runId: RUN,
      })
    ).toEqual({ needed: true, runtimeKind: "desktop-browser" });
  });

  it("a HARNESS plus a browser is still a desktop box", () => {
    expect(
      needsEphemeralEvalSandbox({
        harness: "claude-code",
        builtInToolIds: ["browser"],
        browserToolPolicy: POLICY,
        runId: RUN,
      })
    ).toEqual({ needed: true, runtimeKind: "desktop-browser" });
  });

  it("a PIN plus a browser still asks for the desktop — the backend refuses it, not us", () => {
    // One place decides the env-pin conflict, so the sentence the author reads
    // is the same on both surfaces (`desktop_pin_conflict`). Quietly downgrading
    // to a terminal box here would hand the run a browser that cannot start.
    expect(
      needsEphemeralEvalSandbox({
        pinnedEnvironmentId: "env-1",
        builtInToolIds: ["browser"],
        browserToolPolicy: POLICY,
        runId: RUN,
      })
    ).toEqual({ needed: true, runtimeKind: "desktop-browser" });
  });

  it("needs BOTH halves: the tool attached AND a policy declared", () => {
    // Nothing in an unattended run can approve a click, so a policy-less
    // `browser` advertises no tools at all — booting a desktop box for it
    // would be money for nothing, refused a moment later as
    // `desktop_not_advertised`.
    expect(
      needsEphemeralEvalSandbox({ builtInToolIds: ["browser"], runId: RUN })
    ).toEqual({ needed: false, runtimeKind: "terminal" });
    expect(
      needsEphemeralEvalSandbox({
        builtInToolIds: ["bash"],
        browserToolPolicy: POLICY,
        runId: RUN,
      })
    ).toEqual({ needed: false, runtimeKind: "terminal" });
    // ...and a MALFORMED policy is not a policy: `allowlist` naming nothing
    // would mean "everything", so the parser refuses it.
    expect(
      needsEphemeralEvalSandbox({
        builtInToolIds: ["browser"],
        browserToolPolicy: { mode: "allowlist" },
        runId: RUN,
      })
    ).toEqual({ needed: false, runtimeKind: "terminal" });
  });
});
