import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REGRADE_WRITE_BATCH,
  regradeIteration,
  runRegrade,
  type RegradeEvidencePage,
  type RegradeEvidenceRow,
} from "../regrade-run";
import { storedTraceVerdict } from "../stored-trace-verdict";
import type { Predicate } from "@/shared/eval-matching";

afterEach(() => {
  vi.restoreAllMocks();
});

const messages = [
  { role: "user", content: "find cats" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "search",
        input: { q: "cats" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "search",
        output: { type: "json", value: { hits: 3 } },
      },
    ],
  },
  { role: "assistant", content: "Found 3 cats." },
];
const actualToolCalls = [{ toolName: "search", arguments: { q: "cats" } }];
const expectedToolCalls = [{ toolName: "search", arguments: { q: "cats" } }];
const wrongNeedle: Predicate = { type: "responseContains", needle: "dogs" };
const rightNeedle: Predicate = { type: "responseContains", needle: "cats" };

/** What the live run recorded for these rules: its rows, in order. */
function recordedRows(rules: Predicate[]) {
  return storedTraceVerdict(
    { expectedToolCalls, actualToolCalls, messages },
    { effectivePredicates: rules },
  ).predicateResults;
}

/** A completed iteration graded by `rules`, its verdict as live grading set it. */
function evidenceRow(
  rules: Predicate[],
  overrides: Partial<RegradeEvidenceRow> = {},
): RegradeEvidenceRow {
  const rows = recordedRows(rules);
  return {
    iterationId: "iteration-1",
    caseId: "case",
    status: "completed",
    result: rows.every((row) => row.passed) ? "passed" : "failed",
    updatedAt: 1_000,
    gradingRevision: 0,
    actualToolCalls,
    expectedToolCalls,
    isNegativeTest: false,
    query: "find cats",
    predicates: rules,
    caseShape: { turns: 1, transcriptOnly: true },
    recorded: { predicateResults: rows, scoreRows: "none" },
    evidence: { traceVersion: 1, traceComplete: true, messages },
    completeness: { transcript: "complete" },
    ...overrides,
  };
}

const replaceWith = (list: Predicate[]) => ({
  assertions: { mode: "replace" as const, list },
});
const inherit = { assertions: { mode: "inherit" as const, list: [] } };

