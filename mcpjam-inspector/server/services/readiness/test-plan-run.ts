/**
 * A submission run's tool tests: the saved test plan its start named, run
 * against the server and summarized per tool for the report.
 *
 * Naming the plan revision at the start was the consent for exactly the
 * calls it holds, so nothing is called unless the plan still fits what the
 * server lists: the SDK checks it against a fresh listing, in the session
 * the calls then use. A plan with any issue is reported with its issues. A
 * run that opted into model observations also has the broker draft the
 * arguments the plan's cases lack, and reports the drafts unsent.
 *
 * THE REVIEWER-ONLY RULE. The plan runs as the reviewer account and on no
 * other credential: the saved server's is the requester's, often a staff
 * member's (RP2). A run without a reviewer account lists and calls nothing
 * and says why. A case that uses a fixture the reviewer path looked up and
 * did not find is not sent, and is reported blocked, naming it (RP5). A
 * server the submission says needs no sign-in is tested as a directory's
 * reviewer reaches it: with no credential at all, recording no account.
 *
 * Every way this can fail short of a lost lease becomes a report that says
 * why, so the readiness grade beside it is kept.
 */

import {
  dialMcpServer,
  dialToolCall,
  redactConformanceReportForSharing,
  redactSharedServerUrl,
  summarizeDirectoryToolTests,
  validateDirectoryTestPlan,
  type DirectoryDialOptions,
  type DirectoryReviewerFixtureEvidence,
  type DirectoryReviewerPathEvidence,
  type DirectoryTestCallRecord,
  type DirectoryTestPlan,
  type DirectoryTestPlanIssue,
  type DirectoryTestPlanTool,
  type DirectoryToolTestResult,
  type SummarizeDirectoryToolTestsInput,
} from "@mcpjam/sdk";
import { logger } from "../../utils/logger.js";
import type { ReadinessLease } from "./backend-client.js";
import {
  readRunCallLedger,
  readRunTestPlan,
  recordRunCall,
} from "./call-ledger.js";
import type { ReadinessReviewerAccount } from "./reviewer-path.js";
import {
  ReadinessRunCancelledError,
  asRecord,
  isStopSignal,
} from "./runner.js";
import {
  draftMissingArguments,
  type TestArgumentDrafting,
  type TestArgumentRequester,
} from "./test-argument-drafts.js";
import { executeDirectoryTestPlan } from "./test-plan-executor.js";

/** Kept free at the end of a run to finalize it, and before that to clean up. */
const FINALIZE_MS = 60_000;
const CLEANUP_MS = 120_000;
/** The ledger's limit on a call's endpoint. */
const MAX_ENDPOINT_LENGTH = 2048;

const NOT_READ =
  "MCPJam could not read this run's call record, so no tool was called. Start a new run.";
const notSaved = (revision: number) =>
  `Test plan revision ${revision} is no longer saved, so no tool was called. Start a new run with the current plan.`;
const unreadable = (revision: number) =>
  `Test plan revision ${revision} could not be read, so no tool was called. Start a new run.`;
const malformed = (revision: number) =>
  `Test plan revision ${revision} is not in a form MCPJam can run, so no tool was called. Save the plan again, then start a new run.`;
const unlisted = (error?: string) =>
  `The server's tool list could not be read in full${error ? ` (${error})` : ""}, so no tool was called. Check that the server is reachable, then start a new run.`;
const MISMATCH =
  "The test plan does not match the tools the server lists now, so no tool was called. Fix the issues listed, save the plan, then start a new run.";
const signInNeeded = (status: number) =>
  `The server refused a connection with no credential (HTTP ${status}), but the submission says it needs no sign-in, so no tool was called. Correct the authentication answer, or let the server accept calls without sign-in, then start a new run.`;

/** What a run's report says about its tool tests. */
export interface DirectoryToolTestReport {
  /** The saved plan revision the run executes. */
  planRevision?: number;
  /** `not-run`: no tool was called; `stopped`: the sweep ended before every case. */
  status: "completed" | "stopped" | "not-run";
  /** Why no tool was called. */
  reason?: string;
  /** Why the sweep stopped early. */
  stopped?: SummarizeDirectoryToolTestsInput["stopped"];
  /** What is wrong with a plan that was not run. */
  issues?: DirectoryTestPlanIssue[];
  /** Calls that may have changed data and never finished; they are never sent again. */
  ambiguous: string[];
  /** One result per tool in the plan, each case with the call and who made it. */
  tools: DirectoryToolTestResult[];
  /** The cleanup calls for the fixtures the sweep created. */
  cleanup: DirectoryTestCallRecord[];
  /** Arguments drafted for cases that have none, for a person to review; never sent. */
  drafting?: TestArgumentDrafting;
}

