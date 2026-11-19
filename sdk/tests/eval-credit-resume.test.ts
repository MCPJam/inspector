import { describe, expect, it, vi } from "vitest";
import type { CreditRecovery } from "../src/contract/credit-recovery.js";
import {
  INCOMPLETE_CASES_LIMIT,
  incompleteCasesOfIterations,
  isCreditBlock,
  readEvalRunIncompleteCases,
  refusedTargetResumeInstruction,
  resumeIdempotencyKeyForTarget,
  resumeSourceOfRun,
  stoppedRunResumeInstruction,
} from "../src/eval-credit-resume.js";
import { creditStopResumeFields } from "../src/platform/eval-credit-resume-fields.js";

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
  it("reads the suite and the run's own target", () => {
    expect(
      resumeSourceOfRun({
        suiteId: "s1",
        environment: { id: "env_1" },
        client: { id: "host_1", source: "environment" },
      })
    ).toEqual({ suiteId: "s1", environmentId: "env_1" });
    expect(
      resumeSourceOfRun({
        suiteId: "s1",
        environment: null,
        client: { id: "host_1", source: "attached_host" },
      })
    ).toEqual({ suiteId: "s1", hostId: "host_1" });
    expect(
      resumeSourceOfRun({
        suiteId: "s1",
        client: { id: "host_1", source: "suite_default" },
      })
    ).toEqual({ suiteId: "s1" });
  });
});

describe("resume instructions", () => {
  it("resumes a stopped run on its own suite and target", () => {
    expect(
      stoppedRunResumeInstruction("p1", {
        id: "run_9",
        suiteId: "s1",
        environment: { id: "env_1" },
      })
    ).toEqual({
      tool: "run_eval_suite",
      arguments: {
        project: "p1",
        suite: "s1",
        environment: "env_1",
        resumeFromRunId: "run_9",
      },
    });
  });

  it("re-launches one refused target with the launch's knobs and a per-target key", () => {
    const instruction = refusedTargetResumeInstruction(
      {
        projectId: "p1",
        suiteId: "s1",
        input: {
          project: "Acme",
          suite: "Smoke",
          allAttached: true,
          environments: ["a", "b"],
          iterations: 3,
          notes: undefined,
          idempotencyKey: "k",
        },
      },
      { hostId: "host_2" }
    );
    expect(instruction).toEqual({
      tool: "run_eval_suite",
      arguments: {
        project: "p1",
        suite: "s1",
        client: "host_2",
        iterations: 3,
        idempotencyKey: "k:host_2",
      },
    });
  });

  it("keeps per-target keys distinct and inside the key limit", () => {
    const long = "k".repeat(256);
    const a = resumeIdempotencyKeyForTarget(long, "env_a");
    const b = resumeIdempotencyKeyForTarget(long, "env_b");
    expect(a).not.toBe(b);
    expect(a.length).toBe(256);
    expect(a.endsWith(":env_a")).toBe(true);
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
      "run_1"
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
        "run_1"
      )
    ).toBeUndefined();
  });
});

describe("creditStopResumeFields (get_eval_run)", () => {
  const run = { id: "run_9", suiteId: "s1", environment: { id: "env_1" } };

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
