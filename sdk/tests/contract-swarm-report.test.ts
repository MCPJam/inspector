import { describe, expect, it } from "vitest";
import verdictFixtures from "./fixtures/swarm-session-verdict-parity-fixtures.json";
import evalFixtures from "./fixtures/eval-verdict-policy-parity-fixtures.json";
import { evalVerdictDecisionSchema } from "../src/contract/verdict-policy.js";
import { swarmSessionVerdictSchema } from "../src/contract/swarm-session-verdict.js";
import {
  swarmTargetCaseId,
  assembleSwarmReport,
  foldSwarmRunVerdicts,
  swarmReportSchema,
  type SwarmReportInput,
} from "../src/contract/swarm-report.js";

function stripAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith("__"))
        .map(([key, v]) => [key, stripAnnotations(v)])
    );
  return value;
}
const verdict = (label: string) => {
  const row = verdictFixtures.derive.find((r) => r.__label === label);
  if (!row) throw new Error(`Missing fixture: ${label}`);
  return swarmSessionVerdictSchema.parse(row.expected);
};
const decision = evalVerdictDecisionSchema.parse(
  stripAnnotations(evalFixtures.accept.find((row) => row.__kind === "decision"))
);
function input(): SwarmReportInput {
  return {
    runId: "run",
    executionComplete: true,
    configuredSessions: 1,
    verdictSummary: { status: "decided", updatedAt: 1, decision },
    evaluatorDefinitions: [],
    sessions: [
      {
        id: "slot",
        startEvidence: "started",
        verdict: verdict("judge is the sole grader"),
        observations: [],
      },
    ],
  };
}

