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
import { MCP_PROTOCOL_VERSIONS } from "@mcpjam/sdk";
import { ConvexHttpClient } from "convex/browser";
import { authorizeServer, parseWithSchema } from "../web/auth.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { requireProjectIdArg } from "./convex-id-param.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { translateConvexWriteError as translateConvexError } from "./convex-errors.js";
import { redactedReadRefusalError } from "./convex-read-errors.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { readAnyIdempotencyKey } from "../../utils/idempotency.js";
import { readLaunchContext } from "../../utils/launch-context.js";
import { principalKey } from "../../utils/request-principal.js";
import { findConformanceCheck } from "../shared/conformance-check.js";
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
  // Refused here, before a run exists: an unknown version used to start a
  // run whose every suite then ended incomplete.
  protocolVersion: z
    .enum(MCP_PROTOCOL_VERSIONS, {
      error: `protocolVersion must be one of ${MCP_PROTOCOL_VERSIONS.join(", ")}.`,
    })
    .optional(),
  engineVersion: z.string().trim().min(1).optional(),
  /** `saved` (the default) runs the server's saved conformance settings. */
  settings: z.enum(["saved", "none"]).optional(),
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

function assertSameProject(run: Record<string, any>, projectId: string): void {
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
    // The scoping read for the caller-supplied run id. A plain membership
    // refusal — masked to "Server Error" in production — answers the same 404
    // an unknown id does instead of the terminal 500 (MJ-021).
    throw (
      redactedReadRefusalError(error, "Conformance run not found") ??
      translateConvexError(error, { resource: "Conformance run" })
    );
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
      // The header wins, in the order the eval launch routes read it.
      idempotencyKey: readAnyIdempotencyKey(c) ?? body.idempotencyKey,
      protocolVersion: body.protocolVersion,
      engineVersion: body.engineVersion,
      settings: body.settings,
      launcher: readLaunchContext(c)?.launcher,
      // 30 starts per user per 10 minutes: every start dials a third-party
      // server, and an agent in a loop would otherwise keep dialling.
      startLimitKey: c.get("workosUserId")
        ? `user:${c.get("workosUserId")}`
        : principalKey(c),
      translateError: (error) =>
        translateConvexError(error, { resource: "Conformance run" }),
    });
    return v1Resource(c, receipt, 202);
  },
);

// ── Read ────────────────────────────────────────────────────────────────
// `/report` and `/checks/:checkId` are registered before `/:runId` so a
// static suffix cannot be captured as a run id.

const SUITE_KINDS = ["protocol", "apps", "tasks", "oauth"] as const;

/** The run's suite reports that have a stored blob, or a 404 saying none do. */
async function storedSuiteReports(
  run: Record<string, any>,
  suite?: string,
): Promise<{ suiteKind: string; report: unknown }[]> {
  const reports = Array.isArray(run.reports) ? run.reports : [];
  const stored = reports.filter(
    (report: { suiteKind?: unknown; reportUrl?: unknown }) =>
      typeof report.reportUrl === "string" &&
      report.reportUrl.length > 0 &&
      (suite === undefined || report.suiteKind === suite),
  );
  if (stored.length === 0) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "This conformance run has no stored report.",
    );
  }
  return await fetchSuiteReports(stored);
}

conformanceRuns.get(
  "/projects/:projectId/conformance-runs/:runId/checks/:checkId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const suite = c.req.query("suite");
    if (
      suite !== undefined &&
      !(SUITE_KINDS as readonly string[]).includes(suite)
    ) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        `suite must be one of ${SUITE_KINDS.join(", ")}.`,
      );
    }
    const convex = createConvexClient(await getConvexBearerForRequest(c));
    const run = await loadRun(convex, runId, projectId);
    const suiteReports = await storedSuiteReports(run, suite);
    return v1Resource(
      c,
      findConformanceCheck(
        String(run.id ?? run._id ?? runId),
        suiteReports,
        c.req.param("checkId"),
        suite,
      ),
    );
  },
);

conformanceRuns.get(
  "/projects/:projectId/conformance-runs/:runId/report",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const convex = createConvexClient(await getConvexBearerForRequest(c));
    const run = await loadRun(convex, runId, projectId);
    const suiteReports = await storedSuiteReports(run);
    const cursor = c.req.query("cursor");
    return v1Resource(
      c,
      projectConformanceReports(run, suiteReports, cursor || undefined),
    );
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
  const projectId = requireProjectIdArg(
    c.req.param("projectId"),
    "v1.conformance-runs",
  );
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
    // Project-scoped list: same masked-refusal reading as the run read above.
    throw (
      redactedReadRefusalError(error, "Conformance runs not found") ??
      translateConvexError(error, { resource: "Conformance runs" })
    );
  }
  return v1PageJson(
    c,
    page.page.map((run) => toRunDto(run, projectId)),
    nextCursorFrom(page),
  );
});

export default conformanceRuns;
