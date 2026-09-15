/**
 * Run MCPJam eval suites inside vitest.
 *
 * --- A wrapper, not a reporter ---
 *
 * The obvious alternative was a custom vitest Reporter. This is deliberately
 * not that. A reporter observes tests; it cannot decide what a test IS. Evals
 * need the opposite: one `it` per eval case so failures land on named tests in
 * every vitest UI, watch mode and CI annotation that already exists, with no
 * bespoke output for anyone to learn. A reporter would also have no seat for
 * the gate, which is a verdict over the whole run rather than any one case.
 *
 * --- One run, many tests ---
 *
 * `suite.run()` is called ONCE, in `beforeAll`. That is not an optimization:
 * the suite uploads a single hosted run, computes one aggregate evaluation
 * config hash, and executes its cases sequentially. Calling it per `it` would
 * produce N hosted runs, N aggregate hashes, and a concurrency pattern the
 * suite explicitly avoids. The `it`s then read that one result.
 *
 * So an eval case's `it` is an ASSERTION over an already-computed result, not
 * the thing that runs it. Vitest timeouts on those tests are therefore
 * irrelevant; the timeout that matters is the hook's, which is why it defaults
 * to five minutes and is configurable.
 *
 * --- The gate is its own test ---
 *
 * The per-case tests answer "did this case pass". The gate answers "does this
 * run satisfy the policy", which is a different question with a different
 * failure mode — a run where every case passed can still breach a latency or
 * score-integrity gate. Giving it a named `it` means CI shows WHICH question
 * failed instead of a bare non-zero exit.
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertGate,
  formatGateReport,
  formatRunSummaryTable,
  gateInputFromRunResult,
  gateInputFromSuiteResult,
  type EvalRunResult,
  type EvalSuite,
  type EvalSuiteResult,
  type EvalTest,
  type EvalTestRunOptions,
  type GatePolicy,
  type GateReport,
  type HostExecutor,
} from "@mcpjam/sdk";

/** Five minutes. An eval suite is not a unit test. */
export const DEFAULT_HOOK_TIMEOUT_MS = 300_000;

/** The vitest test title used for the policy gate. */
export const GATE_TEST_TITLE = "eval gate";

export type EvalCasePlan = {
  /** The vitest test title. */
  title: string;
  /** The suite key this case's result is recorded under. */
  testName: string;
  /** The hosted case id, when this case came from a hosted corpus. */
  scenarioId?: string;
  /**
   * The case's DECLARED id (`EvalTestConfig.id`).
   *
   * Surfaced so a CI reporter can key a case by its identity rather than by a
   * title that gets renamed. Deliberately NOT used in the vitest title: the
   * `[scenarioId]` suffix is the hosted-dashboard grep handle and still rides
   * `externalCaseId`, so changing what the suffix carries would break the greps
   * that exist.
   */
  caseId?: string;
};

export type EvalSuitePlan = {
  cases: EvalCasePlan[];
  /** Present only when a gate policy was supplied. */
  gateTestTitle?: string;
};

/**
 * Decide the vitest titles for a suite, without registering anything.
 *
 * Pure and exported so the naming rules are testable on their own. A hosted
 * case's id is appended so a test title is greppable back to the dashboard row
 * it came from — explicitly, never inferred from the test name.
 */
export function planEvalSuite(
  suite: EvalSuite,
  options: { gate?: GatePolicy } = {},
): EvalSuitePlan {
  const cases = suite.getAll().map((test): EvalCasePlan => {
    const testName = test.getName();
    const config = test.getConfig();
    const scenarioId = config.externalCaseId;
    // Read defensively: a user can end up with `@mcpjam/vitest` beside an older
    // `@mcpjam/sdk` copy, where `id` does not exist yet. An absent `caseId` is
    // a missing convenience; a thrown TypeError would be a broken test run.
    const caseId = (config as { id?: string }).id;
    const declared = caseId === undefined ? {} : { caseId };
    if (scenarioId === undefined) {
      return { title: testName, testName, ...declared };
    }
    // A corpus already suffixes `[id]` onto cases whose titles collide, so
    // appending unconditionally would render `Title [id] [id]`.
    const suffix = ` [${scenarioId}]`;
    return {
      title: testName.endsWith(suffix) ? testName : `${testName}${suffix}`,
      testName,
      scenarioId,
      ...declared,
    };
  });

  return {
    cases,
    ...(options.gate ? { gateTestTitle: GATE_TEST_TITLE } : {}),
  };
}

/**
 * Turn one case's recorded result into a pass or a thrown failure.
 *
 * Exported so the RED path is testable inside an ordinary `it` — a generated
 * failing test cannot be asserted on from within the same run without failing
 * the run itself.
 */
