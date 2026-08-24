/**
 * The judge's doorbell: the backend rings here when a run's goal-completion
 * grades are saved, and the second derivation pass re-derives that run's stage
 * rows with the judge's verdict as tier-2 evidence.
 *
 * WHAT THE POST PROVES. The service token proves the caller is the backend, and
 * that is the entire authorization. The `runId` in the body is a SELECTOR
 * naming which run to grade, never permission; the pass reads the run's own
 * snapshot to decide what it is allowed to do.
 *
 * THE MODE CHECK IS THIS ROUTE'S JOB, NOT THE FLAG'S. W2's `saveGoalCompletion`
 * rings this doorbell on EVERY judge save, unconditionally — it does not
 * consult the grading-engine mode. So from the moment this route exists it is
 * called on every judged run whatever the flag says, and "ships at off" is only
 * true because the pass re-resolves the mode itself and returns a benign
 * completion at `off` and at `shadow` (the second pass writes only in
 * `dual_write`; a shadow row is produced in-process by the first pass, so a
 * second-pass write could not be a shadow of anything). That is the third belt,
 * alongside the env kill switch and the org/suite flag, and it is not optional.
 *
 * WHY IT ANSWERS BEFORE THE WORK FINISHES. The backend's push is a best-effort
 * doorbell with a short timeout, and grading a run is a loop of backend writes.
 * The fanout's pending sweep is what makes delivery reliable — the pass is
 * idempotent and re-runnable — so dropping a ping costs a sweep interval, not a
 * derivation.
 */

import { Hono } from "hono";
import { internalServiceAuthMiddleware } from "../../middleware/internal-service-auth.js";
import { runJudgeSecondPass } from "../../services/evals/judge-second-pass.js";
import { resolveGradingEngineMode } from "../../services/evals/grading-mode.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

const internalEvalJudgeCompletions = new Hono();

internalEvalJudgeCompletions.use("*", internalServiceAuthMiddleware());

internalEvalJudgeCompletions.post("/judge-completed", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    runId?: unknown;
  } | null;
  const runId =
    typeof body?.runId === "string" && body.runId ? body.runId : null;

  if (!runId) {
    return c.json({ ok: false, error: "runId is required" }, 400);
  }

  // The env kill switch, checked before anything is scheduled. At `off` this
  // route costs one JSON parse and touches no backend at all.
  if (resolveGradingEngineMode() === "off") {
    return c.json({ ok: true, accepted: false, mode: "off" }, 200);
  }

  // Deliberately not awaited. See the note above: the caller is a doorbell.
  void runJudgeSecondPass(runId).catch((error: unknown) => {
    // The 202 has already gone out, so this is the last place the failure can
    // be seen. Only the run id is safe to record: everything else in the pass
    // is customer evidence.
    reportRouteFailure("Judge second pass failed", error, {
      source: "eval-judge-completions.judge-completed",
      hop: "mcpjam_internal",
      context: { runId },
    });
  });

  return c.json({ ok: true, accepted: true }, 202);
});

export default internalEvalJudgeCompletions;
