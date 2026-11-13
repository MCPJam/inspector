/**
 * What a test plan's calls showed, tool by tool.
 *
 * Three rules carry the weight:
 *
 *   - A negative case passes when the tool refuses as planned, and it is
 *     never valid-input coverage: a tool that only refused has shown that it
 *     refuses, not that it works.
 *   - A call that may have written and never finished is `ambiguous`. It is
 *     named, never sent again silently, and waits for someone to say what
 *     happened or to rerun it on purpose.
 *   - A refusal before the tool ran (sign-in, permission, rate limit) or a
 *     server that did not answer is a setup problem: never the tool's
 *     failure, and never the refusal a negative case expects.
 *
 * Pure. Safe from the browser entry.
 */

import { canonicalDigest } from "../../contract/canonical.js";
import type { DirectoryToolCallEvidence } from "../mcp-tool-call.js";
import { directoryFixtureReferences } from "./fixtures.js";
import { DIRECTORY_TEST_CASE_STATUSES } from "./outcome-types.js";
import type {
  DirectoryTestCallOutcome,
  DirectoryTestCallRecord,
  DirectoryTestCaseResult,
  DirectoryTestCaseStatus,
  DirectoryToolTestResult,
  DirectoryToolTestStatus,
} from "./outcome-types.js";
import type {
  DirectoryTestCase,
  DirectoryTestPlan,
  DirectoryTestPlanTool,
  DirectoryToolEffect,
  DirectoryToolPlan,
} from "./types.js";
import { answerWords, caseWords } from "./wording.js";

/** The ledger phase and outcome of a call that returned, from the dial's evidence. */
export function classifyDirectoryTestCall(
  evidence: DirectoryToolCallEvidence,
  effect: DirectoryToolEffect
): {
  phase: "succeeded" | "failed" | "ambiguous";
  outcome: DirectoryTestCallOutcome;
} {
  const outcome = outcomeOf(evidence);
  if (outcome === "result") return { phase: "succeeded", outcome };
  // No answer: a read changed nothing, but a write may have landed.
  const unknown = outcome === "unreachable" && effect !== "read";
  return { phase: unknown ? "ambiguous" : "failed", outcome };
}

function outcomeOf(
  evidence: DirectoryToolCallEvidence
): DirectoryTestCallOutcome {
  const status = evidence.status ?? 0;
  if (evidence.invalidArguments) return "invalid-arguments";
  if (status >= 500) return "server-error";
  // Refused before any tool ran: sign-in, permission, rate limit, session.
  if (status >= 400) return "refused";
  if (evidence.rpcError) return "rpc-error";
  if (evidence.result) return evidence.result.isError ? "tool-error" : "result";
  // An answer that is neither a result nor an error is the server's fault.
  return evidence.unreachable ? "unreachable" : "server-error";
}

/**
 * What a resumed sweep does with a call the ledger holds: `run` it, `skip` it
 * because its evidence stands, or leave it `ambiguous`: a write that started
 * and never finished is not sent again until someone says what happened.
 */
export function resumeDirectoryTestCall(
  record: Pick<DirectoryTestCallRecord, "phase" | "outcome"> | undefined,
  effect: DirectoryToolEffect
): "run" | "skip" | "ambiguous" {
  if (!record || record.phase === "planned") return "run";
  if (record.phase === "started")
    return effect === "read" ? "run" : "ambiguous";
  if (record.phase === "ambiguous") return "ambiguous";
  // Nothing reached the tool, so trying again repeats nothing.
  const setup =
    record.outcome === "refused" || record.outcome === "unreachable";
  return setup ? "run" : "skip";
}

/**
 * What a case's result depends on, as one digest: the call as planned, the
 * fixtures it refers to, and the tool's schema and annotations. Wording is
 * left out, so rewording a description or an expectation keeps every result.
 * The worker stores it with each call; a different digest now means stale.
 */
