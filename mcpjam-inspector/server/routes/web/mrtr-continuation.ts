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
import { createHash } from "node:crypto";
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
  resumeMrtrContinuationLeg,
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
 * Derive the effective-server digest half of the binding fingerprint from the
 * live connection. Both the suspend site (PR5) and this resume path connect to
 * the server, so both can compute it identically from the negotiated identity —
 * a materially different server (name / version / capabilities / protocol)
 * yields a different digest and the claim fails closed. Config that never
 * reaches the wire (a rotated bearer behind the same identity) is intentionally
 * NOT in the digest; the auth-principal half covers principal changes.
 */
function deriveServerConfigDigest(
  manager: { getInitializationInfo: (serverId: string) => unknown },
  serverId: string,
): string {
  const info = manager.getInitializationInfo(serverId) as
    | {
        protocolVersion?: string;
        transport?: string;
        serverVersion?: unknown;
        serverCapabilities?: unknown;
      }
    | undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        protocolVersion: info?.protocolVersion ?? null,
        transport: info?.transport ?? null,
        serverVersion: info?.serverVersion ?? null,
        serverCapabilities: info?.serverCapabilities ?? null,
      }),
    )
    .digest("hex");
}

/**
 * POST /mrtr/continuation/resume
 *
 * Claim the record, idempotently submit the browser's response, and drive one
 * retry leg. Returns the resume outcome (completed result, another
 * `input_required` round, or a terminal failure/indeterminate).
 */
mrtrContinuation.post("/resume", async (c) =>
  handleRoute(c, async () => {
    const rawBody = await readJsonBody<Record<string, unknown>>(c);

    // Shape-gate the browser submission before it reaches the store.
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
      rawBody,
      resumeSchema,
      { timeoutMs: WEB_CALL_TIMEOUT_MS },
    );

    try {
      const serverId = body.serverId;
      const submission: MrtrResumeSubmission = {
        continuationId: body.continuationId,
        round: body.round,
        responses: submissionCandidate.responses,
      };

      // Warm the connection so the client exists AND its negotiated identity is
      // available for the fingerprint. listTools is not an MRTR verb, so it can
      // never itself return input_required.
      await manager.listTools(serverId);
      const client = manager.getManagedClient(serverId);
      if (!client) {
        throw new WebRouteError(
          502,
          ErrorCode.INTERNAL_ERROR,
          `MCP server "${serverId}" did not connect for resume`,
        );
      }

      // The auth-principal half of the binding must differentiate signed-in
      // principals: bearer-auth sets `mcpjamUserId`/`workosUserId` for WorkOS
      // sessions and `guestId` for guests (there is no `userId` context var), so
      // a real per-user id — not a shared "anonymous" — is what fails a
      // cross-principal resume closed.
      const authPrincipal =
        c.get("mcpjamUserId") ??
        c.get("workosUserId") ??
        c.get("guestId") ??
        "anonymous";
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
        resumeInputRequiredOperation(client, state, responses);

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
      await manager.disconnectAllServers();
    }
  }),
);

/**
 * POST /mrtr/continuation/cancel
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
