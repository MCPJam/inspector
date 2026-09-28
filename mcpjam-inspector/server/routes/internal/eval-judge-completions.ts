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
 * The pass owns the mode check. Even at env off it must read the saved job
 * ids and acknowledge no-op fanouts; bypassing it here leaves runs pending
 * until the recovery sweep gives up. Stage derivation still obeys the mode.
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
