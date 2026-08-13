/**
 * The backend's doorbell.
 *
 * The backend owns the connection-request state machine but cannot do the
 * network work — reaching a user-supplied MCP URL belongs behind this server's
 * pinned egress, not inside a Convex action. So when a request needs a step,
 * the backend POSTs the request id here and this runs it.
 *
 * WHAT THE POST PROVES, AND WHAT IT DOES NOT. The service token proves the
 * caller is the backend; that is the entire authorization. The request id in
 * the body is a SELECTOR, naming which row to work on — it is printed in MCP
 * tool output and carried in Discord button payloads, so it proves nothing and
 * is never treated as permission. This mirrors the rule stated on
 * `internalServiceAuthMiddleware`, which is finally mounted here.
 *
 * WHY IT ANSWERS BEFORE THE WORK FINISHES. Discovery and validation each take
 * seconds against a third-party server, and the backend's push is a
 * best-effort doorbell with a five-second timeout: holding it open would make
 * the backend's action wait on a network call it does not care about, and a
 * timeout there would look like a failure when the work was actually running
 * fine. The request's own `nextAttemptAt` and the backend's re-dispatch cron
 * are what make delivery reliable, so dropping a ping costs a minute, not a
 * request.
 */

import { Hono } from "hono";
import { internalServiceAuthMiddleware } from "../../middleware/internal-service-auth.js";
import { runConnectionJob } from "../../services/server-connection-worker.js";

const internalServerConnections = new Hono();

internalServerConnections.use("*", internalServiceAuthMiddleware());

internalServerConnections.post("/dispatch", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    requestId?: unknown;
  } | null;
  const requestId =
    typeof body?.requestId === "string" && body.requestId
      ? body.requestId
      : null;

  if (!requestId) {
    return c.json({ ok: false, error: "requestId is required" }, 400);
  }

  // Deliberately not awaited. See the note above: the caller is a doorbell.
  void runConnectionJob(requestId).catch((error: unknown) => {
    // Nothing upstream is listening by now, so this is the last place the
    // failure can be seen. The request id is safe to log; nothing else from the
    // job is, which is why only this is logged.
    console.error(
      "[server-connections] job failed",
      JSON.stringify({
        requestId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  });

  return c.json({ ok: true, accepted: true }, 202);
});

export default internalServerConnections;