describe("canonical swarm report", () => {
  it("copies the authoritative decision even when the loaded session grade differs", () => {
    const data = input();
    data.sessions[0].verdict = verdict(
      "judge failure after completed execution"
    );
    const report = assembleSwarmReport(data);
    expect(report.verdict).toBe(decision.verdict);
    expect(report.decision).toEqual(decision);
    expect(report.goalGrading.failed).toBe(1);
    expect(swarmReportSchema.parse(report)).toEqual(report);
  });
  it("does not decide from passing sessions without an authoritative summary", () => {
    const data = input();
    data.verdictSummary = null;
    expect(assembleSwarmReport(data)).toMatchObject({
      verdict: "notEstablished",
      undecidedReason: "verdictSummaryUnavailable",
    });
  });
  it("does not show an old decision while regrading or execution is in progress", () => {
    const data = input();
    data.sessions[0].verdict.grading = { state: "queued" };
    expect(assembleSwarmReport(data)).toMatchObject({
      verdict: "notEstablished",
      undecidedReason: "gradingPending",
    });
    data.executionComplete = false;
    expect(assembleSwarmReport(data).undecidedReason).toBe("executionPending");
  });
  it("reports completed but ungraded as ran, never not run", () => {
    const data = input();
    data.verdictSummary = {
      status: "notEstablished",
      reason: "gradingNotConfigured",
      updatedAt: 1,
    };
    data.sessions[0].verdict = verdict(
      "completed but deliberately ungraded is never skipped"
    );
    const report = assembleSwarmReport(data);
    expect(report.execution).toMatchObject({
      started: 1,
      completed: 1,
      neverLaunched: false,
    });
    expect(report.goalGrading.notRequested).toBe(1);
    expect(report.undecidedReason).toBe("gradingNotConfigured");
  });
  it("preserves interrupted execution beside a passing goal assessment", () => {
    const data = input();
    data.verdictSummary = null;
    data.sessions[0].verdict = verdict(
      "interrupted execution never becomes completed after judge pass"
    );
    const report = assembleSwarmReport(data);
    expect(report.execution).toMatchObject({
      started: 1,
      completed: 0,
      interrupted: 1,
      neverLaunched: false,
    });
    expect(report.goalGrading.passed).toBe(1);
  });
  it("requires complete explicit non-start evidence to claim never launched", () => {
    const data = input();
    data.sessions[0].verdict = verdict("pre-start provider refusal");
    data.sessions[0].startEvidence = "notStarted";
    expect(assembleSwarmReport(data).execution.neverLaunched).toBe(true);
    data.configuredSessions = 2;
    expect(assembleSwarmReport(data).execution).toMatchObject({
      unknown: 1,
      neverLaunched: false,
    });
    data.configuredSessions = 1;
    data.sessions[0].startEvidence = "unknown";
    expect(assembleSwarmReport(data).execution.neverLaunched).toBe(false);
  });
  it("an empty population is not proof of a non-launch", () => {
    const data = input();
    data.sessions = [];
    data.configuredSessions = 0;
    expect(assembleSwarmReport(data).execution.neverLaunched).toBe(false);
  });
  it("does not count a setup failure as an interrupted session", () => {
    const data = input();
    data.sessions[0].verdict = verdict(
      "execution failed without captured transcript"
    );
    data.sessions[0].startEvidence = "notStarted";
    expect(assembleSwarmReport(data).execution).toMatchObject({
      interrupted: 0,
      neverLaunched: true,
    });
    data.sessions[0].startEvidence = "unknown";
    expect(assembleSwarmReport(data).execution).toMatchObject({
      interrupted: 0,
      neverLaunched: false,
    });
  });
  it("maps advisory observations by the shared stage contract and counts missing rows", () => {
    const data = input();
    const definition = {
      evaluatorId: "errors",
      predicateType: "noToolErrors" as const,
      role: "advisory" as const,
    };
    data.evaluatorDefinitions = [definition];
    data.sessions[0].observations = [{ ...definition, status: "failed" }];
    data.sessions.push({ ...data.sessions[0], id: "other", observations: [] });
    data.configuredSessions = 2;
    const report = assembleSwarmReport(data);
    expect(report.verdict).toBe("passed");
    expect(report.observations).toEqual([
      {
        ...definition,
        stage: "response",
        unit: "sessions",
        total: 2,
        passed: 0,
        failed: 1,
        pending: 0,
        unavailable: 1,
      },
    ]);
  });
  it("counts queued decisive grading even when a required failure already exists", () => {
    const data = input();
    data.sessions[0].verdict = verdict("required failure beats queued judge");
    const report = assembleSwarmReport(data);
    expect(report.goalGrading).toMatchObject({
      failed: 1,
      waitingForDecisiveGrading: 1,
    });
    expect(report.undecidedReason).toBe("gradingPending");
  });
  it("rejects duplicate identities, invented observations and contradictory non-starts", () => {
    const data = input();
    data.configuredSessions = 2;
    data.sessions.push(data.sessions[0]);
    expect(() => assembleSwarmReport(data)).toThrow();
    data.sessions.pop();
    data.sessions[0].startEvidence = "notStarted";
    expect(() => assembleSwarmReport(data)).toThrow();
    data.sessions[0].startEvidence = "started";
    data.sessions[0].observations = [
      {
        evaluatorId: "invented",
        predicateType: "noToolErrors",
        role: "advisory",
        status: "passed",
      },
    ];
    expect(() => assembleSwarmReport(data)).toThrow();
  });
  it("rejects a report whose verdict no longer matches its decision", () => {
    const report = assembleSwarmReport(input());
    expect(
      swarmReportSchema.safeParse({ ...report, verdict: "failed" }).success
    ).toBe(false);
    expect(
      swarmReportSchema.safeParse({
        ...report,
        execution: { ...report.execution, neverLaunched: true },
      }).success
    ).toBe(false);
  });
  it("folds decisions without claiming empty or partial waves passed", () => {
    expect(foldSwarmRunVerdicts([])).toBe("notEstablished");
    expect(foldSwarmRunVerdicts(["passed", "notEstablished"])).toBe(
      "notEstablished"
    );
    expect(foldSwarmRunVerdicts(["passed", "passed"])).toBe("passed");
    expect(foldSwarmRunVerdicts(["passed", "inconclusive"])).toBe(
      "inconclusive"
    );
    expect(foldSwarmRunVerdicts(["failed", "inconclusive"])).toBe("failed");
  });
});

it("encodes target identity without collisions in the eval case-id alphabet", () => {
  const ids = [
    "host:h1",
    "environment:e1:host:h1",
    "environment:e2:host:h1",
    "host:é",
  ];
  const encoded = ids.map(swarmTargetCaseId);
  expect(new Set(encoded).size).toBe(ids.length);
  for (let i = 0; i < ids.length; i++) {
    expect(encoded[i]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(Buffer.from(encoded[i].slice(7), "base64url").toString("utf8")).toBe(
      ids[i]
    );
  }
});
