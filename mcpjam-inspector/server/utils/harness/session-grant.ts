/**
 * The box grant a turn needs when its MCP config carries the lane's session
 * envelopes.
 *
 * An envelope is the same on every turn of the lane and readable inside the
 * box, so on its own it would let a copy reach the lane's servers from
 * anywhere, during any later turn. The backend therefore has this turn's box
 * egress inject a session grant (`x-mcpjam-session-grant`) on the forwarding
 * host, which nothing in the box can read, and the signed proxy hands that
 * grant back with every request (`/internal/harness/session-turn`). The grant
 * is a forwarding-only lease row: renewed by the box reservation's heartbeat
 * and revoked with `/web/harness/model-broker/revoke` at turn end.
 */
import { z } from "zod";
import { inspectorAiRequestHeaders } from "../ai-request-headers.js";
import { logger } from "../logger.js";
import { bearerHeader, getConvexHttpUrl } from "./harness-broker-http.js";
import {
  boxRequestFields,
  revokeHarnessModelBroker,
  type HarnessBrokerBox,
} from "./harness-model-broker.js";
import type { HarnessId } from "./registry.js";

/** The header the box's egress adds; the signed proxy reads it, never the box. */
export const SESSION_GRANT_HEADER = "x-mcpjam-session-grant";

const started = z.object({
  ok: z.literal(true),
  runId: z.string().min(1),
  expiresAt: z.number().finite(),
  delivery: z.literal("e2b-network-transform"),
  grantOrigin: z.string().url(),
});
const refused = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
});
const UNAVAILABLE =
  "Couldn't connect this turn to its MCP servers. Send your message again.";

/** An answer that is not JSON is as unusable as a refusal. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export type HarnessSessionGrantResult =
  | { ok: true; expiresAt: number; origin: string }
  | { ok: false; status: number; error: string; code?: string };

export async function startHarnessSessionGrant(args: {
  box: HarnessBrokerBox;
  harnessId: HarnessId;
  modelId: string;
  /** The box reservation's run id, which teardown revokes. */
  runId: string;
  laneId: string;
  leaseId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<HarnessSessionGrantResult> {
  let response: Response;
  try {
    response = await fetch(
      new URL("/web/harness/session-grant/start", getConvexHttpUrl()),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...inspectorAiRequestHeaders("harness"),
          authorization: bearerHeader(args.bearer),
        },
        body: JSON.stringify({
          ...boxRequestFields(args.box),
          harnessId: args.harnessId,
          modelId: args.modelId,
          runId: args.runId,
          sessionGrant: { harnessSessionId: args.laneId, leaseId: args.leaseId },
        }),
        signal: args.signal,
      },
    );
  } catch (error) {
    logger.warn("[harness] session grant start failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, status: 502, error: UNAVAILABLE };
  }
  const payload = await readJson(response);
  const grant = response.ok ? started.safeParse(payload) : undefined;
  if (grant?.success && grant.data.runId === args.runId)
    return {
      ok: true,
      expiresAt: grant.data.expiresAt,
      origin: new URL(grant.data.grantOrigin).origin,
    };
  // An answer this turn cannot read may still have installed a grant.
  if (response.ok)
    await revokeHarnessModelBroker({
      runId: args.runId,
      ...(args.box.kind === "computer" ? { projectId: args.box.projectId } : {}),
      bearer: args.bearer,
    });
  const reason = refused.safeParse(payload);
  return {
    ok: false,
    status: response.ok ? 502 : response.status,
    error: (reason.success && reason.data.error) || UNAVAILABLE,
    ...(!response.ok && reason.success && reason.data.code
      ? { code: reason.data.code }
      : {}),
  };
}
