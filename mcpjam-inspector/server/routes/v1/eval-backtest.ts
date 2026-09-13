import { Hono } from "hono";
import { ConvexHttpClient } from "convex/browser";
import { evalBacktestDraftSchema } from "../../../../sdk/src/contract/eval-backtest.js";
import { runAssertionBacktest } from "../../services/evals/assertion-backtest.js";
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
  const parsed = evalBacktestDraftSchema.safeParse(value);
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
  try {
    const run = (await client.query(
      "testSuites:getTestSuiteRun" as never,
      { runId: c.req.param("runId") } as never,
    )) as { projectId?: string; suiteId?: string } | null;
    if (!run || run.projectId !== c.req.param("projectId") || !run.suiteId)
      return v1Error(c, "NOT_FOUND", "Eval run not found");
    const report = await runAssertionBacktest({
      runId: c.req.param("runId"),
      suiteId: run.suiteId,
      draft: parsed.data,
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
    if (message.includes("EVAL_JUDGE_BACKTEST_COOLDOWN"))
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
    });
  }
});
export default router;