describe("regradeIteration", () => {
  it("re-grades a predicate change into a new verdict", () => {
    const row = evidenceRow([wrongNeedle]);
    expect(row.result).toBe("failed");
    const outcome = regradeIteration(row, replaceWith([rightNeedle]));
    expect(outcome).toMatchObject({
      kind: "graded",
      result: "passed",
      changed: true,
      carriedChecks: 0,
    });
    if (outcome.kind !== "graded") throw new Error("unreachable");
    expect(outcome.predicateResults).toEqual(recordedRows([rightNeedle]));
  });

  it("reproduces the recorded verdict when nothing changed", () => {
    expect(regradeIteration(evidenceRow([rightNeedle]), inherit)).toMatchObject(
      { kind: "graded", result: "passed", changed: false },
    );
    expect(regradeIteration(evidenceRow([wrongNeedle]), inherit)).toMatchObject(
      { kind: "graded", result: "failed", changed: false },
    );
  });

  it("never touches an iteration that did not complete", () => {
    // E1: an infrastructure error is `status: failed` + `result: failed`.
    expect(
      regradeIteration(
        evidenceRow([wrongNeedle], { status: "failed" }),
        replaceWith([rightNeedle]),
      ),
    ).toMatchObject({ kind: "skipped", reason: /completed/ });
  });

  it("leaves iterations the score contract or the trace cannot speak for", () => {
    const draft = replaceWith([rightNeedle]);
    for (const overrides of [
      {
        recorded: { predicateResults: [], scoreRows: "authoritative" as const },
      },
      { caseShape: { turns: 1, transcriptOnly: false } },
      { caseShape: { turns: 2, transcriptOnly: true } },
      { evidence: null, completeness: { transcript: "incomplete" } },
      {
        evidence: { traceVersion: 1, traceComplete: false, messages },
      },
    ] satisfies Array<Partial<RegradeEvidenceRow>>) {
      expect(
        regradeIteration(evidenceRow([wrongNeedle], overrides), draft).kind,
      ).toBe("skipped");
    }
  });

  it("refuses a verdict the stored trace does not reproduce", () => {
    // Recorded as failed with every recorded check passing: the failure came
    // from something the trace does not carry (a pinned tool error, a widget
    // check), so re-grading could only launder it.
    const row = evidenceRow([rightNeedle], { result: "failed" });
    expect(regradeIteration(row, replaceWith([rightNeedle]))).toMatchObject({
      kind: "skipped",
      reason: /not reproducible/,
    });
  });

  it("keeps a recorded row for a check the trace cannot evaluate", () => {
    const widget: Predicate = { type: "widgetRendered" };
    const widgetRow = {
      predicate: widget,
      passed: true,
      reason: "widget rendered (1/1 observation(s))",
    };
    const row = evidenceRow([wrongNeedle], {
      predicates: [wrongNeedle, widget],
      recorded: {
        predicateResults: [...recordedRows([wrongNeedle]), widgetRow],
        scoreRows: "none",
      },
    });
    const outcome = regradeIteration(row, replaceWith([rightNeedle, widget]));
    expect(outcome).toMatchObject({
      kind: "graded",
      result: "passed",
      carriedChecks: 1,
    });
    // With no recorded row to keep, the iteration is left alone.
    expect(
      regradeIteration(
        evidenceRow([wrongNeedle]),
        replaceWith([rightNeedle, { type: "tokenBudgetUnder", tokens: 10 }]),
      ),
    ).toMatchObject({ kind: "skipped", reason: /tokenBudgetUnder/ });
  });

  it("carries a judge downgrade: the judge is never re-asked or overruled", () => {
    const row = evidenceRow([rightNeedle], {
      result: "failed",
      recorded: {
        predicateResults: recordedRows([rightNeedle]),
        scoreRows: "none",
        verdictDowngradedBy: "judge",
      },
    });
    expect(regradeIteration(row, replaceWith([rightNeedle]))).toMatchObject({
      kind: "graded",
      result: "failed",
    });
  });

  it("refuses to inherit frozen rules that are not what was evaluated", () => {
    const row = evidenceRow([wrongNeedle], {
      predicates: [{ type: "noToolErrors" }],
    });
    expect(regradeIteration(row, inherit)).toMatchObject({
      kind: "skipped",
      reason: /do not match/,
    });
  });
});