export function directoryTestCaseDigest(
  plan: Pick<DirectoryTestPlan, "fixtures">,
  testCase: DirectoryTestCase,
  tool?: DirectoryTestPlanTool
): string {
  const used = new Set(
    directoryFixtureReferences(testCase.arguments).map((ref) => ref.fixture)
  );
  return canonicalDigest({
    tool: testCase.tool,
    kind: testCase.kind,
    arguments: testCase.arguments,
    expectedError:
      testCase.kind === "negative" ? (testCase.expectedError ?? "any") : null,
    fixtures: plan.fixtures
      .filter((fixture) => used.has(fixture.id))
      .map(({ id, origin, values, capture }) => ({
        id,
        origin,
        values,
        capture,
      })),
    inputSchema: tool?.inputSchema,
    annotations: tool?.annotations,
  });
}

export interface SummarizeDirectoryToolTestsInput {
  plan: DirectoryTestPlan;
  /** The tools the server lists now: a result from another schema is stale. */
  tools: readonly DirectoryTestPlanTool[];
  /** Ledger records; a later record for a case replaces an earlier one. */
  calls: readonly DirectoryTestCallRecord[];
  /** The reviewer account tests run as now: a result from another is stale. */
  account?: string;
  /** Existing fixtures the lookup did not find. */
  missingFixtures?: readonly string[];
  /** Why the sweep stopped before every case ran. */
  stopped?: {
    by: "budget" | "deadline" | "cancelled" | "setup";
    detail?: string;
  };
}

/** One result per tool in the plan, valid-input and negative cases counted apart. */
export function summarizeDirectoryToolTests(
  input: SummarizeDirectoryToolTestsInput
): DirectoryToolTestResult[] {
  const { plan } = input;
  const latest = new Map(input.calls.map((call) => [call.callKey, call]));
  const listed = new Map(input.tools.map((tool) => [tool.name, tool]));
  const entries = new Map(plan.tools.map((entry) => [entry.tool, entry]));
  const graded = new Map<string, DirectoryTestCaseResult>();
  const byTool = new Map<string, DirectoryTestCaseResult[]>();
  for (const testCase of plan.cases) {
    const record = latest.get(testCase.id);
    const ran = record && record.phase !== "planned";
    const verdict = ran
      ? ranVerdict(testCase, record, input.account, {
          digest: directoryTestCaseDigest(
            plan,
            testCase,
            listed.get(testCase.tool)
          ),
          effect: entries.get(testCase.tool)?.effect ?? "destructive",
        })
      : notRunVerdict(testCase, input, graded);
    const result = {
      caseId: testCase.id,
      kind: testCase.kind,
      ...verdict,
      ...(ran ? { call: record } : {}),
    };
    graded.set(testCase.id, result);
    byTool.set(testCase.tool, [...(byTool.get(testCase.tool) ?? []), result]);
  }
  return plan.tools.map((entry) =>
    toolResult(entry, byTool.get(entry.tool) ?? [])
  );
}

type Verdict = Pick<DirectoryTestCaseResult, "status" | "reason">;

function ranVerdict(
  testCase: DirectoryTestCase,
  record: DirectoryTestCallRecord,
  account: string | undefined,
  now: { digest: string; effect: DirectoryToolEffect }
): Verdict {
  // An unfinished write outranks any later edit: data may have changed.
  if (
    record.phase === "ambiguous" ||
    (record.phase === "started" && now.effect !== "read")
  ) {
    return { status: "ambiguous", reason: caseWords("ambiguous") };
  }
  if (
    account !== undefined &&
    record.account !== undefined &&
    record.account !== account
  ) {
    return { status: "stale", reason: caseWords("staleAccount") };
  }
  if (record.inputDigest !== now.digest) {
    return { status: "stale", reason: caseWords("staleInputs") };
  }
  if (record.phase === "started")
    return { status: "untested", reason: caseWords("running") };
  const got =
    record.outcome ?? (record.phase === "succeeded" ? "result" : "unreachable");
  if (got === "refused" || got === "unreachable") {
    return { status: "blocked", reason: caseWords(got) };
  }
  if (testCase.kind === "valid") {
    return got === "result"
      ? { status: "passed" }
      : {
          status: "failed",
          reason: caseWords("validFailed", { got: answerWords(got) }),
        };
  }
  if (got === "result")
    return { status: "failed", reason: caseWords("acceptedInvalid") };
  const expected = testCase.expectedError ?? "any";
  // A crash is not a refusal, whatever the case expected.
  if (got === "server-error" || (expected !== "any" && expected !== got)) {
    const words = { expected: answerWords(expected), got: answerWords(got) };
    return { status: "failed", reason: caseWords("wrongRefusal", words) };
  }
  return { status: "passed" };
}

