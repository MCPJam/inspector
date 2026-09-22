/**
 * Browser client for the hosted MRTR continuation transport (MCP 2026-07-28
 * §12.5). Server side: `server/routes/web/mrtr-continuation.ts` (mounted at
 * `/api/web/mrtr/*`) and `server/routes/web/mrtr-direct.ts`.
 *
 * Two things live here:
 *
 * 1. The thin route calls — `resumeHostedMrtrContinuation` /
 *    `cancelHostedMrtrContinuation`. A suspended operation is resumed on a
 *    FRESH authenticated request; the browser only ever holds the opaque
 *    `continuationId` (plus the round's safe display), never the operation
 *    state.
 * 2. The DIRECT-op driver — `driveHostedDirectMrtr`. A hosted tools/execute,
 *    prompts/get or resources/read that suspends returns a pending envelope
 *    instead of a result. The driver runs the round loop (queue → dialog →
 *    resume) and resolves with the operation's real result, so existing call
 *    sites keep awaiting one promise and never learn that a round happened.
 */

import { webPost, WebApiError } from "./base";
import { buildServerRequest } from "./context";
import {
  HOSTED_MRTR_VERSION,
  isCompatibleMrtrVersion,
  type MrtrElicitationResponse,
  type MrtrInputRequestDisplay,
  type MrtrOperationMethod,
} from "@/shared/mrtr-continuation";
import { useHostedMrtrStore } from "@/stores/hosted-mrtr-store";

/**
 * The handshake every hosted request that may enter an MRTR loop carries.
 *
 * The server drives the durable suspend path ONLY when it sees this: without
 * it a stale bundle — which can neither render a round nor resume it — would be
 * handed a `continuationId` it can do nothing with, and the operation would sit
 * until its continuation TTL. Spread it into a hosted request body.
 */
export const hostedMrtrHandshake = (): { hostedMrtrVersion: number } => ({
  hostedMrtrVersion: HOSTED_MRTR_VERSION,
});

/**
 * The browser-facing suspend envelope of a hosted DIRECT operation (the mirror
 * of the server's `HostedDirectMrtrPending`). A completed direct op returns its
 * verb's normal result verbatim; only a suspend produces this.
 */
export interface HostedDirectMrtrPending {
  status: "input_required";
  continuationId: string;
  version: number;
  serverId: string;
  serverName?: string;
  method: MrtrOperationMethod;
  operationLabel?: string;
  round: number;
  inputRequests: MrtrInputRequestDisplay[];
  expiresAt: number;
  /** Echoed back on every resume; part of the server-side binding fingerprint. */
  negotiatedEra: string;
}

export function isHostedDirectMrtrPending(
  value: unknown
): value is HostedDirectMrtrPending {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.status === "input_required" &&
    typeof v.continuationId === "string" &&
    typeof v.version === "number" &&
    typeof v.serverId === "string" &&
    typeof v.round === "number" &&
    typeof v.negotiatedEra === "string" &&
    Array.isArray(v.inputRequests) &&
    v.inputRequests.length > 0
  );
}

/** Terminal + pending outcomes `/api/web/mrtr/resume` reports back. */
export type HostedMrtrResumeResponse =
  | { ok: true; outcome: "completed"; result?: unknown }
  | {
      ok: true;
      outcome: "input_required";
      round: number;
      displays: MrtrInputRequestDisplay[];
      expiresAt?: number;
    }
  | {
      ok: true;
      outcome: "failed" | "cancelled" | "expired" | "indeterminate";
      reason: string;
      result?: unknown;
    };

export interface HostedMrtrResumeRequest {
  serverNameOrId: string;
  continuationId: string;
  round: number;
  responses: Record<string, MrtrElicitationResponse>;
  negotiatedEra: string;
  chatSessionId?: string;
}

/** POST `/api/web/mrtr/resume` — drive exactly one retry leg. */
export async function resumeHostedMrtrContinuation(
  request: HostedMrtrResumeRequest
): Promise<HostedMrtrResumeResponse> {
  const serverRequest = buildServerRequest(request.serverNameOrId);
  return webPost<Record<string, unknown>, HostedMrtrResumeResponse>(
    "/api/web/mrtr/resume",
    {
      ...serverRequest,
      continuationId: request.continuationId,
      round: request.round,
      responses: request.responses,
      negotiatedEra: request.negotiatedEra,
      ...(request.chatSessionId
        ? { chatSessionId: request.chatSessionId }
        : {}),
    }
  );
}

/**
 * POST `/api/web/mrtr/cancel` — durably withdraw a continuation.
 *
 * The original `AbortSignal` is gone once the operation suspended, so this is
 * the only way a user's dismissal (or a client that cannot honor the round)
 * releases the operation before its TTL.
 */
export async function cancelHostedMrtrContinuation(request: {
  continuationId: string;
  reason?: string;
}): Promise<{ ok: true; continuationStatus: string }> {
  return webPost("/api/web/mrtr/cancel", {
    continuationId: request.continuationId,
    ...(request.reason ? { reason: request.reason } : {}),
  });
}

/**
 * Thrown when a hosted MRTR operation ends without a usable result. Carries the
 * terminal outcome so a caller can distinguish a user withdrawal from an
 * `indeterminate` wire (a side-effecting call that may or may not have run —
 * callers MUST NOT auto-retry it).
 */
export class HostedMrtrTerminalError extends Error {
  readonly outcome: "failed" | "cancelled" | "expired" | "indeterminate";
  readonly continuationId: string;
  constructor(
    outcome: "failed" | "cancelled" | "expired" | "indeterminate",
    continuationId: string,
    message: string
  ) {
    super(message);
    this.name = "HostedMrtrTerminalError";
    this.outcome = outcome;
    this.continuationId = continuationId;
  }
}

