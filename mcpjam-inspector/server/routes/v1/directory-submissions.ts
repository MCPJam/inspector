/**
 * Public `/api/v1` directory submissions: a saved rehearsal of one
 * directory's submission form for one saved server, and the readiness runs
 * that grade it.
 *
 * A person in the browser and an agent over this API edit the same answers.
 * Every write names the revision it read, and the backend refuses it only
 * when a field it touches changed since; the refusal carries the submission
 * as it is now, so the writer can reapply its change without another read.
 * Bodies are `strictObject`, like the readiness routes: an unknown key is a
 * 400, never a silent forward.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  DIRECTORY_FLOWS,
  DIRECTORY_FLOW_IDS,
  getDirectoryFlow,
  type DirectoryFlow,
} from "@mcpjam/sdk";
import type { PlatformDirectorySubmission as Submission } from "@mcpjam/sdk/platform";
import { authorizeServer } from "../web/auth.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { captureServerEvent } from "../../utils/analytics.js";
import { logger } from "../../utils/logger.js";
import {
  startHostedReadinessRun,
  toReadinessRunDto,
} from "../shared/readiness-runs.js";
import { runnableReviewerAttemptId } from "../shared/reviewer-attempts.js";
import { readinessAnalyticsActor } from "./readiness.js";
import { readJsonObjectBody } from "./adapter.js";
import { createConvexClient } from "./convex-client.js";
import { requireConvexIdShape, requireProjectIdArg } from "./convex-id-param.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { redactForLog } from "./redact-log-message.js";
import {
  accountPrefill,
  actorLabel,
  planAnswerChange,
  writeChannel,
} from "./directory-submission-writes.js";
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
const mutation = (name: string) => makeFunctionReference<"mutation">(name);
const fn = {
  create: mutation("directorySubmissions:createDirectorySubmission"),
  get: query("directorySubmissions:getDirectorySubmission"),
  list: query("directorySubmissions:listDirectorySubmissions"),
  update: mutation("directorySubmissions:updateDirectorySubmission"),
  remove: mutation("directorySubmissions:deleteDirectorySubmission"),
  getRun: query("claudeReadinessRuns:getReadinessRun"),
};

const idempotencyKey = z.string().trim().min(1).max(200).optional();
const optionalId = z.string().trim().min(1).max(100).optional();
const VERSION_NOT_FOUND = "Plugin version not found";

const createSchema = z.strictObject({
  flowId: z.string().trim().min(1).max(100),
  serverId: z.string().trim().min(1).max(100),
  title: z.string().max(200).optional(),
  idempotencyKey,
});

const answerValue = z.union([z.string(), z.number(), z.boolean(), z.null()])
  .or(z.array(z.string()))
  .or(z.array(z.record(z.string(), z.string())));

const checkIds = z.array(z.string().trim().min(1).max(120)).max(200);

const updateSchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  /** `null` removes the answer. */
  answers: z.record(z.string().min(1).max(100), answerValue).optional(),
  confirm: z.array(z.string().min(1).max(100)).max(200).optional(),
  title: z.string().max(200).optional(),
  /** Which checks fail a run. The backend checks the ids; `null` clears it. */
  checkGate: z
    .strictObject({ failOn: checkIds.optional(), warnOnly: checkIds.optional() })
    .nullable()
    .optional(),
  /** A plugin flow's stored plugin, replaced whole. `null` clears it. */
  plugin: z
    .strictObject({ pluginId: optionalId, pluginVersionId: optionalId })
    .nullable()
    .optional(),
  /** Which attempt at the directory this rehearses. `null` clears it. */
  attempt: z.number().int().min(1).nullable().optional(),
  idempotencyKey,
});

