/**
 * Hosted MRTR continuation resume/cancel routes (MCP 2026-07-28 §12.5).
 *
 * A modern `input_required` operation suspended to the durable Convex store
 * (PR3a) is resumed here on a FRESH authenticated request after the human
 * answers — the original worker and its `AbortSignal` are long gone. The
 * browser holds only the opaque `continuationId`; everything else (the encoded
 * `MrtrOperationState`, the `requestState`, the round) is claimed back from the
 * store.
 *
 * This is the **thin direct-resume path**: it builds a fresh authorized manager
 * for the bound server, computes the same binding fingerprint the suspend site
 * used (a changed effective server / principal fails the claim closed at the
 * backend), and drives exactly one retry leg through the reusable
 * {@link resumeMrtrContinuationLeg} primitive. The full chat/agent-loop splice
 * (re-entering the transcript, resuming the model turn) is PR5; PR3b delivers
 * the primitive + this isolated resume so the transport is testable end to end
 * without the engine.
 */
import { Hono } from "hono";
import { z } from "zod";
import type {
  InputResponses,
  MrtrOperationState,
  MrtrLegResult,
} from "@mcpjam/sdk";
import { resumeInputRequiredOperation } from "@mcpjam/sdk";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  readJsonBody,
} from "./errors.js";
import {
  createManualHostedConnection,
  handleRoute,
  projectServerSchema,
} from "./auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  WEB_CALL_TIMEOUT_MS,
  MRTR_RESPONSE_CONTENT_MAX_BYTES,
} from "../../config.js";
import {
  computeMrtrBindingFingerprint,
  deriveServerConfigDigest,
  resolveMrtrAuthPrincipal,
  resumeMrtrContinuationLeg,
  settleMrtrTeardown,
} from "../../utils/mrtr-hosted-collector.js";
import {
  cancelContinuation,
  redactContinuationForLog,
} from "../../utils/mrtr-continuation-state.js";
import { logger } from "../../utils/logger.js";
import {
  isMrtrResumeSubmission,
  type MrtrResumeSubmission,
} from "@/shared/mrtr-continuation";

const mrtrContinuation = new Hono();

const elicitationResponseSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.unknown()).optional(),
});

const resumeSchema = projectServerSchema.extend({
  continuationId: z.string().min(1),
  round: z.number().int().nonnegative(),
  responses: z.record(z.string(), elicitationResponseSchema),
  /** The protocol era the continuation was bound to (part of the fingerprint). */
  negotiatedEra: z.string().min(1),
  chatSessionId: z.string().min(1).optional(),
  oauthTokens: z.record(z.string(), z.string()).optional(),
});

/**
 * Collapse the per-server `oauthTokens` map onto the single-server
 * `oauthAccessToken` this route actually connects with.
 *
 * A continuation is bound to exactly ONE server, so the resume body carries
 * `serverId` (not `serverIds`) — and `resolveConnectionParams` therefore takes
 * its single-server branch, which reads only `oauthAccessToken` and drops
 * `oauthTokens` on the floor. Hosted chat holds the per-server map, so a caller
 * that sends it would have had its token silently discarded: the fresh resume
 * connection then fails OAuth-required before the continuation could be claimed,
 * stranding the suspended operation until it expired. Declaring a field the
 * route ignores is the bug; honor it here rather than accept it and drop it.
 *
 * An explicit `oauthAccessToken` wins — it is the more specific field.
 */
function normalizeResumeOAuth(
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof rawBody.oauthAccessToken === "string") return rawBody;
  const serverId = rawBody.serverId;
  const tokens = rawBody.oauthTokens;
  if (typeof serverId !== "string" || tokens === null || typeof tokens !== "object") {
    return rawBody;
  }
  const token = (tokens as Record<string, unknown>)[serverId];
  if (typeof token !== "string" || !token) return rawBody;
  return { ...rawBody, oauthAccessToken: token };
}

/**
 * POST /mrtr/resume  (mounted: `web.route("/mrtr", …)` → `/api/web/mrtr/resume`)
 *
 * Not to be confused with the FROZEN Convex-side `/web/mrtr/continuation/*`
 * contract this calls out to — that is the backend store, not this route.
 *
 * Claim the record, idempotently submit the browser's response, and drive one
 * retry leg. Returns the resume outcome (completed result, another
 * `input_required` round, or a terminal failure/indeterminate).
 */