export function runAndAssertCase(
  run: EvalRunResult | undefined,
  testName: string,
  failureReport?: () => string,
): void {
  if (!run) {
    // Reachable if a case was added to the suite after the plan was taken.
    throw new Error(
      `No result was recorded for eval case "${testName}". The suite ran, but ` +
        `this case was not part of it.`,
    );
  }
  if (run.iterations === 0)
    throw new Error(`No iterations executed for eval case "${testName}".`);
  if (run.failures === 0) return;

  let detail = "";
  try {
    detail = failureReport?.() ?? "";
  } catch {
    // A missing detail report must not replace the real failure with a
    // secondary one about formatting it.
    detail = "";
  }

  const summary =
    `${testName}: ${run.failures} of ${run.iterations} ` +
    `${run.iterations === 1 ? "iteration" : "iterations"} failed.`;
  throw new Error(detail ? `${summary}\n\n${detail}` : summary);
}

/**
 * Render a gate failure for a test message.
 *
 * Duck-typed as well as `instanceof`-checked. A published wrapper can end up
 * beside a second copy of `@mcpjam/sdk` — a mismatched transitive range, a
 * pnpm layout — and `instanceof` silently fails across copies. Falling back to
 * the message would drop the per-gate table, which is the whole reason the
 * error carries a report.
 */
export function gateFailureMessage(error: unknown): string {
  const report = (error as { report?: GateReport } | null)?.report;
  if (report && typeof report === "object" && "outcome" in report) {
    return formatGateReport(report);
  }
  return error instanceof Error ? error.message : String(error);
}

export type EvalSuiteVitestOptions = {
  /** A ready executor. Mutually exclusive with `factory`. */
  executor?: HostExecutor;
  /** Built inside `beforeAll` — for an executor that must connect first. */
  factory?: () => HostExecutor | Promise<HostExecutor>;
  run: Omit<EvalTestRunOptions, "iterations"> & { iterations?: number };
  /** Selected case identities. Selection retains the source coverage manifest. */
  only?: readonly string[];
  /** Skips win over only; no skipped case executes. */
  skip?: readonly string[];
  /** Explicit cleanup, run even when execution or reporting fails. */
  dispose?: (executor: HostExecutor) => void | Promise<void>;
  /** Defaults to table. Formatting errors never replace evaluation results. */
  summary?: "none" | "table";
  /** Omit to register no gate test. */
  gate?: GatePolicy;
  hookTimeoutMs?: number;
};

async function resolveExecutor(
  options: EvalSuiteVitestOptions,
): Promise<HostExecutor> {
  if (options.executor && options.factory) {
    throw new Error(
      "Pass either `executor` or `factory` to describeEvalSuite, not both.",
    );
  }
  if (options.executor) return options.executor;
  if (options.factory) return await options.factory();
  throw new Error(
    "describeEvalSuite needs an `executor` or a `factory` to build one.",
  );
}

/**
 * Register a vitest `describe` for an eval suite: one test per case, plus the
 * gate test when a policy is given.
 */
function registerEvalSuite(
  name: string,
  suite: EvalSuite,
  options: EvalSuiteVitestOptions,
  mode: "normal" | "skip" | "only" = "normal",
): void {
  const plan = planEvalSuite(suite, options);
  const available = new Set(suite.getAll().map((test) => test.getId()));
  for (const id of [...(options.only ?? []), ...(options.skip ?? [])]) {
    if (!available.has(id)) throw new Error(`Unknown selected case ID: ${id}`);
  }
  const skipped = new Set(options.skip ?? []);
  const selectedIds = [...available].filter(
    (id) => !skipped.has(id) && (!options.only || options.only.includes(id)),
  );
  const selectedSuite =
    options.only || options.skip ? suite.subset(selectedIds) : suite;
  // Captured BEFORE the run so a case's detailed report is reachable by name
  // without re-walking the suite inside every test.
  const testsByName = new Map<string, EvalTest>(
    selectedSuite.getAll().map((test) => [test.getName(), test]),
  );

  const register =
    mode === "skip"
      ? describe.skip
      : mode === "only" || options.only
        ? describe.only
        : describe;
  register(name, () => {
    let executor: HostExecutor | undefined;
    let result: EvalSuiteResult | undefined;

    beforeAll(async () => {
      if (selectedIds.length === 0) return;
      executor = await resolveExecutor(options);
      try {
        result = await selectedSuite.run(executor, {
          ...options.run,
          summary: "none",
        });
      } finally {
        const completed = result ?? selectedSuite.getResults();
        if (completed && options.summary !== "none") {
          try {
            console.log(
              formatRunSummaryTable(
                completed,
                selectedSuite.getReportingReceipt(),
              ),
            );
          } catch {
            /* formatting is observational */
          }
        }
      }
    }, options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      if (executor) await options.dispose?.(executor);
    });
    for (const entry of plan.cases) {
      const registerCase =
        entry.caseId && !selectedIds.includes(entry.caseId) ? it.skip : it;
      registerCase(entry.title, () => {
        const test = testsByName.get(entry.testName);
        runAndAssertCase(
          result?.tests.get(entry.testName),
          entry.testName,
          () => (test ? test.getFailureReport() : ""),
        );
      });
    }

    if (plan.gateTestTitle) {
      it(plan.gateTestTitle, () => {
        if (!result) {
          throw new Error("The eval suite did not run, so it cannot be gated.");
        }
        try {
          // `assertGate` throws on `incomplete` too: a gate that could not be
          // decided has not been satisfied.
          //
          // NO WAIVER PATH HERE, and its absence is a decision rather than an
          // omission. `GateReport` gained a `waived` outcome for the HOSTED
          // gate, where a waiver is an audited platform record with an
          // authorized granter, a reason and an expiry behind it. This gate
          // runs against a local, code-first suite result: there is no such
          // record to consult, and the only way to express "waive this" would
          // be a flag in the same file as the assertion — a gate that turns
          // itself off, which is not a waiver at all. A caller who wants a
          // policy relaxed here edits the policy, in the open, in git.
          //
          // `formatGateReport` below renders a `waived` report correctly if
          // one ever does reach it, so the widened union is safe to pass
          // through untouched.
          assertGate(
            gateInputFromSuiteResult(result),
            options.gate as GatePolicy,
          );
        } catch (error) {
          throw new Error(gateFailureMessage(error));
        }
      });
    }
  });
}