export interface RunDirectoryTestPlanOptions {
  lease: ReadinessLease;
  /** The saved server's URL. */
  target: string;
  /** The DNS-pinned transport. */
  fetchFn: typeof fetch;
  /**
   * The only credential the plan's calls use, or why the run has none. With
   * `noSignIn`, the submission says the server needs no sign-in: no credential.
   */
  reviewer: ReadinessReviewerAccount | { noSignIn: true };
  /** The reviewer path's fixture lookup, when it ran. */
  fixtures?: DirectoryReviewerFixtureEvidence;
  identity?: DirectoryReviewerPathEvidence["identity"];
  signal: AbortSignal;
  /** When the run must have finished. */
  deadlineAt: number;
  /** Absent, the run drafts no arguments and cannot spend on them. */
  requestDrafts?: TestArgumentRequester;
  now?: () => number;
}

/**
 * The run's tool tests, redacted for storage as the grade is, or `undefined`
 * when its start named no test plan. The issues come from the saved plan,
 * and redacting them would blank their `code`; the drafting account is
 * redacted where it is built, all but the arguments it proposes.
 */
export async function runDirectoryTestPlan(
  options: RunDirectoryTestPlanOptions,
): Promise<DirectoryToolTestReport | undefined> {
  const report = await testPlanReport(options);
  if (!report) return undefined;
  const { issues, drafting, ...rest } = report;
  return {
    ...redactConformanceReportForSharing(rest),
    ...(issues ? { issues } : {}),
    ...(drafting ? { drafting } : {}),
  };
}

