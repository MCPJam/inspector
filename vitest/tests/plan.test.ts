/**
 * The naming and message rules, tested without registering anything.
 *
 * `planEvalSuite` is pure precisely so these can be asserted directly. Testing
 * them through `describeEvalSuite` would mean asserting on vitest's own
 * registry from inside the run it is registering into.
 */
import { describe, expect, it } from "vitest";
import {
  EvalSuite,
  EvalTest,
  formatGateReport,
  GateError,
  type EvalRunResult,
  type GateReport,
} from "@mcpjam/sdk";
import {
  GATE_TEST_TITLE,
  gateFailureMessage,
  planEvalSuite,
  runAndAssertCase,
} from "../src/index.js";

let mintedCaseIds = 0;

function evalTest(name: string, externalCaseId?: string): EvalTest {
  mintedCaseIds += 1;
  // A corpus case declares its hosted id in BOTH fields — `id` and
  // `externalCaseId` are two claims about the same case, and `EvalTest`
  // rejects a differing pair. Only a local test mints an id of its own.
  return new EvalTest({
    id: externalCaseId ?? `c_plan_${mintedCaseIds}`,
    name,
    ...(externalCaseId ? { externalCaseId } : {}),
    test: async () => true,
  });
}

function suiteOf(...tests: EvalTest[]): EvalSuite {
  const suite = new EvalSuite({ name: "suite" });
  for (const test of tests) suite.add(test);
  return suite;
}

describe("planEvalSuite", () => {
  it("produces one entry per test, in suite order", () => {
    const plan = planEvalSuite(suiteOf(evalTest("first"), evalTest("second")));
    expect(plan.cases.map((entry) => entry.title)).toEqual(["first", "second"]);
  });

  it("appends the scenario id when a case came from a corpus", () => {
    const plan = planEvalSuite(suiteOf(evalTest("Refund flow", "case_123")));
    expect(plan.cases[0]).toEqual({
      title: "Refund flow [case_123]",
      testName: "Refund flow",
      scenarioId: "case_123",
      caseId: "case_123",
    });
  });

  it("carries the declared case id without putting it in the title", () => {
    // The `[id]` suffix is the hosted-dashboard grep handle and rides
    // `externalCaseId`. `caseId` is the declared identity, exposed for
    // reporters — swapping which one names the test would break those greps.
    const plan = planEvalSuite(suiteOf(evalTest("a local test")));
    expect(plan.cases[0].caseId).toMatch(/^c_plan_\d+$/);
    expect(plan.cases[0].title).toBe("a local test");
  });

  it("leaves a local test's name bare", () => {
    // Explicit ids only — a title is never parsed to guess one.
    const plan = planEvalSuite(suiteOf(evalTest("a local test")));
    expect(plan.cases[0].title).toBe("a local test");
    expect(plan.cases[0].scenarioId).toBeUndefined();
  });

  it("does not double-suffix a name the corpus already disambiguated", () => {
    // `resolveCaseNames` appends `[id]` to colliding titles, so appending again
    // here would render "Duplicate [case_1] [case_1]".
    const plan = planEvalSuite(
      suiteOf(evalTest("Duplicate [case_1]", "case_1"))
    );
    expect(plan.cases[0].title).toBe("Duplicate [case_1]");
  });

  it("registers a gate test only when a policy is given", () => {
    expect(planEvalSuite(suiteOf(evalTest("a"))).gateTestTitle).toBeUndefined();
    expect(
      planEvalSuite(suiteOf(evalTest("a")), { gate: { minimumPassRate: 1 } })
        .gateTestTitle
    ).toBe(GATE_TEST_TITLE);
  });
});

function runResult(overrides: Partial<EvalRunResult>): EvalRunResult {
  return { iterations: 3, successes: 3, failures: 0, ...overrides } as EvalRunResult;
}

describe("runAndAssertCase", () => {
  it("passes when no iteration failed", () => {
    expect(() => runAndAssertCase(runResult({}), "a")).not.toThrow();
  });

  it("reports how many of how many failed", () => {
    expect(() =>
      runAndAssertCase(runResult({ successes: 1, failures: 2 }), "a case")
    ).toThrow(/a case: 2 of 3 iterations failed/);
  });

  it("says 'iteration' in the singular", () => {
    expect(() =>
      runAndAssertCase(
        runResult({ iterations: 1, successes: 0, failures: 1 }),
        "a case"
      )
    ).toThrow(/1 of 1 iteration failed/);
  });

  it("includes the detailed report when one is available", () => {
    expect(() =>
      runAndAssertCase(
        runResult({ successes: 0, failures: 3 }),
        "a case",
        () => "iteration 1: expected tool `refund`"
      )
    ).toThrow(/expected tool `refund`/);
  });

  it("keeps the real failure when the detail report itself throws", () => {
    // A formatting fault must not replace the failure with a secondary one
    // about formatting it.
    expect(() =>
      runAndAssertCase(runResult({ successes: 0, failures: 3 }), "a case", () => {
        throw new Error("no run results available");
      })
    ).toThrow(/a case: 3 of 3 iterations failed/);
  });

  it("fails loudly when a case has no recorded result", () => {
    expect(() => runAndAssertCase(undefined, "a case")).toThrow(
      /No result was recorded/
    );
  });
});

describe("gateFailureMessage", () => {
  const report: GateReport = {
    outcome: "failed",
    scoreIntegrity: "valid",
    verdicts: [
      { gate: "passRate", status: "failed", message: "0.5 below minimum 0.9" },
    ],
  };

  it("renders the gate table from a GateError", () => {
    expect(gateFailureMessage(new GateError(report))).toBe(
      formatGateReport(report)
    );
  });

  it("renders it from any error carrying a report, not only via instanceof", () => {
    // A published wrapper can sit beside a second copy of @mcpjam/sdk, where
    // `instanceof` silently fails and the per-gate table would be lost.
    const foreign = Object.assign(new Error("Gate failed"), { report });
    expect(gateFailureMessage(foreign)).toBe(formatGateReport(report));
  });

  it("falls back to the message for an unrelated error", () => {
    expect(gateFailureMessage(new Error("connection refused"))).toBe(
      "connection refused"
    );
  });

  it("stringifies a non-Error throw", () => {
    expect(gateFailureMessage("boom")).toBe("boom");
  });
});
