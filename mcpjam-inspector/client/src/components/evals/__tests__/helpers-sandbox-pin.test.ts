import { describe, expect, it } from "vitest";
import { CODE_EVALUATOR_RULES_FOR_MCPJAM } from "@/shared/local-eval-venue";
import { evalSandboxPhaseRefusal, evalSuitePinsSandboxImage } from "../helpers";

/**
 * The pin can come from TWO places — the suite's own field (migration-era
 * override) or an ATTACHED project environment. Missing the second source is
 * exactly how env-backed suites would slip past the cloud preflight.
 */
describe("evalSuitePinsSandboxImage", () => {
  const env = { environmentId: "env-1", computerEnvironmentId: "img-1" };
  const bareEnv = { environmentId: "env-2" };

  it("detects the suite-level pin", () => {
    expect(
      evalSuitePinsSandboxImage(
        { environment: { servers: [], computerEnvironmentId: "img-9" } },
        undefined,
      ),
    ).toBe(true);
  });

  it("detects a pin on an attached environment", () => {
    expect(
      evalSuitePinsSandboxImage(
        { environment: { servers: [] }, environmentIds: ["env-1"] },
        [env],
      ),
    ).toBe(true);
  });

  it("ignores attached environments without a pin", () => {
    expect(
      evalSuitePinsSandboxImage(
        { environment: { servers: [] }, environmentIds: ["env-2"] },
        [bareEnv],
      ),
    ).toBe(false);
  });

  it("ignores pinned environments that are NOT attached to this suite", () => {
    expect(
      evalSuitePinsSandboxImage(
        { environment: { servers: [] }, environmentIds: ["env-2"] },
        [env, bareEnv],
      ),
    ).toBe(false);
  });

  it("is false with no pins anywhere — including undefined env rows", () => {
    expect(
      evalSuitePinsSandboxImage(
        { environment: { servers: [] }, environmentIds: ["env-1"] },
        undefined,
      ),
    ).toBe(false);
    expect(evalSuitePinsSandboxImage({ environment: { servers: [] } }, [])).toBe(
      false,
    );
  });
});

/**
 * The same early message for scripts and code evaluators, named by the
 * backend rule it predicts: Run says why before the click instead of the
 * launch refusing after it.
 */
describe("evalSandboxPhaseRefusal", () => {
  const scripts = { scripts: { runSetup: "seed" } };

  it("predicts runner_without_sandboxes for any script on an Inspector without sandboxes", () => {
    expect(
      evalSandboxPhaseRefusal("suite", scripts, {
        ephemeralCloudAvailable: false,
      }),
    ).toEqual({
      rule: "runner_without_sandboxes",
      message:
        "This suite has setup and cleanup scripts, but this inspector can't run MCPJam cloud sandboxes.",
    });
    expect(
      evalSandboxPhaseRefusal(
        "suite",
        {
          ...scripts,
          codeEvaluators: [{ role: "required", script: "exit 0" }],
        },
        { ephemeralCloudAvailable: false },
      )?.message,
    ).toBe(
      "This suite has setup and cleanup scripts and Required code evaluators, but this inspector can't run MCPJam cloud sandboxes.",
    );
  });

  it("says nothing while sandboxes are reachable or still unknown", () => {
    for (const ephemeralCloudAvailable of [true, undefined]) {
      expect(
        evalSandboxPhaseRefusal("suite", scripts, { ephemeralCloudAvailable }),
      ).toBeNull();
    }
  });

  it("lets Advisory code evaluators run without sandboxes", () => {
    expect(
      evalSandboxPhaseRefusal(
        "suite",
        { codeEvaluators: [{ role: "advisory", script: "exit 0" }] },
        { ephemeralCloudAvailable: false },
      ),
    ).toBeNull();
  });

  it("predicts local_run for what needs the agent's box when the agent runs here", () => {
    const refusal = evalSandboxPhaseRefusal(
      "run",
      { scripts: { iterationSetup: "seed" } },
      { ephemeralCloudAvailable: true, localRun: true },
    );
    expect(refusal).toEqual({
      rule: "local_run",
      message:
        "This run has iteration setup and cleanup scripts, which can't run while its agent runs on this machine.",
    });
    // Run setup and cleanup get boxes of their own, so a local agent is fine.
    expect(
      evalSandboxPhaseRefusal("run", scripts, {
        ephemeralCloudAvailable: true,
        localRun: true,
      }),
    ).toBeNull();
  });

  it("names only the rules MCPJam's own runners lift", () => {
    const refusal = evalSandboxPhaseRefusal("suite", scripts, {
      ephemeralCloudAvailable: false,
    });
    expect(CODE_EVALUATOR_RULES_FOR_MCPJAM).toContain(refusal?.rule);
  });
});