mrtrContinuation.post("/resume", async (c) =>
  handleRoute(c, async () => {
    const rawBody = await readJsonBody<Record<string, unknown>>(c);

    // Shape-gate the browser submission BEFORE connecting, so a malformed or
    // oversized payload never costs a server connect. This gate runs on the raw
    // body; the value that actually reaches the store and the wire is the
    // Zod-parsed `body.responses` below, which additionally strips unknown keys.
    // (The raw cap is a superset of the parsed one, so passing here implies
    // passing there.)
    const submissionCandidate = {
      continuationId: rawBody.continuationId,
      round: rawBody.round,
      responses: rawBody.responses,
    };
    if (!isMrtrResumeSubmission(submissionCandidate)) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Malformed MRTR resume submission",
      );
    }

    // Per-response content cap: the global body limit only bounds the whole
    // request, so a single `content` between the per-response bound and 1 MiB
    // would otherwise be stored and forwarded to the MCP server. Reject
    // oversized content here (never truncate — a truncated response would drive
    // a different request) before it reaches the store.
    for (const [key, response] of Object.entries(
      submissionCandidate.responses,
    )) {
      if (response.content === undefined) continue;
      const bytes = Buffer.byteLength(
        JSON.stringify(response.content),
        "utf8",
      );
      if (bytes > MRTR_RESPONSE_CONTENT_MAX_BYTES) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          `Response content for "${key}" is ${bytes} bytes, over the ${MRTR_RESPONSE_CONTENT_MAX_BYTES}-byte per-response cap`,
        );
      }
    }

    const bearer = await getConvexBearerForRequest(c);
    const { manager, body } = await createManualHostedConnection(
      c,
      normalizeResumeOAuth(rawBody),
      resumeSchema,
      { timeoutMs: WEB_CALL_TIMEOUT_MS },
    );

    try {
      const serverId = body.serverId;
      const submission: MrtrResumeSubmission = {
        continuationId: body.continuationId,
        round: body.round,
        // The Zod-normalized values, NOT the raw ones that merely passed the
        // structural predicate above: `elicitationResponseSchema` strips keys
        // the contract does not declare, and it must be that narrowed shape
        // that reaches the store and the MCP server.
        responses: body.responses,
      };

      // Warm the connection so the client exists AND its negotiated identity is
      // available for the fingerprint. `ping` is deliberately capability-NEUTRAL:
      // this route resumes all three MRTR verbs, so probing with `listTools`
      // would fail a prompt-only or resource-only server that never advertised
      // `tools` — before the continuation was even claimed. `ping` is also not
      // an MRTR verb, so it can never itself return `input_required`.
      //
      // The timeout is explicit for the same reason as `driveLeg` below, and it
      // is NOT inherited here even though the manager was built with one:
      // `listTools` applies `withTimeout` inside its own callback, but
      // `pingServer` forwards its options straight to `client.ping`, so an
      // unbounded probe would sit on the upstream SDK default while a connected
      // server stops answering.
      await manager.pingServer(serverId, { timeout: WEB_CALL_TIMEOUT_MS });
      const client = manager.getManagedClient(serverId);
      if (!client) {
        throw new WebRouteError(
          502,
          ErrorCode.INTERNAL_ERROR,
          `MCP server "${serverId}" did not connect for resume`,
        );
      }

      // The auth-principal half of the binding must differentiate signed-in
      // principals, and must resolve IDENTICALLY at the suspend site — hence the
      // shared helper rather than a second hand-rolled lookup here.
      const authPrincipal = resolveMrtrAuthPrincipal(c);
      const bindingFingerprint = computeMrtrBindingFingerprint({
        serverId,
        negotiatedEra: body.negotiatedEra,
        serverConfigDigest: deriveServerConfigDigest(manager, serverId),
        authPrincipal,
      });

      const driveLeg = (
        state: MrtrOperationState,
        responses: InputResponses,
      ): Promise<MrtrLegResult<unknown>> =>
        // The timeout is EXPLICIT, not inherited. This drives the managed client
        // directly rather than through a manager verb, so the manager's
        // `withTimeout` injection does not apply and the leg would otherwise
        // fall back to the upstream SDK's own default. That would break the
        // lease budget `MRTR_CONTINUATION_LEASE_TTL_MS` is derived from — a leg
        // outrunning the budget can lose its lease after the wire has left.
        resumeInputRequiredOperation(client, state, responses, {
          requestOptions: { timeout: WEB_CALL_TIMEOUT_MS },
        });

      const outcome = await resumeMrtrContinuationLeg({
        bearer,
        submission,
        bindingFingerprint,
        driveLeg,
        ...(body.serverName ? { serverName: body.serverName } : {}),
      });

      // Never surface the raw result of a completed side-effecting op verbatim
      // here — the transcript splice (PR5) owns that. The direct path reports
      // the outcome shape + a bounded result for local/testing surfaces.
      return { ok: true, ...outcome };
    } finally {
      // Teardown is CLEANUP, never the outcome. This `finally` runs AFTER a leg
      // has already gone out and the store has been written, so a teardown that
      // fails OR hangs must not replace (or indefinitely withhold) a real resume
      // outcome — a `completed` result, or an `indeterminate` the user has to be
      // told about. See `settleMrtrTeardown`.
      await settleMrtrTeardown(
        () => manager.disconnectAllServers(),
        "[mrtr-continuation]",
      );
    }
  }),
);

/**
 * POST /mrtr/cancel  (mounted: `web.route("/mrtr", …)` → `/api/web/mrtr/cancel`)
 *
 * Durable cancel: the original `AbortSignal` no longer exists after suspension,
 * so a user closing the dialog must be able to withdraw the continuation from a
 * fresh request. Ownership is enforced backend-side from the bearer; a
 * non-owner sees the same not-found as a missing row.
 */
mrtrContinuation.post("/cancel", async (c) =>
  handleRoute(c, async () => {
    assertBearerToken(c);
    const bearer = await getConvexBearerForRequest(c);
    const body = await readJsonBody<{ continuationId?: unknown; reason?: unknown }>(
      c,
    );
    if (typeof body.continuationId !== "string" || !body.continuationId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "continuationId is required",
      );
    }
    const res = await cancelContinuation(bearer, {
      continuationId: body.continuationId,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    });
    if (!res.ok) {
      logger.warn("[mrtr-continuation] cancel failed", {
        error: res.error,
        ...redactContinuationForLog({ continuationId: body.continuationId }),
      });
      throw new WebRouteError(
        res.status,
        res.status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.INTERNAL_ERROR,
        res.error,
      );
    }
    return { ok: true, continuationStatus: res.status };
  }),
);

export default mrtrContinuation;