export const describeEvalSuite = Object.assign(
  (name: string, suite: EvalSuite, options: EvalSuiteVitestOptions) =>
    registerEvalSuite(name, suite, options),
  {
    skip: (name: string, suite: EvalSuite, options: EvalSuiteVitestOptions) =>
      registerEvalSuite(name, suite, options, "skip"),
    only: (name: string, suite: EvalSuite, options: EvalSuiteVitestOptions) =>
      registerEvalSuite(name, suite, options, "only"),
  },
);

export type EvalTestVitestOptions = Omit<
  EvalSuiteVitestOptions,
  "run" | "only" | "skip"
> & { run: EvalTestRunOptions };

/**
 * The single-test seat, for a file that owns one eval and wants no suite.
 *
 * Not implemented by wrapping the test in a throwaway `EvalSuite`: a suite
 * aggregates and uploads as a unit, so a synthetic one would change what is
 * reported for a case that is not part of any suite.
 *
 * `gate` is honoured here exactly as in `describeEvalSuite` — via
 * `gateInputFromRunResult` rather than the suite variant. Accepting the option
 * and ignoring it would be the worst outcome available: a policy that reports
 * green because nothing evaluated it.
 */
function registerTestEval(
  test: EvalTest,
  options: EvalTestVitestOptions,
  mode: "normal" | "skip" | "only" = "normal",
): void {
  const scenarioId = test.getConfig().externalCaseId;
  const name = test.getName();
  const suffix = scenarioId === undefined ? "" : ` [${scenarioId}]`;
  const title = name.endsWith(suffix) ? name : `${name}${suffix}`;

  const register =
    mode === "skip"
      ? describe.skip
      : mode === "only"
        ? describe.only
        : describe;
  register(title, () => {
    let executor: HostExecutor | undefined;
    let run: EvalRunResult | undefined;

    beforeAll(async () => {
      executor = await resolveExecutor(options);
      try {
        run = await test.run(executor, { ...options.run, summary: "none" });
      } finally {
        const completed = run ?? test.getResults();
        if (completed && options.summary !== "none") {
          try {
            console.log(
              formatRunSummaryTable(completed, test.getReportingReceipt()),
            );
          } catch {
            /* formatting is observational */
          }
        }
      }
    }, options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      if (executor) await options.dispose?.(executor);
    });
    it("passes", () => {
      runAndAssertCase(run, name, () => test.getFailureReport());
    });

    if (options.gate) {
      it(GATE_TEST_TITLE, () => {
        if (!run) {
          throw new Error("The eval did not run, so it cannot be gated.");
        }
        try {
          assertGate(gateInputFromRunResult(run), options.gate as GatePolicy);
        } catch (error) {
          throw new Error(gateFailureMessage(error));
        }
      });
    }
  });
}

export const testEval = Object.assign(
  (test: EvalTest, options: EvalTestVitestOptions) =>
    registerTestEval(test, options),
  {
    skip: (test: EvalTest, options: EvalTestVitestOptions) =>
      registerTestEval(test, options, "skip"),
    only: (test: EvalTest, options: EvalTestVitestOptions) =>
      registerTestEval(test, options, "only"),
  },
);