/** Raised when the round was withdrawn from the dialog rail. */
const CANCELLED_BY_USER = "The operation was cancelled before it completed.";

function roundFromPending(
  pending: Pick<
    HostedDirectMrtrPending,
    | "continuationId"
    | "round"
    | "serverId"
    | "serverName"
    | "method"
    | "operationLabel"
    | "expiresAt"
  >,
  requests: MrtrInputRequestDisplay[]
) {
  return {
    key: `${pending.continuationId}:${pending.round}`,
    continuationId: pending.continuationId,
    round: pending.round,
    serverId: pending.serverId,
    ...(pending.serverName ? { serverName: pending.serverName } : {}),
    method: pending.method,
    ...(pending.operationLabel
      ? { operationLabel: pending.operationLabel }
      : {}),
    requests,
    expiresAt: pending.expiresAt,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Queue one round on the shared dialog rail and resolve with the user's
 * answers, or `null` when the user withdrew it.
 */
function collectRound(
  round: ReturnType<typeof roundFromPending>,
  onCancel: () => Promise<void>
): Promise<Record<string, MrtrElicitationResponse> | null> {
  return new Promise((resolve) => {
    useHostedMrtrStore.getState().enqueue(round, {
      submit: (responses) => {
        resolve(responses);
      },
      cancel: async () => {
        resolve(null);
        await onCancel();
      },
    });
  });
}

/**
 * Drive a suspended hosted DIRECT operation to completion.
 *
 * Loops: render the round → collect the user's `ElicitResult`s → resume →
 * repeat while the server asks for another round. Resolves with the completed
 * operation's result; throws {@link HostedMrtrTerminalError} on any terminal
 * outcome without one.
 *
 * A version-incompatible pending envelope FAILS FAST (withdraw + throw) rather
 * than rendering a round this bundle cannot complete — a half-understood
 * multi-step protocol is worse than none.
 */
export async function driveHostedDirectMrtr(
  pending: HostedDirectMrtrPending,
  options: { serverNameOrId: string; chatSessionId?: string }
): Promise<unknown> {
  const { continuationId, negotiatedEra } = pending;
  const withdraw = async (reason: string): Promise<void> => {
    try {
      await cancelHostedMrtrContinuation({ continuationId, reason });
    } catch {
      // Best effort: the continuation expires on its own TTL if this fails,
      // and the user already moved on.
    }
  };

  if (!isCompatibleMrtrVersion(pending.version)) {
    await withdraw("client version mismatch");
    throw new HostedMrtrTerminalError(
      "failed",
      continuationId,
      `This tab is running an outdated client (hosted-MRTR v${HOSTED_MRTR_VERSION}; ` +
        `this request needs v${pending.version}). Refresh the page and try again.`
    );
  }

  let round = pending.round;
  let requests = pending.inputRequests;

  // Bounded by the server: each resume either advances the round, completes, or
  // goes terminal, and the continuation has a TTL — so this loop is driven by
  // server outcomes, never by client-side retry.
  for (;;) {
    const responses = await collectRound(
      roundFromPending({ ...pending, round }, requests),
      () => withdraw("cancelled by user")
    );
    if (!responses) {
      throw new HostedMrtrTerminalError(
        "cancelled",
        continuationId,
        CANCELLED_BY_USER
      );
    }

    let outcome: HostedMrtrResumeResponse;
    try {
      outcome = await resumeHostedMrtrContinuation({
        serverNameOrId: options.serverNameOrId,
        continuationId,
        round,
        responses,
        negotiatedEra,
        ...(options.chatSessionId
          ? { chatSessionId: options.chatSessionId }
          : {}),
      });
    } catch (error) {
      // A transport/route failure leaves the continuation pending server-side;
      // surface the real error rather than a fabricated terminal outcome.
      useHostedMrtrStore.getState().resolveContinuation(continuationId);
      throw error instanceof WebApiError
        ? error
        : new HostedMrtrTerminalError(
            "failed",
            continuationId,
            error instanceof Error ? error.message : String(error)
          );
    }

    if (outcome.outcome === "input_required") {
      round = outcome.round;
      requests = outcome.displays;
      continue;
    }

    useHostedMrtrStore.getState().resolveContinuation(continuationId);
    if (outcome.outcome === "completed") return outcome.result;
    throw new HostedMrtrTerminalError(
      outcome.outcome,
      continuationId,
      outcome.reason
    );
  }
}

/**
 * Post a hosted direct operation that may enter an MRTR loop, driving any
 * rounds transparently. Call sites keep their existing "await one result"
 * shape; only a suspended operation takes the extra legs.
 *
 * `wrapResult` re-clothes the resumed MCP result in the verb's own envelope
 * (`{ status, result }` for tools/execute, `{ content }` for prompts/get and
 * resources/read). The resume route returns the bare result — it is shared by
 * all three verbs — so the verb-specific shape has to be restored here, or a
 * resumed call would hand its caller a differently-shaped body than a
 * first-try call.
 */
export async function webPostWithMrtr<TResponse>(
  path: string,
  payload: Record<string, unknown>,
  options: {
    serverNameOrId: string;
    chatSessionId?: string;
    wrapResult: (result: unknown) => TResponse;
  }
): Promise<TResponse> {
  const response = await webPost<Record<string, unknown>, unknown>(path, {
    ...payload,
    ...hostedMrtrHandshake(),
  });
  if (!isHostedDirectMrtrPending(response)) return response as TResponse;
  return options.wrapResult(await driveHostedDirectMrtr(response, options));
}
