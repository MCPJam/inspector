/**
 * Public v1 eval surface: async suite runs + polling reads.
 *
 * POST creates the run (suite/case upsert + run record, all synchronous so
 * validation and quota errors surface as normal v1 errors), then DETACHES
 * execution and responds 202 with the runId. Agents poll the GET routes for
 * status, per-iteration results (tool calls, token usage, latency), and full
 * traces. Runs land in the same Convex tables the hosted UI Runs/Cases tabs
 * read, so a human can watch the run live while the agent polls.
 *
 * Reads are thin proxies over the same Convex queries the UI uses, called
 * with the request's Convex bearer (the caller's JWT, or the short-lived
 * delegated JWT minted for WorkOS API-key callers). Convex enforces
 * membership + the delegated org scope; the routes additionally cross-check
 * the resource's projectId against the path so a valid id from another
 * project reads as NOT_FOUND.
 */
import { Hono } from "hono";
import { ConvexHttpClient } from "convex/browser";
import {
  assertBearerToken,
  parseWithSchema,
  ErrorCode,
  WebRouteError,
} from "../web/errors.js";
import { createAuthorizedManager } from "../web/auth.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  RunEvalsRequestSchema,
  prepareEvalRun,
  type PreparedEvalRun,
} from "../shared/evals.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { logger } from "../../utils/logger.js";
import { v1Error, v1PageJson, v1Resource } from "./envelope.js";
import { synthesizeServerBody } from "./adapter.js";

const evals = new Hono();

// ── Request schema ───────────────────────────────────────────────────

const MAX_V1_TESTS = 100;

// Public shape: the web RunEvalsRequestSchema minus hosted-app plumbing the
// public surface must not accept (`convexAuthToken` comes from the bearer;
// chatbox/access/storage fields are hosted-client concerns).
const createEvalRunSchema = RunEvalsRequestSchema.omit({
  convexAuthToken: true,
  chatboxId: true,
  accessVersion: true,
  storageServerIds: true,
})
  .extend({
    // Inline tests are optional on the public surface: a bare `suiteId`
    // rerun is the simplest possible call.
    tests: RunEvalsRequestSchema.shape.tests.max(MAX_V1_TESTS).default([]),
  })
  .refine((body) => body.suiteId || (body.tests?.length ?? 0) > 0, {
    message: "Provide suiteId (rerun) and/or inline tests",
  });

// ── Concurrency gate ─────────────────────────────────────────────────

// Per-org cap on detached runs in THIS process. Railway runs a single
// Inspector instance today; if that changes this becomes per-instance,
// which is acceptable (the backend run/iteration quotas remain global).
const MAX_CONCURRENT_RUNS = Number(
  process.env.V1_MAX_CONCURRENT_EVAL_RUNS ?? 2
);
const activeRunsByOrg = new Map<string, number>();

function orgConcurrencyKey(c: any): string {
  return c.get("mcpjamOrganizationId") ?? c.get("workosUserId") ?? "anonymous";
}

function tryAcquireRunSlot(key: string): boolean {
  const active = activeRunsByOrg.get(key) ?? 0;
  if (active >= MAX_CONCURRENT_RUNS) {
    return false;
  }
  activeRunsByOrg.set(key, active + 1);
  return true;
}

function releaseRunSlot(key: string): void {
  const active = activeRunsByOrg.get(key) ?? 0;
  if (active <= 1) {
    activeRunsByOrg.delete(key);
  } else {
    activeRunsByOrg.set(key, active - 1);
  }
}

// ── Convex read client ───────────────────────────────────────────────

function createConvexReadClient(convexAuthToken: string): ConvexHttpClient {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration"
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(convexAuthToken);
  return client;
}

/**
 * Convex throws generic Errors from queries; the common authorization
 * failures ("not found", "unauthorized", "Not a member") all mean the same
 * thing to a v1 caller: this run/suite is not visible to you.
 */
function isConvexNotVisibleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|unauthorized|not a member/i.test(message);
}

function requireProjectMatch(
  resource: { projectId?: unknown } | null | undefined,
  projectId: string,
  what: string
): void {
  if (!resource || String(resource.projectId ?? "") !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, `${what} not found`);
  }
}

// ── DTO mapping ──────────────────────────────────────────────────────

type RunDoc = Record<string, any>;
type IterationDoc = Record<string, any>;

