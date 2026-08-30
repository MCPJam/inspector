/**
 * The chat-session chain's doorbell: the backend rings here when a session's
 * derivation inputs change, and the pass drains whatever the backend has
 * marked owed.
 *
 * WHAT THE POST PROVES. The service token proves the caller is the backend,
 * and that is the entire authorization. The body carries no selector at all —
 * deliberately. A session id in the body would look like it named the work,
 * and then someone would eventually trust it; instead the pass claims from the
 * backend's own queue, so what gets derived is decided by the backend's
 * lifecycle rather than by whatever rang the bell. A ring is a wake-up, not an
 * instruction.
 *
 * WHY IT ANSWERS BEFORE THE WORK FINISHES. The backend's push is a best-effort
 * doorbell with a short timeout, and draining a burst is a loop of backend
 * round trips. The backend's own sweep is the delivery guarantee — the pass is
 * idempotent and re-runnable — so dropping a ring costs a sweep interval, not
 * a derivation.
 *
 * NO FLAG OF ITS OWN, for the reason the production-checks worker records: a
 * second gate here would buy nothing the two existing ones do not, and would
 * cost the failure mode where the feature reads as ON while silently doing
 * nothing. Being a peer at all requires the service-token env; the feature
 * being off backend-side makes the claim route 404, which the pass reports as
 * `disabled`.
 */

import { Hono } from "hono";
import { internalServiceAuthMiddleware } from "../../middleware/internal-service-auth.js";
import { runChatSessionStagePass } from "../../services/chat-stage/chat-session-stage-pass.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

const internalChatStageDerivations = new Hono();

internalChatStageDerivations.use("*", internalServiceAuthMiddleware());

internalChatStageDerivations.post("/derivation-requested", async (c) => {
  // Deliberately not awaited. See the note above: the caller is a doorbell.
  void runChatSessionStagePass().catch((error: unknown) => {
    // The 202 has already gone out, so this is the last place a failure can be
    // seen. Nothing session-specific is recorded: everything the pass touches
    // is customer evidence.
    reportRouteFailure("Chat session stage derivation pass failed", error, {
      source: "chat-stage-derivations.derivation-requested",
      hop: "mcpjam_internal",
    });
  });

  return c.json({ ok: true, accepted: true }, 202);
});

export default internalChatStageDerivations;
