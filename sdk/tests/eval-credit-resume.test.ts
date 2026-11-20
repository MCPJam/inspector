import { describe, expect, it, vi } from "vitest";
import type { CreditRecovery } from "../src/contract/credit-recovery.js";
import {
  INCOMPLETE_CASES_LIMIT,
  incompleteCasesOfIterations,
  incompleteCasesOfRun,
  isCreditBlock,
  readEvalRunIncompleteCases,
  replayLaunchResumeInstruction,
  resumeSourceOfRun,
  stoppedRunResumeInstruction,
  withGroupLaunchKey,
} from "../src/eval-credit-resume.js";
import {
  creditStopResumeFields,
  resumesOnSourceTarget,
} from "../src/platform/eval-credit-resume-fields.js";

function recovery(overrides: Partial<CreditRecovery> = {}): CreditRecovery {
  return {
    version: 1,
    reason: "allowance_exhausted",
    action: "upgrade_plan",
    actor: "caller",
    url: "https://app.mcpjam.com/billing",
    ...overrides,
  };
}

function trial(
  status: string,
  testCaseId: string,
  extra: { infraError?: { recovery?: unknown } } = {}
) {
  return {
    status,
    testCaseId,
    title: `Case ${testCaseId}`,
    ...(extra.infraError
      ? {
          infraError: {
            kind: "account_limit",
            layer: "platform",
            retryable: false,
            ...extra.infraError,
          },
        }
      : {}),
  };
}

describe("isCreditBlock", () => {
  it("treats every person-must-act step as a block", () => {
    for (const action of [
      "upgrade_plan",
      "buy_credits",
      "ask_admin",
      "raise_budget",
      "contact_support",
    ] as const) {
      expect(isCreditBlock(recovery({ action }))).toBe(true);
    }
  });

  it("never treats waiting, or no recovery, as a block", () => {
    expect(isCreditBlock(recovery({ action: "wait" }))).toBe(false);
    expect(isCreditBlock(undefined)).toBe(false);
  });
});

describe("resumeSourceOfRun", () => {
  it("reads only the suite, never the run's target", () => {
    expect(resumeSourceOfRun({ suiteId: "s1" })).toEqual({ suiteId: "s1" });
    expect(resumeSourceOfRun({})).toEqual({});
  });
});