describe("runRegrade", () => {
  function pages(rows: RegradeEvidenceRow[]) {
    const out: RegradeEvidencePage[] = [];
    for (let start = 0; start < rows.length; start += 5) {
      const isDone = start + 5 >= rows.length;
      out.push({
        schemaVersion: 1,
        runId: "run",
        suiteId: "suite",
        isDone,
        ...(isDone ? {} : { cursor: `cursor-${start + 5}` }),
        iterations: rows.slice(start, start + 5),
      });
    }
    return out;
  }

  it("persists only changed verdicts, guarded by the revision it read, with no model call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rows = Array.from({ length: 31 }, (_, index) =>
      evidenceRow(index % 2 === 0 ? [wrongNeedle] : [rightNeedle], {
        iterationId: `iteration-${index}`,
        gradingRevision: index === 0 ? 3 : 0,
        updatedAt: 1_000 + index,
      }),
    );
    const readPage = vi.fn();
    for (const page of pages(rows)) readPage.mockResolvedValueOnce(page);
    const applyBatch = vi.fn(
      async (args: { iterations: { iterationId: string }[] }) => ({
        regraded: args.iterations.length,
        flipped: args.iterations.length,
        result: "passed",
        summary: { total: 31, passed: 31, failed: 0, passRate: 1 },
        iterations: args.iterations.map((item) => ({
          iterationId: item.iterationId,
          gradingRevision: 1,
        })),
      }),
    );

    const report = await runRegrade({
      runId: "run",
      suiteId: "suite",
      draft: replaceWith([rightNeedle]),
      dryRun: false,
      readPage,
      applyBatch,
    });

    // Every page read before any write.
    expect(readPage).toHaveBeenCalledTimes(7);
    expect(readPage.mock.calls[1][0]).toMatchObject({ cursor: "cursor-5" });
    expect(applyBatch.mock.invocationCallOrder[0]).toBeGreaterThan(
      readPage.mock.invocationCallOrder.at(-1)!,
    );
    // Only the 16 failures changed; batched under the backend's cap.
    const written = applyBatch.mock.calls.flatMap(
      ([args]) => args.iterations,
    ) as Array<Record<string, unknown>>;
    expect(written).toHaveLength(16);
    expect(
      applyBatch.mock.calls.every(
        ([args]) => args.iterations.length <= REGRADE_WRITE_BATCH,
      ),
    ).toBe(true);
    expect(written[0]).toMatchObject({
      iterationId: "iteration-0",
      expectedGradingRevision: 3,
      expectedUpdatedAt: 1_000,
      result: "passed",
    });
    expect(report).toMatchObject({
      applied: true,
      dryRun: false,
      counts: { iterations: 31, regraded: 16, unchanged: 15, flipped: 16 },
      run: { result: "passed" },
      modelUse: "none",
    });
    expect(
      report.iterations.find((item) => item.iterationId === "iteration-0"),
    ).toMatchObject({ outcome: "regraded", gradingRevision: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a dry run reports the same diff and writes nothing", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValue(pages([evidenceRow([wrongNeedle])])[0]);
    const applyBatch = vi.fn();
    const report = await runRegrade({
      runId: "run",
      suiteId: "suite",
      draft: replaceWith([rightNeedle]),
      dryRun: true,
      readPage,
      applyBatch,
    });
    expect(applyBatch).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      applied: false,
      dryRun: true,
      counts: { regraded: 1, flipped: 1 },
      iterations: [
        {
          outcome: "regraded",
          stored: { result: "failed", gradingRevision: 0 },
          regraded: { result: "passed" },
          flipped: true,
        },
      ],
    });
    expect(report).not.toHaveProperty("run");
  });

  it("refuses duplicate identities rather than grading twice", async () => {
    const row = evidenceRow([wrongNeedle]);
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ ...pages([row])[0], isDone: false, cursor: "c" })
      .mockResolvedValueOnce(pages([row])[0]);
    await expect(
      runRegrade({
        runId: "run",
        suiteId: "suite",
        draft: inherit,
        dryRun: false,
        readPage,
        applyBatch: vi.fn(),
      }),
    ).rejects.toThrow(/Duplicate/);
  });

  it("reports what landed when a LATER batch fails", async () => {
    const { RegradePartiallyAppliedError } = await import("../regrade-run");
    // 30 changed rows: two batches. The first commits; the second is stale.
    const rows = Array.from({ length: 30 }, (_, index) =>
      evidenceRow([wrongNeedle], {
        iterationId: `iteration-${index}`,
        updatedAt: 1_000 + index,
      }),
    );
    const readPage = vi.fn();
    for (const page of pages(rows)) readPage.mockResolvedValueOnce(page);
    const applyBatch = vi
      .fn()
      .mockImplementationOnce(
        async (args: { iterations: { iterationId: string }[] }) => ({
          regraded: args.iterations.length,
          iterations: args.iterations.map((item) => ({
            iterationId: item.iterationId,
            gradingRevision: 1,
          })),
        }),
      )
      .mockRejectedValueOnce(
        new Error("EVAL_REGRADE_STALE: the iteration changed"),
      );
    const error = await runRegrade({
      runId: "run",
      suiteId: "suite",
      draft: replaceWith([rightNeedle]),
      dryRun: false,
      readPage,
      applyBatch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegradePartiallyAppliedError);
    const partial = error as InstanceType<typeof RegradePartiallyAppliedError>;
    expect(partial.message).toMatch(/EVAL_REGRADE_STALE/);
    expect(partial.committedIterationIds).toHaveLength(25);
    expect(partial.changedIterations).toBe(30);
  });

  it("surfaces a stale write from the backend", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValue(pages([evidenceRow([wrongNeedle])])[0]);
    const applyBatch = vi
      .fn()
      .mockRejectedValue(
        new Error("EVAL_REGRADE_STALE: the iteration changed"),
      );
    await expect(
      runRegrade({
        runId: "run",
        suiteId: "suite",
        draft: replaceWith([rightNeedle]),
        dryRun: false,
        readPage,
        applyBatch,
      }),
    ).rejects.toThrow(/EVAL_REGRADE_STALE/);
  });
});