function toRunDto(run: RunDoc) {
  return {
    id: String(run._id),
    suiteId: String(run.suiteId),
    runNumber: run.runNumber ?? null,
    status: run.status,
    result: run.result,
    summary: run.summary ?? null,
    source: run.source ?? "ui",
    notes: run.notes ?? null,
    createdAt: run.createdAt,
    completedAt: run.completedAt ?? null,
  };
}

function toIterationDto(iteration: IterationDoc) {
  const snapshot = iteration.testCaseSnapshot ?? {};
  const startedAt =
    typeof iteration.startedAt === "number" ? iteration.startedAt : null;
  const isTerminal =
    iteration.status === "completed" ||
    iteration.status === "failed" ||
    iteration.status === "cancelled";
  const durationMs =
    isTerminal && startedAt !== null && typeof iteration.updatedAt === "number"
      ? Math.max(iteration.updatedAt - startedAt, 0)
      : null;
  return {
    id: String(iteration._id),
    testCaseId: iteration.testCaseId ? String(iteration.testCaseId) : null,
    title: snapshot.title ?? null,
    iterationNumber: iteration.iterationNumber,
    status: iteration.status,
    result: iteration.result,
    model: snapshot.model ?? null,
    provider: snapshot.provider ?? null,
    startedAt,
    durationMs,
    tokensUsed: iteration.tokensUsed ?? null,
    usage: iteration.usage ?? null,
    actualToolCalls: iteration.actualToolCalls ?? [],
    expectedToolCalls: snapshot.expectedToolCalls ?? [],
    error: iteration.error ?? null,
  };
}

// ── Routes ───────────────────────────────────────────────────────────

// POST /v1/projects/:projectId/eval-runs
// Create a suite run (existing suiteId rerun and/or inline tests) and start
// executing it in the background. Responds 202 with the runId immediately;
// poll GET /eval-runs/:runId for progress.
evals.post("/projects/:projectId/eval-runs", async (c) => {
  const projectId = c.req.param("projectId");
  const rawBody = await synthesizeServerBody(c);
  const bearerToken = assertBearerToken(c);
  const body = parseWithSchema(createEvalRunSchema, {
    ...rawBody,
    projectId,
  });

  // `suiteRerun` semantics from the web surface: don't re-upsert per-case
  // fields when rerunning a configured suite without inline tests.
  const suiteRerun =
    body.suiteRerun ?? (Boolean(body.suiteId) && body.tests.length === 0);

  const slotKey = orgConcurrencyKey(c);
  if (!tryAcquireRunSlot(slotKey)) {
    return v1Error(
      c,
      "RATE_LIMITED",
      `Too many concurrent eval runs (max ${MAX_CONCURRENT_RUNS}). Wait for an active run to finish.`,
      { reason: "CONCURRENT_RUN_LIMIT", maxConcurrentRuns: MAX_CONCURRENT_RUNS }
    );
  }

  // Manual connection lifecycle (mirrors the web stream-test-case route):
  // the manager must outlive this request — it is the background task's MCP
  // transport — so `withManager`'s request-scoped teardown can't be used.
  let released = false;
  const releaseSlotOnce = () => {
    if (!released) {
      released = true;
      releaseRunSlot(slotKey);
    }
  };

  try {
    // Resolved once, synchronously: the background task captures this token
    // in its closure (its TTL covers a capped run; see v1-convex-token.ts).
    const convexAuthToken = await getConvexBearerForRequest(c);

    const { manager } = await createAuthorizedManager(
      c,
      bearerToken,
      projectId,
      body.serverIds,
      WEB_CALL_TIMEOUT_MS,
      undefined,
      undefined,
      { serverNames: body.serverNames }
    );

    let prepared: PreparedEvalRun;
    try {
      prepared = await prepareEvalRun(manager, {
        ...body,
        projectId,
        suiteRerun,
        convexAuthToken,
        source: "api",
      });
    } catch (error) {
      await manager.disconnectAllServers().catch(() => {});
      throw error;
    }

    // Detach: the runner owns terminal run status; the catch is defense for
    // errors thrown outside its own try (provider construction, etc.).
    void prepared
      .execute()
      .catch(async (error) => {
        logger.error("[v1 evals] background eval run failed", error, {
          runId: prepared.runId,
          suiteId: prepared.suiteId,
          projectId,
        });
        await prepared.recorder
          .finalize({
            status: "failed",
            notes:
              error instanceof Error
                ? error.message.slice(0, 500)
                : String(error).slice(0, 500),
          })
          .catch(() => {});
      })
      .finally(() => {
        releaseSlotOnce();
        void manager.disconnectAllServers().catch(() => {});
      });

    return v1Resource(
      c,
      {
        runId: prepared.runId,
        suiteId: prepared.suiteId,
        status: "running",
        caseUpsert: prepared.caseUpsert,
      },
      202
    );
  } catch (error) {
    releaseSlotOnce();
    throw error;
  }
});