function notRunVerdict(
  testCase: DirectoryTestCase,
  input: SummarizeDirectoryToolTestsInput,
  graded: ReadonlyMap<string, DirectoryTestCaseResult>
): Verdict {
  if (!testCase.arguments)
    return { status: "blocked", reason: caseWords("notDrafted") };
  for (const { fixture, value } of directoryFixtureReferences(
    testCase.arguments
  )) {
    if (input.missingFixtures?.includes(fixture)) {
      return {
        status: "blocked",
        reason: caseWords("fixtureMissing", { fixture }),
      };
    }
    const creator = input.plan.cases.find((other) =>
      other.creates?.includes(fixture)
    )?.id;
    const made = creator === undefined ? undefined : graded.get(creator);
    const status = made?.status;
    if (status !== undefined && status !== "passed" && status !== "untested") {
      const words = { fixture, creator, status };
      return {
        status: "blocked",
        reason: caseWords("fixtureNotCreated", words),
      };
    }
    // Created, but the result did not hold the value this case needs.
    const captured = made?.call?.captured ?? {};
    const named = Object.hasOwn(captured, fixture) ? captured[fixture] : {};
    if (status === "passed" && !Object.hasOwn(named ?? {}, value)) {
      const words = { fixture, creator, value };
      return { status: "blocked", reason: caseWords("notCaptured", words) };
    }
  }
  const { stopped } = input;
  if (!stopped) return { status: "untested", reason: caseWords("notRun") };
  return {
    status: stopped.by === "setup" ? "blocked" : "untested",
    reason: stopped.detail ?? caseWords(stopped.by),
  };
}

function toolResult(
  entry: DirectoryToolPlan,
  graded: DirectoryTestCaseResult[]
): DirectoryToolTestResult {
  const excluded = entry.action === "excluded";
  const cases = excluded ? [] : graded;
  const kind = entry.action === "negative-only" ? "negative" : "valid";
  const primary = cases.filter((result) => result.kind === kind);
  const find = (status: DirectoryTestCaseStatus, among = cases) =>
    among.find((result) => result.status === status);
  // Worst first; a passing negative case never decides a valid-input status.
  const ranked: Array<
    [DirectoryToolTestStatus, DirectoryTestCaseResult | undefined]
  > = [
    ["ambiguous", find("ambiguous")],
    ["unexpected-failure", find("failed")],
    [
      kind === "valid" ? "valid-input-succeeded" : "expected-refusal",
      find("passed", primary),
    ],
    ["setup-blocked", find("blocked", primary)],
    ["stale", find("stale", primary)],
    ["untested", find("untested", primary)],
  ];
  const [status, decisive] = excluded
    ? (["excluded", undefined] as const)
    : (ranked.find(([, result]) => result) ??
      (["untested", undefined] as const));
  const reason = excluded
    ? [entry.exclusion?.reason, entry.exclusion?.note]
        .filter(Boolean)
        .join(": ")
    : !decisive
      ? caseWords(kind === "valid" ? "noValidCase" : "noNegativeCase")
      : decisive.status === "passed"
        ? undefined
        : `${decisive.caseId}: ${decisive.reason}`;
  return {
    tool: entry.tool,
    status,
    ...(reason ? { reason } : {}),
    validInput: tally(cases, "valid"),
    negative: tally(cases, "negative"),
    cases,
  };
}

function tally(
  cases: readonly DirectoryTestCaseResult[],
  kind: DirectoryTestCase["kind"]
): Record<DirectoryTestCaseStatus, number> {
  const counts = Object.fromEntries(
    DIRECTORY_TEST_CASE_STATUSES.map((status) => [status, 0])
  ) as Record<DirectoryTestCaseStatus, number>;
  for (const result of cases) {
    if (result.kind === kind) counts[result.status] += 1;
  }
  return counts;
}
