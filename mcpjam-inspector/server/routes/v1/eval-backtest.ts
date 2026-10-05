import { judgeBacktestRequestSchema } from "../../../../sdk/src/contract/judge-backtest.js";
import { Hono } from "hono";
import { ConvexHttpClient } from "convex/browser";
import {
  evalBacktestRequestSchema,
  evalRegradeRequestSchema,
} from "../../../../sdk/src/contract/eval-backtest.js";
import { runAssertionBacktest } from "../../services/evals/assertion-backtest.js";
import {
  runRegrade,
  type RegradeApplyResponse,
  type RegradeEvidencePage,
} from "../../services/evals/regrade-run.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1Error, v1Resource } from "./envelope.js";
import { translateConvexReadError } from "./convex-read-errors.js";

const router = new Hono();
router.post("/projects/:projectId/eval-runs/:runId/backtest", async (c) => {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > 128 * 1024)
    return v1Error(c, "VALIDATION_ERROR", "Backtest draft exceeds 128 KiB");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return v1Error(c, "VALIDATION_ERROR", "Backtest draft must be JSON");
  }
  const parsed = evalBacktestRequestSchema.safeParse(value);
  if (!parsed.success)
    return v1Error(
      c,
      "VALIDATION_ERROR",
      "Invalid backtest draft; supply an explicit assertions mode and list",
    );
  const token = await getConvexBearerForRequest(c);
  if (!process.env.CONVEX_URL)
    return v1Error(c, "INTERNAL_ERROR", "Backtest service is unavailable");
  const client = new ConvexHttpClient(process.env.CONVEX_URL);
  client.setAuth(token);
  let scopeVerified = false;
  try {
    const run = (await client.query(
      "testSuites:getTestSuiteRun" as never,
      { runId: c.req.param("runId") } as never,
    )) as { projectId?: string; suiteId?: string } | null;
    if (!run || run.projectId !== c.req.param("projectId") || !run.suiteId)
      return v1Error(c, "NOT_FOUND", "Eval run not found");
    scopeVerified = true;
    const report = await runAssertionBacktest({
      runId: c.req.param("runId"),
      suiteId: run.suiteId,
      draft: {
        assertions: parsed.data.assertions,
        ...(parsed.data.matchOptions !== undefined
          ? { matchOptions: parsed.data.matchOptions }
          : {}),
      },
      continuation: parsed.data.continuation,
      signal: c.req.raw.signal,
      readPage: (args) =>
        client.action(
          "goalCompletionAction:readBacktestEvidence" as never,
          args as never,
        ),
    });
    return v1Resource(c, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const data =
      error && typeof error === "object" && "data" in error
        ? error.data
        : undefined;
    const code =
      data && typeof data === "object" && "code" in data
        ? data.code
        : undefined;
    if (code === "CONFLICT")
      return v1Error(
        c,
        "CONFLICT",
        "The source run or preview reservation changed; start a new preview",
      );
    if (code === "TIMEOUT")
      return v1Error(c, "TIMEOUT", "The preview exceeded its deadline");
    if (code === "VALIDATION_ERROR")
      return v1Error(c, "VALIDATION_ERROR", "Invalid backtest request");
    if (code === "NOT_FOUND")
      return v1Error(
        c,
        "NOT_FOUND",
        "Eval run not found or preview is not authorized",
      );
    if (
      code === "EVAL_BACKTEST_COOLDOWN" ||
      message.includes("EVAL_BACKTEST_COOLDOWN")
    )
      return v1Error(
        c,
        "RATE_LIMITED",
        "Wait one minute before another backtest",
        undefined,
        { "Retry-After": "60" },
      );
    if (message.includes("EVAL_RUN_NOT_TERMINAL"))
      return v1Error(
        c,
        "CONFLICT",
        "Backtest requires a terminal run; grading runs are not ready",
      );
    if (message.includes("EVAL_BACKTEST_SOURCE_CHANGED"))
      return v1Error(c, "CONFLICT", "Source run changed; start a new preview");
    if (
      message.includes("Backtest deadline") ||
      message.includes("Backtest cancelled")
    )
      return v1Error(
        c,
        "TIMEOUT",
        "Backtest did not complete within its deadline",
      );
    throw translateConvexReadError(error, {
      scope: "v1.eval-backtest",
      notFoundMessage: "Eval run not found or backtest is not authorized",
      // Only the initial run lookup can be a masked scope refusal.
      redactedIsRefusal: !scopeVerified,
    });
  }
});
router.post(
  "/projects/:projectId/eval-runs/:runId/judge/backtest",
  async (c) => {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 128 * 1024)
      return v1Error(c, "VALIDATION_ERROR", "Backtest draft exceeds 128 KiB");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return v1Error(c, "VALIDATION_ERROR", "Backtest draft must be JSON");
    }
    const parsed = judgeBacktestRequestSchema.safeParse(body);
    if (!parsed.success)
      return v1Error(
        c,
        "VALIDATION_ERROR",
        "Supply a rubric with grading instructions or criteria, or null for objective-only grading.",
      );
    if (!process.env.CONVEX_URL)
      return v1Error(c, "INTERNAL_ERROR", "Backtest service is unavailable");
    const client = new ConvexHttpClient(process.env.CONVEX_URL);
    client.setAuth(await getConvexBearerForRequest(c));
    let scopeVerified = false;
    try {
      const run = (await client.query(
        "testSuites:getTestSuiteRun" as never,
        { runId: c.req.param("runId") } as never,
      )) as { projectId?: string; suiteId?: string } | null;
      if (!run || run.projectId !== c.req.param("projectId") || !run.suiteId)
        return v1Error(c, "NOT_FOUND", "Eval run not found");
      scopeVerified = true;
      const report = await client.action(
        "goalCompletionAction:requestJudgeBacktest" as never,
        {
          suiteId: run.suiteId,
          runId: c.req.param("runId"),
          judgeRubricDraft: parsed.data.rubric,
          ...parsed.data.continuation,
        } as never,
      );
      return v1Resource(c, report);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("EVAL_JUDGE_BACKTEST_COOLDOWN"))
        return v1Error(
          c,
          "RATE_LIMITED",
          "Wait one minute before starting another judge backtest",
          undefined,
          { "Retry-After": "60" },
        );
      throw translateConvexReadError(error, {
        scope: "v1.eval-judge-backtest",
        notFoundMessage:
          "Eval run not found or judge backtest is not authorized",
        // Only the initial run lookup can be a masked scope refusal.
        redactedIsRefusal: !scopeVerified,
      });
    }
  },
);
/**
 * Persisted re-grade from stored traces. The inspector grades (the backend
 * cannot evaluate a predicate); the backend persists under a per-iteration
 * revision guard and re-decides the run. No model calls, no fee. `dryRun`
 * returns the same report without writing.
 */
