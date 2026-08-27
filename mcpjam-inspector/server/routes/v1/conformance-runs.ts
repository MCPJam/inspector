/**
 * Public `/api/v1` persisted conformance runs.
 *
 * A start is a `202` plus a run id. The target comes from the saved server
 * the path names — never from the body — and OAuth is refused at the schema
 * because this surface has no interactive consent loop. Poll the run, list
 * them, or fetch a bounded failing-check projection of the stored reports.
 */

import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { authorizeServer, parseWithSchema } from "../web/auth.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { translateConvexWriteError as translateConvexError } from "./convex-errors.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import {
  HOSTED_CONFORMANCE_SUITES,
  fetchSuiteReports,
  projectConformanceReports,
  startHostedConformanceRun,
  toConformanceRunDto,
} from "../shared/conformance-runs.js";

const conformanceRuns = new Hono();

const LIST_MAX_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 20;

function createConvexClient(convexAuthToken: string): ConvexHttpClient {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration",
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(convexAuthToken);
  return client;
}

const startConformanceSchema = z.strictObject({
  suites: z.array(z.enum(HOSTED_CONFORMANCE_SUITES)).min(1).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  protocolVersion: z.string().trim().min(1).optional(),
  engineVersion: z.string().trim().min(1).optional(),
});

function reportUrlFor(projectId: string, runId: string): string {
  return `/api/v1/projects/${projectId}/conformance-runs/${runId}/report`;
}

function toRunDto(run: Record<string, any>, projectId: string) {
  return toConformanceRunDto(run, {
    projectId,
    reportUrl: (runId) => reportUrlFor(projectId, runId),
  });
}

function assertSameProject(
  run: Record<string, any>,
  projectId: string,
): void {
  if (run.projectId && run.projectId !== projectId) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Conformance run not found",
    );
  }
}

async function readBody(c: any): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be valid JSON.",
    );
  }
}

function paginationOptsFrom(c: {
  req: { query: (k: string) => string | undefined };
}): { cursor: string | null; numItems: number } {
  const cursor = c.req.query("cursor");
  const rawLimit = c.req.query("limit");
  if (rawLimit !== undefined) {
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `limit must be an integer between 1 and ${LIST_MAX_LIMIT}`,
      );
    }
    return {
      cursor: cursor && cursor.length > 0 ? cursor : null,
      numItems: limit,
    };
  }
  return {
    cursor: cursor && cursor.length > 0 ? cursor : null,
    numItems: DEFAULT_PAGE_SIZE,
  };
}

function nextCursorFrom(result: {
  isDone: boolean;
  continueCursor: string;
}): string | undefined {
  return result.isDone ? undefined : result.continueCursor || undefined;
}

async function loadRun(
  convex: ConvexHttpClient,
  runId: string,
  projectId: string,
): Promise<Record<string, any>> {
  let run: Record<string, any> | null;
  try {
    run = await convex.query("conformanceRuns:getRun" as any, { runId });
  } catch (error) {
    throw translateConvexError(error, { resource: "Conformance run" });
  }
  if (!run) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Conformance run not found",
    );
  }
  assertSameProject(run, projectId);
  return run;
}

// ── Start ───────────────────────────────────────────────────────────────

conformanceRuns.post(
  "/projects/:projectId/servers/:serverId/conformance-runs",
  async (c) => {
    const body = parseWithSchema(startConformanceSchema, await readBody(c));
    const projectId = c.req.param("projectId");
    const serverId = c.req.param("serverId");
    const convexAuthToken = await getConvexBearerForRequest(c);
    const authorized = await authorizeServer(
      c,
      convexAuthToken,
      projectId,
      serverId,
    );
    const receipt = await startHostedConformanceRun({
      convexToken: convexAuthToken,
      projectId,
      serverId,
      authorized,
      suites: body.suites,
      idempotencyKey: body.idempotencyKey,
      protocolVersion: body.protocolVersion,
      engineVersion: body.engineVersion,
      translateError: (error) =>
        translateConvexError(error, { resource: "Conformance run" }),
    });
    return v1Resource(c, receipt, 202);
  },
);

// ── Read ────────────────────────────────────────────────────────────────
// `/report` is registered before `/:runId` so a static suffix cannot be
// captured as a run id.

conformanceRuns.get(
  "/projects/:projectId/conformance-runs/:runId/report",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const convex = createConvexClient(await getConvexBearerForRequest(c));
    const run = await loadRun(convex, runId, projectId);
    const reports = Array.isArray(run.reports) ? run.reports : [];
    const stored = reports.filter(
      (report: { reportUrl?: unknown }) =>
        typeof report.reportUrl === "string" && report.reportUrl.length > 0,
    );
    if (stored.length === 0) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "This conformance run has no stored report.",
      );
    }
    const suiteReports = await fetchSuiteReports(stored);
    return v1Resource(c, projectConformanceReports(run, suiteReports));
  },
);

conformanceRuns.get(
  "/projects/:projectId/conformance-runs/:runId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const convex = createConvexClient(await getConvexBearerForRequest(c));
    const run = await loadRun(convex, runId, projectId);
    return v1Resource(c, toRunDto(run, projectId));
  },
);

conformanceRuns.get("/projects/:projectId/conformance-runs", async (c) => {
  const projectId = c.req.param("projectId");
  const serverId = c.req.query("serverId");
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  let page: {
    page: Record<string, any>[];
    isDone: boolean;
    continueCursor: string;
  };
  try {
    page = await convex.query("conformanceRuns:listRuns" as any, {
      projectId,
      ...(serverId ? { targetKey: `server:${serverId}` } : {}),
      paginationOpts: paginationOptsFrom(c),
    });
  } catch (error) {
    throw translateConvexError(error, { resource: "Conformance runs" });
  }
  return v1PageJson(
    c,
    page.page.map((run) => toRunDto(run, projectId)),
    nextCursorFrom(page),
  );
});

export default conformanceRuns;
