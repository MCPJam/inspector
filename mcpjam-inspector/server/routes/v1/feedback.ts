/**
 * Public v1 feedback: `POST /v1/feedback`, the `send_feedback` operation.
 *
 * A signed-in caller tells the MCPJam team about MCPJam itself — a bug, a
 * missing capability, something confusing — at the moment it hits the problem.
 * The MCP tool and the CLI both land here; the app's own form calls the same
 * Convex mutation directly, which is why every cap is enforced there and the
 * schema below only turns the obvious mistakes into a 400 before the round
 * trip.
 *
 * THE TEXT GOES TO THE MCPJAM TEAM, outside the caller's organization, and is
 * kept for 180 days. It is stored in MCPJam's own database and nowhere public.
 *
 * A 201 means the report is STORED. Notifying the team happens afterwards, on
 * its own retries, and cannot turn an accepted report into an error.
 *
 * Guest-DENIED (not on `guest-allowed-paths.ts`): feedback needs an account.
 */
import { Hono } from "hono";
import { z } from "zod";
import { parseWithSchema } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { readIdempotencyKeyStrict } from "../../utils/idempotency.js";
import { readLaunchContext } from "../../utils/launch-context.js";
import { v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { readJsonObjectBody } from "./adapter.js";
import { createConvexClient } from "./convex-client.js";

const feedback = new Hono();

// Mirrors the backend's caps (mcpjam-backend `lib/platformFeedback.ts`), which
// stay authoritative; trimmed first there too, so the two agree on a value
// that only exceeds a cap by its surrounding whitespace.
const sendFeedbackSchema = z.strictObject({
  kind: z.enum(["bug", "missing_capability", "confusing", "docs", "other"]),
  summary: z.string().trim().min(1).max(200),
  details: z.string().trim().max(8000).optional(),
  operation: z.string().trim().max(120).optional(),
  requestId: z.string().trim().max(128).optional(),
  errorCode: z.string().trim().max(64).optional(),
  projectId: z.string().trim().min(1).optional(),
});

type FeedbackReceiptRow = {
  id: string;
  receivedAt: number;
  duplicate: boolean;
};

feedback.post("/feedback", async (c) => {
  const body = parseWithSchema(sendFeedbackSchema, await readJsonObjectBody(c));
  // Strict, unlike most write routes: a key that is present but unusable is a
  // 400, never silently dropped, because the key is what stops a retried
  // report from being filed twice.
  const idempotencyKey = readIdempotencyKeyStrict(c);
  // DECLARED, and stored as such. The verified channel is the attribution the
  // backend reads off the delegated token, never this header.
  const launcher = readLaunchContext(c)?.launcher;

  const convex = createConvexClient(await getConvexBearerForRequest(c));
  let receipt: FeedbackReceiptRow;
  try {
    receipt = (await convex.mutation(
      "platformFeedback:submit" as any,
      {
        kind: body.kind,
        summary: body.summary,
        ...(body.details ? { details: body.details } : {}),
        ...(body.operation ? { operation: body.operation } : {}),
        ...(body.requestId ? { requestId: body.requestId } : {}),
        ...(body.errorCode ? { errorCode: body.errorCode } : {}),
        ...(body.projectId ? { projectId: body.projectId } : {}),
        source: "api",
        ...(launcher ? { launcher } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as any
    )) as FeedbackReceiptRow;
  } catch (error) {
    throw translateConvexWriteError(error, {
      resource: "Feedback",
      notFoundMessage: "Project not found",
      conflictMessage:
        "This idempotency key was already used for different feedback. Use a new key for a new report.",
      fallbackMessage: "Feedback rejected",
    });
  }

  return v1Resource(
    c,
    {
      id: String(receipt.id),
      receivedAt: receipt.receivedAt,
      duplicate: receipt.duplicate,
    },
    201
  );
});

export default feedback;