// GET /v1/projects/:projectId/eval-runs/:runId
// Run status + summary. Poll this until status is terminal
// (completed | failed | cancelled).
evals.get("/projects/:projectId/eval-runs/:runId", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  let run: RunDoc | null;
  try {
    run = await convex.query("testSuites:getTestSuiteRun" as any, { runId });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }
  requireProjectMatch(run, projectId, "Eval run");
  return v1Resource(c, toRunDto(run!));
});

// GET /v1/projects/:projectId/eval-runs/:runId/iterations?cursor=&limit=
// Per-iteration results: tool calls, structured token usage, latency.
evals.get("/projects/:projectId/eval-runs/:runId/iterations", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 50) || 50, 1),
    200
  );
  const cursor = c.req.query("cursor") ?? null;
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  let run: RunDoc | null;
  let page: { page: IterationDoc[]; isDone: boolean; continueCursor: string };
  try {
    run = await convex.query("testSuites:getTestSuiteRun" as any, { runId });
    requireProjectMatch(run, projectId, "Eval run");
    page = await convex.query(
      "testSuites:listTestSuiteRunIterations" as any,
      { runId, paginationOpts: { numItems: limit, cursor } }
    );
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval run not found");
    }
    throw error;
  }
  return v1PageJson(
    c,
    (page.page ?? []).map(toIterationDto),
    page.isDone ? undefined : page.continueCursor
  );
});

// GET /v1/projects/:projectId/eval-runs/:runId/iterations/:iterationId/trace
// Full trace envelope (messages + spans) for one iteration.
evals.get(
  "/projects/:projectId/eval-runs/:runId/iterations/:iterationId/trace",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const iterationId = c.req.param("iterationId");
    const convex = createConvexReadClient(await getConvexBearerForRequest(c));

    let trace: unknown;
    try {
      const [run, iteration] = await Promise.all([
        convex.query("testSuites:getTestSuiteRun" as any, { runId }),
        convex.query("testSuites:getTestIteration" as any, { iterationId }),
      ]);
      requireProjectMatch(run, projectId, "Eval run");
      if (
        !iteration ||
        String((iteration as IterationDoc).suiteRunId ?? "") !== runId
      ) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Eval iteration not found"
        );
      }
      trace = await convex.action("testSuites:getTestIterationBlob" as any, {
        iterationId,
      });
    } catch (error) {
      if (isConvexNotVisibleError(error)) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "Eval iteration not found"
        );
      }
      throw error;
    }
    if (trace === null || trace === undefined) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Trace is not available for this iteration",
        { reason: "TRACE_NOT_AVAILABLE" }
      );
    }
    return v1Resource(c, trace);
  }
);

// GET /v1/projects/:projectId/eval-suites/:suiteId/runs?limit=
// Recent runs for a suite, newest first.
evals.get("/projects/:projectId/eval-suites/:suiteId/runs", async (c) => {
  const projectId = c.req.param("projectId");
  const suiteId = c.req.param("suiteId");
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 25) || 25, 1),
    100
  );
  const convex = createConvexReadClient(await getConvexBearerForRequest(c));

  let runs: RunDoc[];
  let suite: { projectId?: unknown } | null;
  try {
    suite = await convex.query("testSuites:getTestSuite" as any, { suiteId });
    requireProjectMatch(suite, projectId, "Eval suite");
    runs = await convex.query("testSuites:listTestSuiteRuns" as any, {
      suiteId,
      limit,
    });
  } catch (error) {
    if (isConvexNotVisibleError(error)) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Eval suite not found");
    }
    throw error;
  }
  return v1PageJson(c, (runs ?? []).map(toRunDto));
});

export default evals;