describe("resume instructions", () => {
  it("resumes a stopped run on its suite and names no target", () => {
    expect(
      stoppedRunResumeInstruction("p1", { id: "run_9", suiteId: "s1" })
    ).toEqual({
      tool: "run_eval_suite",
      arguments: { project: "p1", suite: "s1", resumeFromRunId: "run_9" },
    });
  });

  it("replays a refused launch with its selectors, knobs and group key", () => {
    const instruction = replayLaunchResumeInstruction({
      projectId: "p1",
      suiteId: "s1",
      input: {
        project: "Acme",
        suite: "Smoke",
        allAttached: true,
        compose: { host: "h1", models: ["m1", "m2"] },
        iterations: 3,
        notes: undefined,
        idempotencyKey: "k",
      },
    });
    expect(instruction).toEqual({
      tool: "run_eval_suite",
      arguments: {
        project: "p1",
        suite: "s1",
        allAttached: true,
        compose: { host: "h1", models: ["m1", "m2"] },
        iterations: 3,
        idempotencyKey: "k",
      },
    });
  });

  it("mints a group key only when the caller gave none", () => {
    expect(withGroupLaunchKey({ idempotencyKey: "k" })).toEqual({
      idempotencyKey: "k",
    });
    const minted = withGroupLaunchKey<{ idempotencyKey?: string }>({});
    expect(minted.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(withGroupLaunchKey<{ idempotencyKey?: string }>({})).not.toEqual(
      minted
    );
  });

  it("inherits the source target only when a resume names none", () => {
    expect(resumesOnSourceTarget({ resumeFromRunId: "r" })).toBe(true);
    expect(resumesOnSourceTarget({})).toBe(false);
    expect(
      resumesOnSourceTarget({ resumeFromRunId: "r", environment: "e" })
    ).toBe(false);
    expect(
      resumesOnSourceTarget({ resumeFromRunId: "r", compose: { host: "h" } })
    ).toBe(false);
  });
});

describe("incompleteCasesOfRun", () => {
  it("lists the backend's resume selection, titled from trials", () => {
    expect(
      incompleteCasesOfRun(
        { resumeSelection: { caseIds: ["c9", "c2"], totalCaseCount: 5 } },
        [trial("completed", "c2")]
      )
    ).toEqual({
      cases: [
        { testCaseId: "c9", title: null },
        { testCaseId: "c2", title: "Case c2" },
      ],
      truncated: false,
    });
  });

  it("falls back to unfinished trials without a selection", () => {
    expect(
      incompleteCasesOfRun({ resumeSelection: { caseIds: "bad" } }, [
        trial("skipped", "c3"),
      ])
    ).toEqual({ cases: [{ testCaseId: "c3", title: "Case c3" }], truncated: false });
  });
});

describe("incompleteCasesOfIterations", () => {
  it("lists interrupted and skipped cases once each, never finished ones", () => {
    const result = incompleteCasesOfIterations([
      trial("completed", "c1"),
      trial("failed", "c2", { infraError: { recovery: recovery() } }),
      trial("skipped", "c3"),
      trial("skipped", "c3"),
      trial("completed", "c4"),
      trial("failed", "c5"),
    ]);
    expect(result).toEqual({
      cases: [
        { testCaseId: "c2", title: "Case c2" },
        { testCaseId: "c3", title: "Case c3" },
      ],
      truncated: false,
    });
  });

  it("caps the list and says so", () => {
    const trials = Array.from({ length: INCOMPLETE_CASES_LIMIT + 5 }, (_, i) =>
      trial("skipped", `c${i}`)
    );
    const result = incompleteCasesOfIterations(trials);
    expect(result.cases).toHaveLength(INCOMPLETE_CASES_LIMIT);
    expect(result.truncated).toBe(true);
  });

  it("reads one page and reports a partial page as truncated", async () => {
    const listEvalRunIterations = vi.fn().mockResolvedValue({
      items: [trial("skipped", "c1")],
      nextCursor: "next",
    });
    const result = await readEvalRunIncompleteCases(
      { listEvalRunIterations },
      undefined,
      "p1",
      { id: "run_1" }
    );
    expect(result).toEqual({
      cases: [{ testCaseId: "c1", title: "Case c1" }],
      truncated: true,
    });
  });

  it("gives nothing when the read fails", async () => {
    const listEvalRunIterations = vi.fn().mockRejectedValue(new Error("down"));
    expect(
      await readEvalRunIncompleteCases(
        { listEvalRunIterations },
        undefined,
        "p1",
        { id: "run_1" }
      )
    ).toBeUndefined();
  });
});

describe("creditStopResumeFields (get_eval_run)", () => {
  const run = { id: "run_9", suiteId: "s1" };

  it("adds the resume call and the unfinished cases for a block", async () => {
    const listEvalRunIterations = vi.fn().mockResolvedValue({
      items: [trial("completed", "c1"), trial("skipped", "c2")],
    });
    expect(
      await creditStopResumeFields(
        { listEvalRunIterations },
        undefined,
        "p1",
        run,
        recovery()
      )
    ).toEqual({
      resume: stoppedRunResumeInstruction("p1", run),
      incompleteCases: {
        cases: [{ testCaseId: "c2", title: "Case c2" }],
        truncated: false,
      },
    });
  });

  it("adds nothing, and reads nothing, for a wait or no recovery", async () => {
    const listEvalRunIterations = vi.fn();
    for (const value of [recovery({ action: "wait" }), undefined]) {
      expect(
        await creditStopResumeFields(
          { listEvalRunIterations },
          undefined,
          "p1",
          run,
          value
        )
      ).toEqual({});
    }
    expect(listEvalRunIterations).not.toHaveBeenCalled();
  });
});
