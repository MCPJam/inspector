/**
 * Cross-surface checks — Hono route (Layer B).
 *
 * Single endpoint `POST /web/checks/run-predicates` that runs an arbitrary
 * predicate set against a stored `chatSessions` transcript. Sits alongside
 * `evals` as a second caller of the SDK predicate library — eval grades a
 * live test iteration, this grades a persisted chat session on demand.
 *
 * Auth shape mirrors `evals.ts` trace-repair endpoints:
 *   - Bearer token extracted via `assertBearerToken` (request envelope).
 *   - `createConvexClient(token)` for forwarding to Convex.
 *   - Body parsed against a Zod schema via `parseWithSchema`.
 *   - Errors mapped via `mapRuntimeError` -> `webError` in the parent
 *     `web/index.ts` `onError` hook.
 */

import { Hono } from "hono";
import { z } from "zod";
import { predicateArraySchema } from "@/shared/eval-matching";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import {
  runPredicatesOnChatSession,
  type ChatSessionId,
  type UserId,
} from "../../services/checks/run-predicates-on-chat-session.js";
import { handleRoute, parseWithSchema, readJsonBody } from "./auth.js";
import { assertBearerToken } from "./errors.js";

const checks = new Hono();

const runPredicatesSchema = z.object({
  chatSessionId: z.string().min(1),
  predicates: predicateArraySchema,
  setKind: z.enum(["suite_defaults", "case_resolved", "ad_hoc"]),
  setRef: z.string().min(1).optional(),
  setVersion: z.number().int().nonnegative().optional(),
  // `triggeredBy` is optional at this surface; the backend already knows
  // the caller from the Convex auth token. Accepted for parity with the
  // orchestrator signature, in case a future flow (e.g. background job)
  // wants to attribute to a different user than the request bearer.
  triggeredBy: z.string().min(1).optional(),
});

checks.post("/run-predicates", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(runPredicatesSchema, await readJsonBody(c));
    const convexClient = createConvexClient(bearerToken);
    const result = await runPredicatesOnChatSession({
      convexClient,
      authHeader: `Bearer ${bearerToken}`,
      chatSessionId: body.chatSessionId as ChatSessionId,
      predicates: body.predicates,
      setKind: body.setKind,
      ...(body.setRef !== undefined ? { setRef: body.setRef } : {}),
      ...(body.setVersion !== undefined ? { setVersion: body.setVersion } : {}),
      ...(body.triggeredBy !== undefined
        ? { triggeredBy: body.triggeredBy as UserId }
        : {}),
    });
    return {
      checkRunId: result.checkRunId,
      results: result.results,
    };
  }),
);

export default checks;
