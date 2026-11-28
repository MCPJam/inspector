/**
 * Hand-built `eval-local-run` reports for renderer tests: realistic cases
 * decided by the real v2 aggregator and validated by the real report builder,
 * without a server or a model. Use the runner (see `scripted-model.ts`) when a
 * test needs evidence the runner produced; use this when it needs exact,
 * hostile or oversized values in that evidence.
 */

import {
  SUITE_FILE_DEFAULT_COVERAGE,
  SUITE_FILE_VALIDITY_DEFAULTS,
  aggregateEvalRunVerdict,
} from "../../src/contract/index.js";
import {
  buildLocalEvalRunReport,
  type LocalEvalRunReport,
} from "../../src/suite-file-run/report.js";
import type {
  SuiteFileCaseRun,
  SuiteFileIterationEvidence,
} from "../../src/suite-file-run/types.js";

export function iterationEvidence(
  overrides: Partial<SuiteFileIterationEvidence> = {}
): SuiteFileIterationEvidence {
  return {
    iterationNumber: 1,
    status: "completed",
    taskVerdict: "passed",
    toolCalls: [],
    policyBlocks: [],
    scores: [],
    durationMs: 1000,
    tokens: { input: 100, output: 20, total: 120 },
    ...overrides,
  };
}

export function caseRun(
  overrides: Partial<SuiteFileCaseRun> & Pick<SuiteFileCaseRun, "caseId">
): SuiteFileCaseRun {
  const iterations = overrides.iterations ?? [iterationEvidence()];
  return {
    title: overrides.caseId,
    isNegativeTest: false,
    declaredModel: "anthropic/claude-haiku-4.5",
    effectiveModel: "anthropic/claude-haiku-4.5",
    rail: "byok",
    provider: "anthropic",
    configuredIterations: iterations.length,
    passThreshold: 0.66,
    evaluationConfigHash: "b".repeat(64),
    scorerIds: [],
    judge: {
      configured: false,
      effective: { enabled: true, autoRun: true, role: "advisory" },
      run: false,
      skipReason: "localJudgeUnsupported",
    },
    state: "completed",
    ...overrides,
    iterations,
  };
}

/** Decide `cases` with the v2 aggregator and build the validated report. */
export function localRunReport(
  cases: readonly SuiteFileCaseRun[]
): LocalEvalRunReport {
  const decision = aggregateEvalRunVerdict({
    policy: {
      coverage: SUITE_FILE_DEFAULT_COVERAGE,
      ...SUITE_FILE_VALIDITY_DEFAULTS,
    },
    cases: cases.map((entry) => ({
      caseId: entry.caseId,
      configuredTrials: entry.configuredIterations,
      effectivePassThreshold: entry.passThreshold,
      trials: entry.iterations.map((iteration) => ({
        status: iteration.status,
        ...(iteration.taskVerdict
          ? { taskVerdict: iteration.taskVerdict }
          : {}),
        ...(iteration.evaluatorError ? { evaluatorError: true } : {}),
      })),
    })),
  });
  const byCase = new Map(decision.cases.map((entry) => [entry.caseId, entry]));
  const configuredIterations = cases.reduce(
    (sum, entry) => sum + entry.configuredIterations,
    0
  );
  return buildLocalEvalRunReport({
    execution: {
      mode: "local",
      engine: "emulated",
      host: { templateId: null },
      sdkVersion: "0.0.0-test",
      evaluatorVersion: "predicates-v1",
      declaredHosts: [],
      declaredEnvironment: null,
      servers: [{ name: "orders", source: ".mcp.json", transport: "http" }],
      settings: {
        concurrency: 4,
        iterationTimeoutMs: 120000,
        maxSteps: 10,
        setupTimeoutMs: 30000,
        systemPrompt: "default",
        temperature: null,
      },
    },
    verdict: decision.verdict,
    decision,
    termination: "completed",
    complete: true,
    population: {
      unit: "case",
      cases: cases.length,
      configuredIterations,
      executedIterations: configuredIterations,
      notStartedIterations: 0,
    },
    issues: [],
    suite: {
      id: "s_orders",
      name: "orders",
      schemaVersion: "2",
      sourceHash: "a".repeat(64),
    },
    selection: {
      requested: null,
      selected: cases.map((entry) => entry.caseId),
      skipped: [],
    },
    cases: cases.map((entry) => {
      const aggregation = byCase.get(entry.caseId);
      return aggregation ? { ...entry, aggregation } : entry;
    }),
    toolPolicy: { declared: null, snapshot: null, blocks: [] },
    declaredReportingMode: "standard",
    warnings: [],
    durationMs: cases
      .flatMap((entry) => entry.iterations)
      .reduce((sum, iteration) => sum + iteration.durationMs, 0),
  });
}

/** A passing case with two tool calls, a failing case and a passing one. */
export function sampleLocalRunCases(): SuiteFileCaseRun[] {
  return [
    caseRun({
      caseId: "c_order_status",
      title: "Looks up an order and its shipment",
      scorerIds: [
        "predicate:toolCalledAtLeastOnce#0",
        "predicate:toolCalledAtLeastOnce#1",
      ],
      iterations: [
        iterationEvidence({
          durationMs: 4210,
          tokens: { input: 1843, output: 212, total: 2055 },
          toolCalls: [
            { toolName: "get_order", arguments: { orderId: "ORD-1042" } },
            {
              toolName: "get_shipment",
              arguments: {
                orderId: "ORD-1042",
                include: ["events", "carrier"],
              },
            },
          ],
          scores: [
            {
              scorerId: "predicate:toolCalledAtLeastOnce#0",
              role: "gating",
              status: "scored",
              passed: true,
              reason: "get_order was called 1 time",
            },
            {
              scorerId: "predicate:toolCalledAtLeastOnce#1",
              role: "gating",
              status: "scored",
              passed: true,
              reason: "get_shipment was called 1 time",
            },
          ],
        }),
      ],
    }),
    caseRun({
      caseId: "c_refund",
      title: "Issues a refund for a damaged item",
      scorerIds: ["predicate:toolCalledAtLeastOnce#0"],
      iterations: [
        iterationEvidence({
          taskVerdict: "failed",
          durationMs: 3120,
          tokens: { input: 1610, output: 145, total: 1755 },
          toolCalls: [
            { toolName: "get_order", arguments: { orderId: "ORD-2210" } },
          ],
          scores: [
            {
              scorerId: "predicate:toolCalledAtLeastOnce#0",
              role: "gating",
              status: "scored",
              passed: false,
              reason: "create_refund was never called",
            },
          ],
        }),
      ],
    }),
    caseRun({
      caseId: "c_catalog_search",
      title: "Searches the catalog",
      scorerIds: ["predicate:responseContains#0"],
      iterations: [
        iterationEvidence({
          durationMs: 2675,
          tokens: { input: 1402, output: 388, total: 1790 },
          toolCalls: [
            {
              toolName: "search_catalog",
              arguments: { query: "waterproof hiking boots", limit: 10 },
            },
          ],
          scores: [
            {
              scorerId: "predicate:responseContains#0",
              role: "advisory",
              status: "scored",
              passed: true,
              reason: 'response contains "boots"',
            },
          ],
        }),
      ],
    }),
  ];
}
