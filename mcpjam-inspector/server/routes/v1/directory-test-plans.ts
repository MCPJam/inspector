/**
 * Public `/api/v1` test plans beside one directory submission: the saved plan
 * and its revisions, a draft from the server's stored tool list, and what a
 * run's calls showed, tool by tool.
 *
 * A plan names every call a run may make on the reviewer's server, and naming
 * its revision when a run starts is the consent to those calls. A save names
 * the revision it read and is refused with the current one when another
 * landed since, so a person and an agent never overwrite each other's plan.
 *
 * What a plan means is the SDK's to judge (`validateDirectoryTestPlan`). A
 * plan with issues is saved, so it can be edited, and its issues come back
 * with it; a plan over a limit is refused before the backend sees it.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  DIRECTORY_TEST_CASE_STATUSES,
  DIRECTORY_TOOL_TEST_STATUSES,
  draftDirectoryTestPlan,
  summarizeDirectoryToolTests,
  validateDirectoryTestPlan,
  type DirectoryTestPlan,
  type DirectoryToolTestResult,
  type SummarizeDirectoryToolTestsInput,
} from "@mcpjam/sdk";
import {
  directoryTestPlanSchema,
  type PlatformDirectorySubmission as Submission,
  type PlatformDirectoryTestPlanRevision,
} from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import type { DirectoryToolTestReport } from "../../services/readiness/test-plan-run.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { toReadinessRunDto } from "../shared/readiness-runs.js";
import { readJsonObjectBody } from "./adapter.js";
import { createConvexClient } from "./convex-client.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { v1Resource } from "./envelope.js";
import { readSubmission, readSubmissionRun, scopeOf } from "./directory-submissions.js";
import { readRefusal, readStoredReport, type RunRow } from "./directory-submission-views.js";
import {
  readRunCalls,
  readServerTools,
  readStoredTestPlan,
  toTestPlan,
  type RunCall,
} from "./directory-test-plan-reads.js";

const plans = new Hono();

const ONE = "/projects/:projectId/directory-submissions/:submissionId";
const PLAN = `${ONE}/test-plan`;
/** Newest first, as the results read scans them. */
const RUN_SCAN_LIMIT = 50;

const fn = {
  save: makeFunctionReference<"mutation">("directoryTestPlans:saveDirectoryTestPlan"),
  listRuns: makeFunctionReference<"query">("claudeReadinessRuns:listReadinessRuns"),
};

/** The submission the path names, read under the caller's bearer. */
async function opened(c: Context) {
  const { projectId, submissionId } = scopeOf(c);
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  return { convex, row: await readSubmission(convex, projectId, submissionId) };
}

/** The tool list a plan is drafted from and checked against, or why there is none. */
async function serverTools(c: Context, row: Submission) {
  if (!row.serverId) {
    return "This submission has no saved server, so there are no tools to plan for. Create a submission for a saved server.";
  }
  return readServerTools(c, row.projectId, row.serverId);
}

async function requireServerTools(c: Context, row: Submission) {
  const listed = await serverTools(c, row);
  if (typeof listed === "string") throw new WebRouteError(409, ErrorCode.CONFLICT, listed);
  return listed;
}

const planQuery = z.object({
  revision: z.coerce.number().int().min(1).optional(),
});

plans.get(PLAN, async (c) => {
  const { revision } = parseWithSchema(planQuery, c.req.query());
  const { convex, row } = await opened(c);
  const stored = await readStoredTestPlan(convex, row.id, revision);
  if (!stored) {
    const message =
      revision === undefined
        ? "This submission has no saved test plan. Draft one, then save it."
        : `Test plan revision ${revision} is no longer kept. Read the current plan instead.`;
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, message);
  }
  const plan = toTestPlan(stored);
  const listed = await serverTools(c, row);
  // A plan stays readable without a tool list; it just cannot be checked.
  const checked =
    typeof listed === "string"
      ? { issues: null, catalog: null }
      : {
          issues: validateDirectoryTestPlan(plan, listed.tools),
          catalog: listed.catalog,
        };
  return v1Resource(c, { ...stored, plan, ...checked });
});

plans.get(`${PLAN}/draft`, async (c) => {
  const { convex, row } = await opened(c);
  const [listed, stored] = await Promise.all([requireServerTools(c, row), readStoredTestPlan(convex, row.id)]);
  const plan = draftDirectoryTestPlan(listed.tools);
  return v1Resource(c, {
    plan,
    issues: validateDirectoryTestPlan(plan, listed.tools),
    catalog: listed.catalog,
    currentRevision: stored?.revision ?? 0,
  });
});

const saveSchema = z.strictObject({
  /** The revision the caller read; 0 for the first plan. */
  expectedRevision: z.number().int().min(0),
  plan: directoryTestPlanSchema,
});

plans.put(PLAN, async (c) => {
  const body = parseWithSchema(saveSchema, await readJsonObjectBody(c));
  const { convex, row } = await opened(c);
  const listed = await requireServerTools(c, row);
  const issues = validateDirectoryTestPlan(body.plan, listed.tools);
  const over = issues.filter((issue) => issue.code === "limit");
  if (over.length > 0) {
    const message = `The test plan was not saved. ${over.map((issue) => issue.message).join(" ")}`;
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, message, {
      issues: over,
    });
  }
  let saved: PlatformDirectoryTestPlanRevision & { replayed?: true };
  try {
    saved = await convex.mutation(fn.save, {
      submissionId: row.id,
      expectedRevision: body.expectedRevision,
      // As text: call arguments hold `$fixture` keys a stored object may not.
      plan: JSON.stringify(body.plan),
    });
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Test plan" });
  }
  return v1Resource(c, { ...saved, issues, catalog: listed.catalog });
});