const startSchema = z.strictObject({
  idempotencyKey,
  /** The one field that can spend. Off unless sent, as on the readiness starts. */
  includeLlmObservations: z.boolean().optional(),
  /** The stored plugin version a ChatGPT plugin submission's run grades. */
  pluginVersionId: optionalId,
  /** A running reviewer sign-in attempt of this submission, for the run to work on. */
  reviewerAttemptId: z.string().trim().min(1).max(100).optional(),
  /** The saved test plan revision to run; naming it authorizes its calls. */
  testPlanRevision: z.number().int().min(1).optional(),
});

function idParam(value: string | undefined, param: string, notFound: string) {
  return requireConvexIdShape(value, param, {
    scope: SCOPE,
    notFoundMessage: notFound,
  });
}

export function scopeOf(c: Context) {
  return {
    projectId: requireProjectIdArg(c.req.param("projectId"), SCOPE),
    submissionId: idParam(c.req.param("submissionId"), "submissionId", NOT_FOUND),
  };
}

export async function readSubmission(
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

export function flowOf(row: Submission): DirectoryFlow {
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

/**
 * The plugin and attempt a write sets, each id checked before Convex sees it.
 * The backend checks that the plugin is in the project and the version ready.
 */
function subjectChange({ plugin, attempt }: z.infer<typeof updateSchema>) {
  const named = plugin && {
    ...(plugin.pluginId
      ? {
          pluginId: idParam(
            plugin.pluginId,
            "plugin.pluginId",
            "Plugin not found",
          ),
        }
      : {}),
    ...(plugin.pluginVersionId
      ? {
          pluginVersionId: idParam(
            plugin.pluginVersionId,
            "plugin.pluginVersionId",
            VERSION_NOT_FOUND,
          ),
        }
      : {}),
  };
  return {
    ...(plugin !== undefined ? { plugin: named } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
  };
}

function refuseRun(message: string): WebRouteError {
  return new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    `pluginVersionId: ${message}`,
  );
}

/**
 * What a run grades beside the saved server. ChatGPT reviews a plugin as a
 * package, so its run grades a stored version of it: the one the caller
 * names, never one read off the submission. The shapes without a package are
 * not offered for a plugin submission.
 */
function packageOf(
  flow: DirectoryFlow,
  pluginVersionId: string | undefined,
): { submissionMode?: "mcp-uploaded-skills"; pluginVersionId?: string } {
  if (flow.directory !== "openai") {
    if (pluginVersionId === undefined) return {};
    throw refuseRun(
      "Only a ChatGPT plugin submission grades a plugin version. Leave it out.",
    );
  }
  if (pluginVersionId === undefined) {
    throw refuseRun(
      "A ChatGPT plugin submission's run grades a stored version of its plugin. Send the version to grade.",
    );
  }
  return { submissionMode: "mcp-uploaded-skills", pluginVersionId };
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

directorySubmissions.post("/projects/:projectId/directory-submissions", async (c) => {
  const projectId = requireProjectIdArg(c.req.param("projectId"), SCOPE);
  const body = parseWithSchema(createSchema, await readJsonObjectBody(c));
  const flow = getDirectoryFlow(body.flowId);
  if (!flow) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `flowId: Use one of: ${DIRECTORY_FLOW_IDS.join(", ")}.`,
    );
  }
  const serverId = idParam(body.serverId, "serverId", "Server not found");
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  let created: { submissionId: string; reused: boolean };
  try {
    created = await convex.mutation(fn.create, {
      projectId,
      serverId,
      flowId: flow.id,
      flowVersion: flow.version,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      prefill: await accountPrefill(convex, projectId, flow),
    });
  } catch (error) {
    throw translateConvexWriteError(error, { resource: RESOURCE });
  }
  const row = await readSubmission(convex, projectId, created.submissionId);
  const view = await viewOf(convex, row);
  return v1Resource(c, created.reused ? { ...view, replayed: true } : view, 201);
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

directorySubmissions.patch(ONE, async (c) => {
  const { projectId, submissionId } = scopeOf(c);
  const body = parseWithSchema(updateSchema, await readJsonObjectBody(c));
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  const row = await readSubmission(convex, projectId, submissionId);
  const change = planAnswerChange(flowOf(row), row.answers, body);
  const label = actorLabel(c);
  let updated: Submission & { replayed?: true };
  try {
    updated = await convex.mutation(fn.update, {
      submissionId,
      expectedRevision: body.expectedRevision,
      ...change,
      ...(body.checkGate !== undefined ? { checkGate: body.checkGate } : {}),
      ...subjectChange(body),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(label ? { actorLabel: label } : {}),
      setVia: writeChannel(c),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    });
  } catch (error) {
    const refusal = translateConvexWriteError(error, { resource: RESOURCE });
    if (refusal.status === 409) {
      // Best effort: `currentRevision` alone already tells the writer to read again.
      try {
        const current = await readSubmission(convex, projectId, submissionId);
        refusal.details = { ...refusal.details, current: await viewOf(convex, current) };
      } catch (readError) {
        logger.warn(`[${SCOPE}] could not read a conflicting submission back`, {
          detail: redactForLog(readError),
        });
      }
    }
    throw refusal;
  }
  const view = await viewOf(convex, updated);
  return v1Resource(c, updated.replayed ? { ...view, replayed: true } : view);
});

directorySubmissions.delete(ONE, async (c) => {
  const { projectId, submissionId } = scopeOf(c);
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  // Read first, so another project's submission answers 404 here too.
  await readSubmission(convex, projectId, submissionId);
  try {
    await convex.mutation(fn.remove, { submissionId });
  } catch (error) {
    throw translateConvexWriteError(error, { resource: RESOURCE });
  }
  return v1Resource(c, { id: submissionId, deleted: true });
});

/**
 * Grade the submission's saved server with its answers frozen at this
 * revision, and for a ChatGPT plugin the stored version the body names. The
 * server is authorized exactly as the readiness start does, and the directory
 * comes from the submission's flow, never the body.
 */
directorySubmissions.post(`${ONE}/runs`, async (c) => {
  const { projectId, submissionId } = scopeOf(c);
  const body = parseWithSchema(startSchema, await readJsonObjectBody(c));
  const convexAuthToken = await getConvexBearerForRequest(c);
  const convex = createConvexClient(convexAuthToken);
  const row = await readSubmission(convex, projectId, submissionId);
  const flow = flowOf(row);
  const graded = packageOf(
    flow,
    body.pluginVersionId === undefined
      ? undefined
      : idParam(body.pluginVersionId, "pluginVersionId", VERSION_NOT_FOUND),
  );
  if (!row.serverId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "This submission has no saved server to grade. Create a submission for a saved server, then start its run.",
    );
  }
  const reviewerAttemptId =
    body.reviewerAttemptId &&
    (await runnableReviewerAttemptId(convex, { projectId, submissionId }, body.reviewerAttemptId, (error) =>
      readRefusal(error, "Reviewer attempt"),
    ));
  const receipt = await startHostedReadinessRun({
    convex,
    projectId,
    serverId: row.serverId,
    publisher: flow.directory,
    idempotencyKey: body.idempotencyKey,
    includeLlmObservations: body.includeLlmObservations === true,
    submissionId,
    ...graded,
    ...(reviewerAttemptId ? { reviewerAttemptId } : {}),
    testPlanRevision: body.testPlanRevision,
    authorized: await authorizeServer(c, convexAuthToken, projectId, row.serverId),
    analyticsActor: readinessAnalyticsActor(c, projectId),
    translateError: (error) =>
      translateConvexWriteError(error, { resource: "Readiness run" }),
  });
  captureServerEvent(c, "directory_readiness_run_started_server", {
    readiness_kind: flow.directory,
    submission_mode: graded.submissionMode ?? null,
    flow_id: flow.id,
    include_llm_observations: body.includeLlmObservations === true,
    deduped: receipt.deduped,
    run_status: receipt.status,
  });
  return v1Resource(c, receipt, 202);
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
    // Read with the results, so a caller judges them under the gate as it is.
    checkGate: row.checkGate ?? null,
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