router.post("/projects/:projectId/eval-runs/:runId/regrade", async (c) => {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > 128 * 1024)
    return v1Error(c, "VALIDATION_ERROR", "Re-grade request exceeds 128 KiB");
  let value: unknown = {};
  if (raw.trim()) {
    try {
      value = JSON.parse(raw);
    } catch {
      return v1Error(c, "VALIDATION_ERROR", "Re-grade request must be JSON");
    }
  }
  const parsed = evalRegradeRequestSchema.safeParse(value);
  if (!parsed.success)
    return v1Error(
      c,
      "VALIDATION_ERROR",
      "Invalid re-grade request; supply an optional assertions mode and list, and an optional dryRun",
    );
  const token = await getConvexBearerForRequest(c);
  if (!process.env.CONVEX_URL)
    return v1Error(c, "INTERNAL_ERROR", "Re-grade service is unavailable");
  const client = new ConvexHttpClient(process.env.CONVEX_URL);
  client.setAuth(token);
  let scopeVerified = false;
  try {
    const run = (await client.query(
      "testSuites:getTestSuiteRun" as never,
      { runId: c.req.param("runId") } as never,
    )) as { projectId?: string; suiteId?: string } | null;
    if (!run || run.projectId !== c.req.param("projectId") || !run.suiteId)
      return v1Error(c, "NOT_FOUND", "Eval run not found");
    scopeVerified = true;
    const report = await runRegrade({
      runId: c.req.param("runId"),
      suiteId: run.suiteId,
      // Absent ⇒ the frozen rules, re-graded by today's evaluators.
      draft: {
        assertions: parsed.data.assertions ?? { mode: "inherit", list: [] },
      },
      dryRun: parsed.data.dryRun === true,
      signal: c.req.raw.signal,
      readPage: (args) =>
        client.action(
          "evalRegrade:readRegradeEvidence" as never,
          args as never,
        ) as Promise<RegradeEvidencePage>,
      applyBatch: (args) =>
        client.mutation(
          "evalRegrade:applyRunRegrade" as never,
          args as never,
        ) as Promise<RegradeApplyResponse>,
    });
    return v1Resource(c, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const data =
      error && typeof error === "object" && "data" in error
        ? error.data
        : undefined;
    const code =
      data && typeof data === "object" && "code" in data
        ? data.code
        : undefined;
    const detail =
      data && typeof data === "object" && "message" in data
        ? String(data.message)
        : message;
    if (detail.includes("EVAL_REGRADE_STALE"))
      return v1Error(
        c,
        "CONFLICT",
        "An iteration changed while it was being re-graded; run the re-grade again",
      );
    if (detail.includes("EVAL_RUN_NOT_REGRADABLE"))
      return v1Error(
        c,
        "CONFLICT",
        "Re-grade requires a completed run that was not SDK-reported",
      );
    if (code === "CONFLICT")
      return v1Error(c, "CONFLICT", "The run changed; run the re-grade again");
    if (code === "VALIDATION_ERROR")
      return v1Error(c, "VALIDATION_ERROR", "Invalid re-grade request");
    if (code === "NOT_FOUND")
      return v1Error(
        c,
        "NOT_FOUND",
        "Eval run not found or re-grade is not authorized",
      );
    if (message.includes("EVAL_REGRADE_TOO_LARGE"))
      return v1Error(
        c,
        "VALIDATION_ERROR",
        "The run has too many iterations to re-grade in one request",
      );
    if (
      message.includes("Re-grade deadline") ||
      message.includes("Re-grade cancelled")
    )
      return v1Error(
        c,
        "TIMEOUT",
        "Re-grade did not complete within its deadline",
      );
    throw translateConvexReadError(error, {
      scope: "v1.eval-regrade",
      notFoundMessage: "Eval run not found or re-grade is not authorized",
      // Only the initial run lookup can be a masked scope refusal.
      redactedIsRefusal: !scopeVerified,
    });
  }
});
export default router;
