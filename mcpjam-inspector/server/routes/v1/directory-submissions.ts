/**
 * Public `/api/v1` directory submissions: a saved rehearsal of one
 * directory's submission form for one saved server, and the readiness runs
 * that grade it.
 */
import { Hono, type Context } from "hono";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  DIRECTORY_FLOWS,
  DIRECTORY_FLOW_IDS,
  getDirectoryFlow,
  type DirectoryFlow,
} from "@mcpjam/sdk";
import type { PlatformDirectorySubmission as Submission } from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { toReadinessRunDto } from "../shared/readiness-runs.js";
import { createConvexClient } from "./convex-client.js";
import { requireConvexIdShape, requireProjectIdArg } from "./convex-id-param.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import {
  latestResults,
  placeResults,
  readRefusal,
  resultsOf,
  sumCounts,
  toFlowSummary,
  toSubmissionSummary,
  toSubmissionView,
  type RunRow,
} from "./directory-submission-views.js";

const directorySubmissions = new Hono();

const SCOPE = "v1.directory-submissions";
const RESOURCE = "Directory submission";
const NOT_FOUND = "Directory submission not found";
const RUN_NOT_FOUND = "Readiness run not found for this submission";

const query = (name: string) => makeFunctionReference<"query">(name);
const fn = {
  get: query("directorySubmissions:getDirectorySubmission"),
  list: query("directorySubmissions:listDirectorySubmissions"),
  getRun: query("claudeReadinessRuns:getReadinessRun"),
};

function idParam(value: string | undefined, param: string, notFound: string) {
  return requireConvexIdShape(value, param, {
    scope: SCOPE,
    notFoundMessage: notFound,
  });
}

function scopeOf(c: Context) {
  return {
    projectId: requireProjectIdArg(c.req.param("projectId"), SCOPE),
    submissionId: idParam(c.req.param("submissionId"), "submissionId", NOT_FOUND),
  };
}

async function readSubmission(
  convex: ConvexHttpClient,
  projectId: string,
  submissionId: string,
): Promise<Submission> {
  let row: Submission | null;
  try {
    row = await convex.query(fn.get, { submissionId });
  } catch (error) {
    throw readRefusal(error, RESOURCE);
  }
  // Another project's submission is not this path's to read, even for a
  // caller who can read it under its own project.
  if (!row || row.projectId !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, NOT_FOUND);
  }
  return row;
}

function flowOf(row: Submission): DirectoryFlow {
  const flow = getDirectoryFlow(row.flowId);
  if (!flow) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      `This submission follows the ${row.flowId} form, which this server cannot read yet. Try again after MCPJam updates.`,
    );
  }
  return flow;
}

async function viewOf(convex: ConvexHttpClient, row: Submission) {
  const flow = flowOf(row);
  return toSubmissionView(flow, row, await latestResults(convex, row));
}

directorySubmissions.get("/directory-flows", (c) =>
  v1PageJson(c, Object.values(DIRECTORY_FLOWS).map(toFlowSummary)),
);

directorySubmissions.get("/directory-flows/:flowId", (c) => {
  const flow = getDirectoryFlow(c.req.param("flowId"));
  if (!flow) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      `Directory flow not found. Use one of: ${DIRECTORY_FLOW_IDS.join(", ")}.`,
    );
  }
  return v1Resource(c, flow);
});

directorySubmissions.get("/projects/:projectId/directory-submissions", async (c) => {
  const projectId = requireProjectIdArg(c.req.param("projectId"), SCOPE);
  const { serverId, flowId, limit: rawLimit } = c.req.query();
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 100)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "limit must be an integer between 1 and 100",
    );
  }
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  let rows: Submission[];
  try {
    rows = await convex.query(fn.list, {
      projectId,
      ...(serverId ? { serverId: idParam(serverId, "serverId", "Server not found") } : {}),
      ...(flowId ? { flowId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  } catch (error) {
    throw readRefusal(error, "Directory submissions");
  }
  return v1PageJson(c, rows.map(toSubmissionSummary));
});

const ONE = "/projects/:projectId/directory-submissions/:submissionId";

directorySubmissions.get(ONE, async (c) => {
  const { projectId, submissionId } = scopeOf(c);
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  const row = await readSubmission(convex, projectId, submissionId);
  return v1Resource(c, await viewOf(convex, row));
});

directorySubmissions.get(`${ONE}/results`, async (c) => {
  const { projectId, submissionId } = scopeOf(c);
  const runId = c.req.query("runId");
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  const row = await readSubmission(convex, projectId, submissionId);
  const flow = flowOf(row);
  const results =
    runId === undefined
      ? await latestResults(convex, row)
      : await resultsOf(convex, await readCompleteRun(convex, row, runId));
  const steps = placeResults(flow, row, results);
  const reportUrl = (id: string) =>
    `/api/v1/projects/${projectId}/readiness-runs/${id}/report`;
  return v1Resource(c, {
    run: results.run ? toReadinessRunDto(results.run, { projectId, reportUrl }) : null,
    steps,
    counts: sumCounts(steps),
  });
});

/** The run `runId` names, if it graded this submission and completed. */
async function readCompleteRun(
  convex: ConvexHttpClient,
  row: Submission,
  runId: string,
): Promise<RunRow> {
  let run: RunRow | null;
  try {
    run = await convex.query(fn.getRun, {
      runId: idParam(runId, "runId", RUN_NOT_FOUND),
    });
  } catch (error) {
    throw readRefusal(error, "Readiness run");
  }
  if (!run || run.submissionId !== row.id) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, RUN_NOT_FOUND);
  }
  if (run.status !== "completed") {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      run.status === "pending" || run.status === "running"
        ? "This run has not finished, so it has no results yet. Read them again when the run completes."
        : "This run did not complete, so it has no results. Start a new run from the submission.",
    );
  }
  return run;
}

export default directorySubmissions;