async function testPlanReport(
  options: RunDirectoryTestPlanOptions,
): Promise<DirectoryToolTestReport | undefined> {
  const notRun = (reason: string, planRevision?: number) => ({
    ...(planRevision !== undefined ? { planRevision } : {}),
    status: "not-run" as const,
    reason,
    ambiguous: [],
    tools: [],
    cleanup: [],
  });
  const { lease, reviewer } = options;
  const ledger = await stopOr(readRunCallLedger(lease), lease);
  if (!ledger) return notRun(NOT_READ);
  const planRevision = ledger.testPlanRevision;
  if (planRevision === undefined) return undefined;
  // The reviewer-only rule: with no reviewer account, nothing is even listed.
  if ("missing" in reviewer) return notRun(reviewer.missing, planRevision);
  if (
    options.identity?.outcome === "wrong-account" ||
    options.identity?.outcome === "wrong-tenant"
  ) {
    return notRun("The connected account does not match the intended reviewer or organization. Connect the intended reviewer account, then run the tests again.", planRevision);
  }
  const signedIn = "noSignIn" in reviewer ? undefined : reviewer;
  const saved = await stopOr(readRunTestPlan(lease), lease);
  if (saved === null) return notRun(unreadable(planRevision), planRevision);
  if (!saved) return notRun(notSaved(planRevision), planRevision);
  const { plan } = saved;
  if (!isPlan(plan)) return notRun(malformed(planRevision), planRevision);

  const dial: DirectoryDialOptions = {
    enteredUrl: options.target,
    fetchFn: options.fetchFn,
    mcpHeaders: signedIn?.mcpHeaders,
    signal: options.signal,
  };
  const session = await dialMcpServer(dial);
  if (options.signal.aborted) throw new ReadinessRunCancelledError();
  const listing = session.tools;
  if (!session.initialize.ok || !listing?.complete) {
    const error = session.initialize.error ?? listing?.error;
    // Refused with no credential: the answers and the server disagree.
    const status = session.initialize.status ?? 0;
    const refused = !signedIn && (status === 401 || status === 403);
    const reason = refused ? signInNeeded(status) : unlisted(error);
    return notRun(reason, planRevision);
  }
  const tools = listing.entries;
  const issues = checkPlan(plan, tools);
  if (!issues) return notRun(malformed(planRevision), planRevision);
  const asReviewer = {
    account: signedIn?.accountId ?? null,
    missingFixtures: missingInPlan(plan, options.fixtures),
  };
  // Before the sweep, and reported only. A case without arguments is an
  // issue that keeps the plan from running, so no sweep follows a pass with
  // anything to draft, and the pass may take the run's time up to finalizing.
  const drafting = await draftMissingArguments({
    plan,
    tools,
    request: options.requestDrafts,
    signal: options.signal,
    endBy: options.deadlineAt - FINALIZE_MS,
  });
  const drafted = drafting ? { drafting } : {};
  if (issues.length > 0) {
    const stopped = { by: "setup" as const, detail: MISMATCH };
    const results = summarize(plan, tools, ledger.calls, stopped, asReviewer);
    return {
      ...notRun(MISMATCH, planRevision),
      issues,
      ...results,
      ...drafted,
    };
  }

  const endpoint = redactSharedServerUrl(options.target);
  const timeoutMs = plan.budget.callTimeoutMs;
  let id = 1000;
  const execution = await executeDirectoryTestPlan({
    plan,
    tools,
    ledger: ledger.calls,
    ...asReviewer,
    send: (request) =>
      dialToolCall(
        { ...dial, timeoutMs },
        request.tool,
        session.initialize.sessionId,
        id++,
        request.arguments,
        request.capture,
      ),
    record: (call) => recordRunCall(lease, call, planRevision),
    signal: options.signal,
    casesBy: options.deadlineAt - FINALIZE_MS - CLEANUP_MS - timeoutMs,
    cleanupBy: options.deadlineAt - FINALIZE_MS - timeoutMs,
    ...(endpoint.length <= MAX_ENDPOINT_LENGTH ? { endpoint } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const { stopped, cleanup } = execution;
  const results = summarize(plan, tools, execution.calls, stopped, asReviewer);
  const ambiguousCleanup = cleanup
    .filter((call) => call.phase === "ambiguous")
    .map((call) => call.callKey);
  return {
    planRevision,
    status: stopped ? "stopped" : "completed",
    ...(stopped ? { stopped } : {}),
    ...results,
    ambiguous: [...results.ambiguous, ...ambiguousCleanup],
    cleanup,
    ...drafted,
  };
}

/** The value, `null` for any failure but a stop signal, which is rethrown. */
async function stopOr<T>(
  pending: Promise<T>,
  lease: ReadinessLease,
): Promise<T | null> {
  try {
    return await pending;
  } catch (error) {
    if (isStopSignal(error)) throw error;
    logger.warn(
      "[readiness] the run's test plan or call ledger was unreadable",
      {
        runId: lease.runId,
        detail: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}

/** Whether the stored plan has the shape the validator reads. */
function isPlan(value: unknown): value is DirectoryTestPlan {
  const plan = asRecord(value);
  const lists = [plan?.fixtures, plan?.tools, plan?.cases, plan?.cleanup];
  const budget = asRecord(plan?.budget);
  return plan?.schemaVersion === 1 && !!budget && lists.every(Array.isArray);
}

/** The plan's issues, or `undefined` when a nested part is not readable. */
function checkPlan(
  plan: DirectoryTestPlan,
  tools: readonly DirectoryTestPlanTool[],
): DirectoryTestPlanIssue[] | undefined {
  try {
    return validateDirectoryTestPlan(plan, tools);
  } catch {
    // A field of the wrong type deep in a plan saved by an older client.
    return undefined;
  }
}

/**
 * The plan's existing fixtures the reviewer path looked up and did not find.
 * The reviewer section names a resource as the plan does: by the fixture's
 * id or by one of its values, ignoring case.
 */
function missingInPlan(
  plan: DirectoryTestPlan,
  lookup: DirectoryReviewerFixtureEvidence | undefined,
): string[] {
  const key = (name: string | number) => String(name).trim().toLowerCase();
  const missing = new Set(
    lookup?.fixtures.flatMap((entry) =>
      entry.status === "missing" ? [key(entry.name)] : [],
    ),
  );
  return plan.fixtures
    .filter(
      ({ id, origin, values }) =>
        origin === "existing" &&
        [id, ...Object.values(values ?? {})].some((name) =>
          missing.has(key(name)),
        ),
    )
    .map(({ id }) => id);
}

function summarize(
  plan: DirectoryTestPlan,
  tools: readonly DirectoryTestPlanTool[],
  calls: readonly DirectoryTestCallRecord[],
  stopped: SummarizeDirectoryToolTestsInput["stopped"],
  reviewer: { account: string | null; missingFixtures: string[] },
): { tools: DirectoryToolTestResult[]; ambiguous: string[] } {
  const results = summarizeDirectoryToolTests({
    plan,
    tools,
    calls,
    ...(stopped ? { stopped } : {}),
    ...reviewer,
  });
  const ambiguous = results.flatMap((tool) =>
    tool.cases
      .filter((result) => result.status === "ambiguous")
      .map((result) => result.caseId),
  );
  return { tools: results, ambiguous };
}
