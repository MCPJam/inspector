/**
 * Public v1 EVAL RUN INSIGHTS: request, cancel, and the findings build the
 * analysis explains.
 *
 * These call the same Convex mutations as the app's run page, so role, quota
 * and conflict checks are identical on every surface. The app's Analyze
 * button builds findings first when a run has none, then requests the
 * analysis; agents do the same two steps through these routes.
 *
 * Results are read from the run detail's `insights` envelope
 * (`GET /eval-runs/:runId`); none of these routes returns findings.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { createConvexClient } from "./convex-client.js";
import { requireConvexIdParam } from "./convex-id-param.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { v1Resource } from "./envelope.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";

const evalRunInsights = new Hono();

const RESOURCE = "Eval run insights";

/**
 * Resolve the run and assert it belongs to the path's project, so a valid id
 * from another of the caller's projects answers 404 rather than acting
 * across the scope the path declares.
 */
async function preflightRun(c: Context) {
  const projectId = c.req.param("projectId");
  const runId = requireConvexIdParam(c, "runId", {
    scope: "v1.evals",
    notFoundMessage: "Eval run not found",
  });
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  let run: { projectId?: unknown } | null;
  try {
    run = (await convex.query(
      "testSuites:getTestSuiteRun" as never,
      {
        runId,
      } as never,
    )) as { projectId?: unknown } | null;
  } catch (error) {
    throw translateConvexReadError(error, {
      scope: "v1.evals",
      notFoundMessage: "Eval run not found",
      redactedIsRefusal: true,
    });
  }
  if (!run || String(run.projectId ?? "") !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
  }
  return { convex, projectId, runId };
}

/**
 * `{ force?: boolean }`, validated rather than coerced: these requests count
 * against the daily insight quota or replace stored findings, so malformed
 * JSON is a 400 instead of an empty body that acts anyway, and
 * `{"force":"false"}` (a truthy string) is refused rather than read as
 * consent. Only an actually empty body is bodyless.
 */
async function readForce(c: Context): Promise<boolean> {
  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Request body must be valid JSON.",
      );
    }
  }
  return (
    parseWithSchema(z.object({ force: z.boolean().optional() }).strict(), body)
      .force === true
  );
}

// POST /v1/projects/:projectId/eval-runs/:runId/insights
//
// Starts the findings analysis, the one the app's run page runs. 202: poll the
// run detail's `insights` envelope rather than re-requesting. Included with
// MCPJam (no credits); it counts against the organization's daily insight
// quota, shared with goal, study and user-testing insights. A run with
// findings not yet built answers 409; build them first (below).
evalRunInsights.post(
  "/projects/:projectId/eval-runs/:runId/insights",
  async (c) => {
    const { convex, projectId, runId } = await preflightRun(c);
    const force = await readForce(c);
    try {
      await convex.mutation(
        "serverQuality:requestServerQuality" as never,
        {
          suiteRunId: runId,
          mode: "findings",
          ...(force ? { force: true } : {}),
        } as never,
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: RESOURCE });
    }
    return v1Resource(c, { runId, projectId, status: "pending" }, 202);
  },
);

// DELETE /v1/projects/:projectId/eval-runs/:runId/insights
//
// Cancel a running analysis: the recovery path for a run stuck `pending`,
// which cannot be re-requested even with `force`. The run then reads
// `failed`, reason `cancelled`, not retryable. 409 when nothing is running.
evalRunInsights.delete(
  "/projects/:projectId/eval-runs/:runId/insights",
  async (c) => {
    const { convex, projectId, runId } = await preflightRun(c);
    try {
      await convex.mutation(
        "serverQuality:cancelServerQuality" as never,
        { suiteRunId: runId } as never,
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: RESOURCE });
    }
    return v1Resource(c, { runId, projectId, canceled: true });
  },
);

// POST /v1/projects/:projectId/eval-runs/:runId/findings/build
//
// Build (or with `force`, rebuild) the run's findings from its recorded
// evidence. Deterministic, no model call. 202: poll the run detail's
// `insights.unifiedFindings.job`. On a run that has never been analyzed, a
// finished build starts the analysis automatically.
evalRunInsights.post(
  "/projects/:projectId/eval-runs/:runId/findings/build",
  async (c) => {
    const { convex, projectId, runId } = await preflightRun(c);
    const force = await readForce(c);
    try {
      await convex.mutation(
        "evalFindings:requestEvalFindingsBuild" as never,
        { suiteRunId: runId, ...(force ? { force: true } : {}) } as never,
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Eval run findings" });
    }
    return v1Resource(c, { runId, projectId, status: "pending" }, 202);
  },
);

export default evalRunInsights;
