/**
 * The three backend calls the chat-session derivation pass makes.
 *
 * Isolated from the pass itself for the reason `judge-stage-backend.ts` gives:
 * the caller is a durable worker woken by a doorbell, so it has NO user
 * identity to borrow. Authorization is the service token and nothing else, and
 * keeping the transport in its own module means the pass can be tested against
 * an injected port rather than a live backend.
 *
 * The claim hands back the generation and the source stamp it read INSIDE the
 * claim transaction. Neither is negotiable and neither is recomputed here: a
 * worker able to choose its own stamp could declare its stale work fresh,
 * which is the one thing the stamp exists to prevent.
 */

import { logger } from "../../utils/logger.js";

/** Per-request cap so a stalled Convex cannot wedge the pass. */
const SERVICE_ROUTE_TIMEOUT_MS = 15_000;

const BASE_PATH = "/internal/v1/chat-stage-derivations";

export class ChatStageBackendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ChatStageBackendError";
  }
}

/** Present only on a deployment that IS an infrastructure peer. */
function requiredEnv(): { convexUrl: string; serviceToken: string } | null {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) return null;
  return { convexUrl, serviceToken };
}

export function chatStageWorkerConfigured(): boolean {
  return requiredEnv() !== null;
}

async function postServiceRoute(
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: any }> {
  const env = requiredEnv();
  if (!env) {
    throw new Error(
      "Chat stage derivation requires CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN"
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SERVICE_ROUTE_TIMEOUT_MS
  );
  let response: Response;
  try {
    response = await fetch(`${env.convexUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inspector-service-token": env.serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    // tolerated; status carries the signal
  }
  return { status: response.status, body: parsed };
}

/** The evidence a claim hands back, exactly as the session row stores it. */
export type ClaimedStageEvidence = {
  lifecycle?: unknown;
  readiness?: unknown;
  criteria?: unknown;
  goalScore?: unknown;
};

export type ClaimedStageDerivation = {
  sessionDocId: string;
  chatSessionId: string;
  generation: number;
  source: string;
  /** Opaque here on purpose: handed straight back to `apply`, never rebuilt. */
  sourceStamp: Record<string, unknown>;
  attempts: number;
  evidence: ClaimedStageEvidence;
  envelope: { messages?: unknown[]; spans?: unknown[] } | null;
};

export type StageClaimOutcome =
  | { kind: "claimed"; claim: ClaimedStageDerivation }
  | { kind: "empty" }
  /** A row was consumed without producing work — poll again immediately. */
  | { kind: "drained" }
  /** `CHAT_STAGE_DERIVATION_ENABLED` is off backend-side. */
  | { kind: "disabled" };

export async function claimNextStageDerivation(
  claimedBy: string
): Promise<StageClaimOutcome> {
  const { status, body } = await postServiceRoute(`${BASE_PATH}/claim`, {
    claimedBy,
  });
  if (status === 404) return { kind: "disabled" };
  if (status !== 200 || !body?.ok) {
    throw new ChatStageBackendError(`claim failed (${status})`, status);
  }
  if (body.claimed !== true) {
    return body.retry === true ? { kind: "drained" } : { kind: "empty" };
  }
  if (
    typeof body.sessionDocId !== "string" ||
    typeof body.generation !== "number" ||
    typeof body.source !== "string" ||
    typeof body.sourceStamp !== "object" ||
    body.sourceStamp === null
  ) {
    throw new ChatStageBackendError("claim returned a malformed payload", 200);
  }
  return {
    kind: "claimed",
    claim: {
      sessionDocId: body.sessionDocId,
      chatSessionId:
        typeof body.chatSessionId === "string" ? body.chatSessionId : "",
      generation: body.generation,
      source: body.source,
      sourceStamp: body.sourceStamp,
      attempts: typeof body.attempts === "number" ? body.attempts : 0,
      evidence: (body.evidence ?? {}) as ClaimedStageEvidence,
      envelope: body.envelope ?? null,
    },
  };
}

export type StageApplyOutcome =
  | { kind: "applied" }
  /** NOT a failure: someone asked for better work while this was in flight. */
  | { kind: "superseded"; reason: string }
  | { kind: "invalid"; reason: string };

export async function applyStageDerivation(args: {
  sessionDocId: string;
  generation: number;
  sourceStamp: Record<string, unknown>;
  stageResults: unknown[];
  firstFailedStage?: string;
  failureCategory?: string;
  stageAnalyzerVersion: number;
}): Promise<StageApplyOutcome> {
  const { status, body } = await postServiceRoute(`${BASE_PATH}/apply`, args);
  if (status !== 200 || !body?.ok) {
    throw new ChatStageBackendError(`apply failed (${status})`, status);
  }
  if (body.applied === true) return { kind: "applied" };
  const reason = typeof body.reason === "string" ? body.reason : "unknown";
  return body.outcome === "invalid"
    ? { kind: "invalid", reason }
    : { kind: "superseded", reason };
}

/**
 * Report that a claim could not produce a derivation.
 *
 * Best-effort: the claim's durable lease means a dropped report costs one
 * recovery interval, not a derivation. The `errorCode` is from the backend's
 * CLOSED vocabulary — nothing free-text is ever sent, because the one thing an
 * exception message reliably contains is detail from the transcript that
 * produced it.
 */
export async function failStageDerivation(args: {
  sessionDocId: string;
  generation: number;
  errorCode: string;
  retryable?: boolean;
}): Promise<void> {
  try {
    await postServiceRoute(`${BASE_PATH}/fail`, args);
  } catch (error) {
    logger.warn("[chat-stage] failed to report derivation failure", {
      sessionDocId: args.sessionDocId,
      errorCode: args.errorCode,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
