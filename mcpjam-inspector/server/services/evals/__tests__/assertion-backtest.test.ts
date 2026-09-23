import { hostedPredicateScoreDefinition } from "../score-definitions";
import { it, expect, vi } from "vitest";
import { backtestIteration, runAssertionBacktest } from "../assertion-backtest";
import {
  predicateScoreDefinition,
  resolveScoreDefinition,
  scoreResultFromPredicateResult,
} from "@mcpjam/sdk/contract";
import { evaluatePredicates } from "@mcpjam/sdk/predicates";
const oldRule = { type: "responseContains" as const, needle: "hello" };
const definition = resolveScoreDefinition(
  predicateScoreDefinition(oldRule, { ordinal: 0 }),
);
const result = scoreResultFromPredicateResult(
  definition,
  evaluatePredicates({ toolCalls: [], finalAssistantMessage: "hello" }, [
    oldRule,
  ])[0],
);
const row = {
  iterationId: "iteration",
  caseId: "case",
  actualToolCalls: [],
  predicates: [oldRule],
  evaluationConfig: { definitions: [definition] },
  results: [result],
  evidence: {
    traceVersion: 1,
    traceComplete: true,
    messages: [{ role: "assistant", content: "hello" }],
  },
  completeness: { transcript: "complete" },
};
const draft = {
  assertions: {
    mode: "replace" as const,
    list: [{ type: "responseContains" as const, needle: "goodbye" }],
  },
};
it("compares aligned definitions and preserves original evidence", () => {
  const before = JSON.stringify(row);
  const differences = backtestIteration(row, draft);
  expect(differences[0]).toMatchObject({
    comparable: true,
    flipped: true,
    change: "configuration_changed",
  });
  expect(JSON.stringify(row)).toBe(before);
});
it("does not turn absent evidence or absent original results into flips", () => {
  expect(backtestIteration({ ...row, evidence: null }, draft)[0]).toMatchObject(
    { comparable: false },
  );
  expect(backtestIteration({ ...row, results: [] }, draft)[0]).toMatchObject({
    comparable: false,
  });
  expect(
    backtestIteration({ ...row, results: [] }, draft)[0].flipped,
  ).toBeUndefined();
});
it("does not fabricate tool inventories", () => {
  const differences = backtestIteration(row, {
    assertions: {
      mode: "replace",
      list: [{ type: "argumentsMatchToolSchema", toolName: "search" }],
    },
  });
  expect(differences[0].draft?.status).toBe("error");
});
it("reuses reservation and frozen source across pages", async () => {
  const readPage = vi
    .fn()
    .mockResolvedValueOnce({
      schemaVersion: 1,
      runId: "run",
      suiteId: "suite",
      sourceHash: "source",
      reservationId: "reservation",
      isDone: false,
      cursor: "next",
      iterations: [row],
    })
    .mockResolvedValueOnce({
      schemaVersion: 1,
      runId: "run",
      suiteId: "suite",
      sourceHash: "source",
      reservationId: "reservation",
      isDone: true,
      iterations: [{ ...row, iterationId: "two" }],
    });
  const report = await runAssertionBacktest({
    runId: "run",
    suiteId: "suite",
    draft,
    readPage,
  });
  expect(readPage.mock.calls[1][0]).toMatchObject({
    cursor: "next",
    sourceHash: "source",
    reservationId: "reservation",
  });
  expect(report.counts).toMatchObject({
    iterations: 2,
    comparable: 2,
    flipped: 2,
  });
});
it("rejects duplicate pagination identities", async () => {
  const readPage = vi.fn().mockResolvedValue({
    schemaVersion: 1,
    runId: "run",
    suiteId: "suite",
    sourceHash: "source",
    reservationId: "reservation",
    isDone: false,
    cursor: "next",
    iterations: [row],
  });
  await expect(
    runAssertionBacktest({ runId: "run", suiteId: "suite", draft, readPage }),
  ).rejects.toThrow("Duplicate");
});
it("refuses an already cancelled backtest without evidence calls", async () => {
  const controller = new AbortController();
  controller.abort();
  const readPage = vi.fn();
  await expect(
    runAssertionBacktest({
      runId: "run",
      suiteId: "suite",
      draft,
      readPage,
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled");
  expect(readPage).not.toHaveBeenCalled();
});

it("does not guess missing frozen tool polarity for matcher previews", () => {
  const differences = backtestIteration(row, {
    assertions: { mode: "replace", list: [] },
    matchOptions: { argumentMatching: "exact" },
  });
  expect(
    differences.find((item) => item.evaluatorId === "tool-match"),
  ).toMatchObject({
    comparable: false,
    reason: "Frozen tool expectations or test polarity are unavailable",
  });
});
it("evaluates recorded tool expectations without inventing original matcher results", () => {
  const differences = backtestIteration(
    {
      ...row,
      expectedToolCalls: [{ toolName: "search", arguments: {} }],
      actualToolCalls: [{ toolName: "search", arguments: {} }],
      isNegativeTest: false,
    },
    {
      assertions: { mode: "replace", list: [] },
      matchOptions: { argumentMatching: "exact" },
    },
  );
  expect(
    differences.find((item) => item.evaluatorId === "tool-match"),
  ).toMatchObject({
    comparable: false,
    draft: { status: "scored", passed: true },
  });
});

it("joins unchanged hosted content-derived identities without renumbering them", () => {
  const hosted = resolveScoreDefinition(
    hostedPredicateScoreDefinition({ predicate: oldRule }),
  );
  const stored = scoreResultFromPredicateResult(
    hosted,
    evaluatePredicates({ toolCalls: [], finalAssistantMessage: "hello" }, [
      oldRule,
    ])[0],
  );
  const source = {
    ...row,
    evaluationConfig: { definitions: [hosted] },
    results: [stored],
  };
  const unchanged = backtestIteration(source, {
    assertions: { mode: "replace", list: [oldRule] },
  });
  expect(unchanged).toHaveLength(1);
  expect(unchanged[0]).toMatchObject({
    evaluatorId: hosted.scorerId,
    change: "unchanged",
    comparable: true,
    flipped: false,
  });
  const changed = backtestIteration(source, draft);
  expect(changed.map((item) => item.change).sort()).toEqual([
    "added",
    "removed",
  ]);
  expect(changed.every((item) => !item.comparable)).toBe(true);
});
it("returns a resumable cursor after bounded pages and binds continuation to the draft", async () => {
  let page = 0;
  const readPage = vi.fn(async () => ({
    schemaVersion: 1 as const,
    runId: "run",
    suiteId: "suite",
    sourceHash: "source",
    reservationId: "reservation",
    isDone: false,
    cursor: `cursor-${++page}`,
    iterations: [{ ...row, iterationId: `iteration-${page}` }],
  }));
  const first = await runAssertionBacktest({
    runId: "run",
    suiteId: "suite",
    draft,
    readPage,
  });
  expect(first.continuation).toMatchObject({
    cursor: "cursor-10",
    sourceHash: "source",
    reservationId: "reservation",
    draftHash: first.draftHash,
  });
  const last = vi.fn(async () => ({
    schemaVersion: 1 as const,
    runId: "run",
    suiteId: "suite",
    sourceHash: "source",
    reservationId: "reservation",
    isDone: true,
    iterations: [{ ...row, iterationId: "last" }],
  }));
  await runAssertionBacktest({
    runId: "run",
    suiteId: "suite",
    draft,
    continuation: first.continuation,
    readPage: last,
  });
  expect(last).toHaveBeenCalledWith({
    runId: "run",
    suiteId: "suite",
    pageSize: 10,
    cursor: "cursor-10",
    sourceHash: "source",
    reservationId: "reservation",
  });
  await expect(
    runAssertionBacktest({
      runId: "run",
      suiteId: "suite",
      draft: { assertions: { mode: "inherit", list: [] } },
      continuation: first.continuation,
      readPage: last,
    }),
  ).rejects.toThrow("SOURCE_CHANGED");
});

it("previews both halves of a hosted tool-call verdict, and removes neither", async () => {
  const { buildHostedScoreContract } = await import("../score-rows");
  const expectedToolCalls = [{ toolName: "search", arguments: { q: "cats" } }];
  const actualToolCalls = [{ toolName: "search", arguments: { q: "dogs" } }];
  const matchOptions = {
    toolCallOrder: "ignore",
    maxExtraToolCalls: null,
    argumentMatching: "partial",
  };
  // What a hosted run stored after the split: the right tool, the wrong
  // argument.
  const stored = buildHostedScoreContract({
    evaluation: {
      passed: false,
      expectedToolCalls,
      missing: [],
      unexpected: [],
      argumentMismatches: [
        {
          toolName: "search",
          expectedArgs: { q: "cats" },
          actualArgs: { q: "dogs" },
        },
      ],
    },
    matchOptions,
  });
  const differences = backtestIteration(
    {
      ...row,
      expectedToolCalls,
      actualToolCalls,
      isNegativeTest: false,
      evaluationConfig: stored.evaluationConfig,
      results: stored.scores,
    },
    {
      assertions: { mode: "replace", list: [] },
      // Loosening the comparison flips the arguments half and only it.
      matchOptions: { argumentMatching: "ignore" },
    },
  );
  const byId = new Map(differences.map((item) => [item.evaluatorId, item]));
  expect(byId.get("toolCalls:match")).toMatchObject({
    change: "configuration_changed",
    comparable: true,
    flipped: false,
  });
  // Ignored arguments are not compared, so the draft has no such scorer; the
  // stored one is outside it rather than silently kept.
  expect(byId.get("toolCalls:arguments")).toMatchObject({ change: "removed" });

  const stricter = backtestIteration(
    {
      ...row,
      expectedToolCalls,
      actualToolCalls,
      isNegativeTest: false,
      evaluationConfig: stored.evaluationConfig,
      results: stored.scores,
    },
    {
      assertions: { mode: "replace", list: [] },
      matchOptions: { argumentMatching: "exact" },
    },
  );
  const arguments_ = stricter.find(
    (item) => item.evaluatorId === "toolCalls:arguments",
  );
  expect(arguments_).toMatchObject({
    change: "configuration_changed",
    comparable: true,
    flipped: false,
    draft: { status: "scored", passed: false },
  });
  expect(stricter.map((item) => item.change)).not.toContain("removed");
});

it("does not compare a tool match graded before the split with the draft's", async () => {
  const { buildHostedScoreContract } = await import("../score-rows");
  const { definitionHash } = await import("@mcpjam/sdk/contract");
  const expectedToolCalls = [{ toolName: "search", arguments: { q: "cats" } }];
  const actualToolCalls = [{ toolName: "search", arguments: { q: "dogs" } }];
  const matchOptions = {
    toolCallOrder: "ignore",
    maxExtraToolCalls: null,
    argumentMatching: "partial",
  };
  // The right tool, the wrong argument.
  const today = buildHostedScoreContract({
    evaluation: {
      passed: false,
      expectedToolCalls,
      missing: [],
      unexpected: [],
      argumentMismatches: [
        {
          toolName: "search",
          expectedArgs: { q: "cats" },
          actualArgs: { q: "dogs" },
        },
      ],
    },
    matchOptions,
  });
  // What a run graded before the split stored: one `toolCalls:match` row, at
  // v2, which was the matcher's whole verdict and so FAILED on the argument.
  const v3 = today.evaluationConfig.definitions.find(
    (item) => item.scorerId === "toolCalls:match",
  )!;
  const v2 = { ...v3, scorerVersion: "2", implementationHash: "tool-match-v2" };
  const v2Score = {
    ...today.scores.find((item) => item.scorerId === "toolCalls:match")!,
    definitionHash: definitionHash(v2),
    passed: false,
    value: 0,
  };
  const differences = backtestIteration(
    {
      ...row,
      expectedToolCalls,
      actualToolCalls,
      isNegativeTest: false,
      evaluationConfig: { definitions: [v2] },
      results: [v2Score],
    },
    // The draft changes nothing about tool calls.
    { assertions: { mode: "replace", list: [] }, matchOptions },
  );
  const match = differences.find(
    (item) => item.evaluatorId === "toolCalls:match",
  );
  // v3 is selection only, so it passes where v2 failed. That is the evaluator
  // changing, not the draft: not a flip.
  expect(match).toMatchObject({
    comparable: false,
    reason: "Graded by an earlier version of this evaluator",
    stored: { status: "scored", passed: false },
    draft: { status: "scored", passed: true },
  });
  expect(match).not.toHaveProperty("flipped");
  // The arguments half has no stored twin to compare with.
  expect(
    differences.find((item) => item.evaluatorId === "toolCalls:arguments"),
  ).toMatchObject({ change: "added", comparable: false });
});
