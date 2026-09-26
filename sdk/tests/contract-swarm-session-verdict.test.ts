import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/swarm-session-verdict-parity-fixtures.json";
import {
  deriveSwarmSessionVerdict,
  swarmAttemptLifecycle,
  swarmSessionNeverRan,
  swarmSessionVerdictInputSchema,
  swarmSessionVerdictSchema,
  swarmSessionTrialSchema,
  SWARM_SESSION_VERDICT_REASONS,
  SWARM_SESSION_VERDICT_OF_REASON,
  type SwarmSessionVerdictInput,
} from "../src/contract/swarm-session-verdict.js";

describe("swarm verdict mirror corpus", () => {
  for (const row of fixtures.accept)
    it(`accept: ${row.__label}`, () => {
      expect(swarmSessionVerdictInputSchema.parse(row.input)).toEqual(
        row.input
      );
    });
  for (const row of fixtures.reject)
    it(`reject: ${row.__label}`, () => {
      expect(swarmSessionVerdictInputSchema.safeParse(row.input).success).toBe(
        false
      );
    });
  for (const row of fixtures.derive)
    it(row.__label, () => {
      const input = swarmSessionVerdictInputSchema.parse(row.input);
      const before = JSON.stringify(input);
      expect(deriveSwarmSessionVerdict(input)).toEqual(row.expected);
      expect(swarmSessionVerdictSchema.parse(row.expected)).toEqual(
        row.expected
      );
      expect(JSON.stringify(input)).toBe(before);
    });
  it("covers every reason with one fixed verdict", () => {
    expect(new Set(fixtures.derive.map((row) => row.expected.reason))).toEqual(
      new Set(SWARM_SESSION_VERDICT_REASONS)
    );
    for (const reason of SWARM_SESSION_VERDICT_REASONS) {
      expect(
        fixtures.derive
          .filter((row) => row.expected.reason === reason)
          .every(
            (row) =>
              row.expected.verdict === SWARM_SESSION_VERDICT_OF_REASON[reason]
          )
      ).toBe(true);
    }
  });
});

describe("verdict policy invariants", () => {
  const base = () =>
    swarmSessionVerdictInputSchema.parse(fixtures.accept[0].input);
  it("advisory measurements cannot change any settled judge outcome", () => {
    for (const passed of [true, false])
      for (const status of ["pending", "completed", "failed"] as const) {
        const input = base();
        input.goalScore = { status: "completed", passed };
        input.rubric = [
          { id: "check", role: "advisory", predicateType: "noToolErrors" },
        ];
        input.criteria = {
          status,
          results: [{ criterionId: "check", passed: !passed }],
        };
        expect(deriveSwarmSessionVerdict(input).verdict).toBe(
          passed ? "passed" : "failed"
        );
      }
  });
  it("a required failure cannot be rescued by any judge state", () => {
    const states: SwarmSessionVerdictInput["goalScore"][] = [
      null,
      { status: "running" },
      { status: "failed" },
      { status: "completed", passed: true },
      { status: "completed", passed: false },
    ];
    for (const goalScore of states) {
      const input = base();
      input.rubric = [{ id: "required", role: "required" }];
      input.criteria = {
        status: "completed",
        results: [{ criterionId: "required", passed: false }],
      };
      input.goalScore = goalScore;
      expect(deriveSwarmSessionVerdict(input).reason).toBe(
        "gatingCriterionFailed"
      );
    }
  });
  it("does not convert an interrupted trial to a completed trial when grading errors", () => {
    const input = base();
    input.attempt = { status: "failed" };
    input.goalScore = { status: "failed" };
    const output = deriveSwarmSessionVerdict(input);
    expect(output.verdict).toBe("inconclusive");
    expect(output.trial).toEqual({ status: "failed" });
  });
  it("settled missing required evidence is unavailable, not eternally pending", () => {
    const input = base();
    input.goalScore = null;
    expect(deriveSwarmSessionVerdict(input).reason).toBe("gradingUnavailable");
  });
  it("honors an explicitly requested non-automatic required judge", () => {
    const input = base();
    input.rubric = [{ id: "required", role: "required" }];
    input.criteria = {
      status: "completed",
      results: [{ criterionId: "required", passed: true }],
    };
    input.goalScore = null;
    input.judge = { automatic: false, requested: true, role: "required" };
    input.grading = { state: "queued" };
    expect(deriveSwarmSessionVerdict(input).reason).toBe("judgePending");
  });
  it("does not reuse a prior passing grade while a regrade is queued", () => {
    const input = base();
    input.grading = { state: "queued" };
    expect(deriveSwarmSessionVerdict(input)).toMatchObject({
      verdict: "notEstablished",
      reason: "judgePending",
      trial: null,
    });
  });
  it("rejects completion without grading, and grades on non-completed trials", () => {
    for (const row of [
      { status: "completed" },
      { status: "completed", taskVerdict: "passed", evaluatorError: true },
      { status: "failed", taskVerdict: "passed" },
      { status: "cancelled", evaluatorError: true },
      { status: "skipped" },
    ])
      expect(swarmSessionTrialSchema.safeParse(row).success).toBe(false);
  });
  it("rejects contradictory output and extra keys", () => {
    const output = deriveSwarmSessionVerdict(base());
    for (const patch of [
      { reason: "judgeFailed" },
      { verdictSource: "none" },
      { extra: true },
      { counts: { ...output.counts, gating: 1 } },
      { lifecycle: "broke" },
      { trial: { status: "completed", taskVerdict: "failed" } },
    ])
      expect(
        swarmSessionVerdictSchema.safeParse({ ...output, ...patch }).success
      ).toBe(false);
  });
});

it("an omitted advisory criterion is outside the completed claim scope", () => {
  const input = swarmSessionVerdictInputSchema.parse(fixtures.accept[0].input);
  input.rubric = [
    { id: "observed", role: "advisory" },
    { id: "not-claimed", role: "advisory" },
  ];
  input.criteria = {
    status: "completed",
    criterionIds: ["observed"],
    results: [{ criterionId: "observed", passed: true }],
  };
  expect(deriveSwarmSessionVerdict(input).graders.criteria).toBe("scored");
});

describe("swarmSessionNeverRan", () => {
  it("is true for an attempt that ended without a single message", () => {
    for (const lifecycle of ["broke", "limited", "withdrawn"] as const)
      expect(swarmSessionNeverRan(lifecycle, 0)).toBe(true);
  });

  it("is false once the session recorded anything", () => {
    // It ran, then failed: that is a finding about the server, not a refusal.
    expect(swarmSessionNeverRan("broke", 3)).toBe(false);
    expect(swarmSessionNeverRan("limited", 1)).toBe(false);
  });

  it("is false for a session that ran or has not ended", () => {
    for (const lifecycle of ["ran", "pending", "running"] as const)
      expect(swarmSessionNeverRan(lifecycle, 0)).toBe(false);
  });

  it("reads a refused attempt through the lifecycle it maps to", () => {
    const refused = swarmAttemptLifecycle(
      { status: "failed", errorCode: "session_failed" },
      false
    );
    expect(swarmSessionNeverRan(refused, 0)).toBe(true);
    const canceled = swarmAttemptLifecycle(
      { status: "failed", errorCode: "canceled" },
      false
    );
    expect(canceled).toBe("withdrawn");
    expect(swarmSessionNeverRan(canceled, 0)).toBe(true);
  });
});