/** The newest run of the submission that named a test plan, or null. */
async function latestPlanRun(convex: ConvexHttpClient, row: Submission) {
  if (!row.lastRunId) return null;
  let runs: RunRow[];
  try {
    runs = await convex.query(fn.listRuns, {
      projectId: row.projectId,
      submissionId: row.id,
      limit: RUN_SCAN_LIMIT,
    });
  } catch (error) {
    throw readRefusal(error, "Readiness runs");
  }
  return runs.find((run) => typeof run.testPlanRevision === "number") ?? null;
}

function zeros<T extends string>(keys: readonly T[]) {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

/** Tools by status, and cases by status with valid input and negative cases apart. */
function countsOf(tools: readonly DirectoryToolTestResult[]) {
  const counts = {
    tools: zeros(DIRECTORY_TOOL_TEST_STATUSES),
    validInput: zeros(DIRECTORY_TEST_CASE_STATUSES),
    negative: zeros(DIRECTORY_TEST_CASE_STATUSES),
  };
  for (const tool of tools) {
    counts.tools[tool.status] += 1;
    for (const status of DIRECTORY_TEST_CASE_STATUSES) {
      counts.validInput[status] += tool.validInput[status];
      counts.negative[status] += tool.negative[status];
    }
  }
  return counts;
}

/** Why the cases a finished run never reached did not run. */
function stoppedBy(status: unknown): SummarizeDirectoryToolTestsInput["stopped"] {
  if (status === "cancelled") return { by: "cancelled" };
  if (status === "failed") {
    return {
      by: "setup",
      detail: "The run failed before this case. Start a new run.",
    };
  }
  return undefined;
}

/**
 * The calls so far, graded as they were made: the listing they were made
 * against is not stored, and the stored catalog's normalized tools would
 * read every result as stale.
 */
function gradeCalls(plan: DirectoryTestPlan, calls: RunCall[], runStatus: unknown) {
  const stopped = stoppedBy(runStatus);
  const tools = summarizeDirectoryToolTests({
    plan,
    calls: calls.map((call) => call.record),
    ...(stopped ? { stopped } : {}),
  });
  const caseIds = new Set(plan.cases.map((testCase) => testCase.id));
  const cleanup = calls.filter(({ record }) => !caseIds.has(record.callKey));
  // The SDK's rule for a case, applied to cleanup calls too: a write that
  // started and never finished may have changed data.
  const cleanupInDoubt = cleanup.filter(
    ({ record, effect }) => record.phase === "ambiguous" || (record.phase === "started" && effect !== "read"),
  );
  const inDoubt = [
    ...tools.flatMap((tool) =>
      tool.cases.flatMap((result) => (result.status === "ambiguous" && result.call ? [result.call] : [])),
    ),
    ...cleanupInDoubt.map(({ record }) => record),
  ];
  return {
    tools,
    counts: countsOf(tools),
    inDoubt,
    cleanup: cleanup.map(({ record }) => record),
  };
}

/** A finished run's own summary of its sweep, from its report; none when it left one. */
async function reportedToolTests(run: RunRow): Promise<DirectoryToolTestReport | undefined> {
  if (run.status !== "completed" || !run.hasReport) return undefined;
  const tests = (await readStoredReport(run.id))?.toolTests as DirectoryToolTestReport | undefined;
  // The worker writes this shape; anything else is graded from the ledger.
  return tests && [tests.tools, tests.cleanup, tests.ambiguous].every(Array.isArray) ? tests : undefined;
}

/** The report's summary, judged against the tool list its calls were made with. */
function fromReport({ status, reason, stopped, issues, ambiguous, tools, cleanup }: DirectoryToolTestReport) {
  const doubted = new Set(ambiguous);
  const calls = [...tools.flatMap((tool) => tool.cases.flatMap((result) => (result.call ? [result.call] : []))), ...cleanup];
  return {
    source: "report" as const,
    sweep: { status, ...(reason ? { reason } : {}), ...(stopped ? { stopped } : {}), ...(issues ? { issues } : {}) },
    tools,
    counts: countsOf(tools),
    inDoubt: calls.filter((call) => doubted.has(call.callKey)),
    cleanup,
  };
}

const toolTestsQuery = z.object({ runId: z.string().max(100).optional() });

plans.get(`${ONE}/tool-tests`, async (c) => {
  const { runId } = parseWithSchema(toolTestsQuery, c.req.query());
  const { convex, row } = await opened(c);
  const run = runId === undefined ? await latestPlanRun(convex, row) : await readSubmissionRun(convex, row, runId);
  const reportUrl = (id: string) => `/api/v1/projects/${row.projectId}/readiness-runs/${id}/report`;
  const dto = run && toReadinessRunDto(run, { projectId: row.projectId, reportUrl });
  const revision = typeof run?.testPlanRevision === "number" ? run.testPlanRevision : null;
  if (!run || revision === null) {
    // No plan named, so no tool was called.
    const none = { source: null, tools: [], counts: countsOf([]), inDoubt: [], cleanup: [] };
    return v1Resource(c, { run: dto, testPlanRevision: null, ...none });
  }
  const reported = await reportedToolTests(run);
  if (reported) return v1Resource(c, { run: dto, testPlanRevision: revision, ...fromReport(reported) });
  const [stored, calls] = await Promise.all([
    readStoredTestPlan(convex, row.id, revision),
    readRunCalls(convex, run.id, revision),
  ]);
  if (!stored) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      `Test plan revision ${revision} is no longer kept, so this run's calls cannot be matched to its cases. Start a new run with the current plan.`,
    );
  }
  return v1Resource(c, {
    run: dto,
    testPlanRevision: revision,
    source: "ledger",
    ...gradeCalls(toTestPlan(stored), calls, run.status),
  });
});

export default plans;
