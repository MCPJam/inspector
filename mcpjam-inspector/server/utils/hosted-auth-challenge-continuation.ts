import { AUTH_CHALLENGE_REASON } from "@/shared/auth-challenge";
import { SCOPE_STEP_UP_LIVE_TTL_MS } from "@/shared/scope-step-up";
import type { MCPClientManager } from "@mcpjam/sdk";
import { createHash } from "node:crypto";
import {
  HostedCredentialBinding,
  HostedScopeStepUpState,
  encodeState,
  hashInput,
  readProtectedResourceUrl,
  resolveHostedCredentialBinding,
} from "./hosted-scope-step-up-continuation.js";
import {
  cancelContinuation,
  createContinuation,
  scrubContinuation,
} from "./mrtr-continuation-state.js";
import {
  computeMrtrBindingFingerprintFromManager,
  resolveMrtrNegotiatedEra,
} from "./mrtr-hosted-collector.js";

/**
 * A sign-in continuation's id carries its reason, so a cancel (which never
 * reads the saved state) can still answer with sign-in copy. The id stays
 * opaque to the browser, and a forged prefix names no continuation: the store
 * refuses it, so the copy is only ever chosen for a real sign-in.
 */
export const HOSTED_AUTH_CHALLENGE_CONTINUATION_PREFIX = "authz-";

export function isHostedAuthChallengeContinuationId(id: string): boolean {
  return id.startsWith(HOSTED_AUTH_CHALLENGE_CONTINUATION_PREFIX);
}

/**
 * The id is derived from the suspended call rather than drawn at random, so a
 * later turn that resends the call unresolved can find its continuation
 * without the browser naming it (history settlement). The store still
 * owns the row: only its owner can cancel or claim it, under the binding
 * fingerprint, so a derivable id grants nothing.
 */
export function hostedAuthChallengeContinuationId(input: {
  authPrincipal: string;
  chatSessionId: string;
  toolCallId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        "mcpjam/auth-challenge-continuation/v1",
        input.authPrincipal,
        input.chatSessionId,
        input.toolCallId,
      ].join("\u0000"),
    )
    .digest("base64url");
  return `${HOSTED_AUTH_CHALLENGE_CONTINUATION_PREFIX}${digest}`;
}

/**
 * A cancel answered for a call that never ran: the store cancelled it now (or
 * earlier), or its window ran out unanswered. Any other status means the
 * replay was claimed and may have run, so the call keeps its default
 * handling rather than being told it did not run.
 */
function answeredAsNotRun(status: string): boolean {
  return status === "cancelled" || status === "expired";
}

/**
 * History settlement on the hosted engine: cancel the pending sign-in
 * continuation a resent, still-unresolved call belongs to. True when there
 * was one to cancel, so the caller answers the call with the cancel copy; a
 * call this conversation never suspended for sign-in (or one already
 * terminal) keeps its default handling.
 */
export async function settleHostedAuthChallengeHistoryCall(input: {
  bearer: string;
  authPrincipal: string;
  chatSessionId: string;
  toolCallId: string;
}): Promise<boolean> {
  const continuationId = hostedAuthChallengeContinuationId(input);
  const cancelled = await cancelContinuation(input.bearer, {
    continuationId,
    reason: "the user continued without signing in",
  });
  if (!cancelled.ok || !answeredAsNotRun(cancelled.status)) return false;
  await scrubContinuation(input.bearer, { continuationId });
  return true;
}

/**
 * A cancel the client spliced into the user's next message. Cancels
 * the continuation when the store still holds it waiting; never fails, so an
 * unknown or expired continuation cannot cost the user their message. The
 * copy follows the id: a sign-in id answers with sign-in copy.
 */
export async function cancelHostedContinuationForNewMessage(input: {
  bearer: string;
  continuationId: string;
}): Promise<{ cancelled: boolean; isSignIn: boolean; mayHaveRun: boolean }> {
  const isSignIn = isHostedAuthChallengeContinuationId(input.continuationId);
  const cancelled = await cancelContinuation(input.bearer, {
    continuationId: input.continuationId,
    reason: "the user sent a new message instead of signing in",
  });
  if (!cancelled.ok) return { cancelled: false, isSignIn, mayHaveRun: false };
  if (!answeredAsNotRun(cancelled.status))
    return { cancelled: false, isSignIn, mayHaveRun: true };
  await scrubContinuation(input.bearer, {
    continuationId: input.continuationId,
  });
  return { cancelled: true, isSignIn, mayHaveRun: false };
}

/**
 * Save a call that a mid-session sign-in suspended. The same durable
 * store, binding fingerprint and single-claim rules as a step-up, plus the
 * reason and the credential binding the resume is checked against.
 */
export async function createHostedAuthChallengeContinuation(input: {
  bearer: string;
  authPrincipal: string;
  projectId: string;
  chatSessionId: string;
  manager: MCPClientManager;
  serverId: string;
  serverName?: string;
  connectionId?: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  abortSignal?: AbortSignal;
  /** Test seam; defaults to the backend's connection listing. */
  ownsCredential?: (connectionId: string) => Promise<boolean>;
}): Promise<{
  continuationId: string;
  expiresAt: number;
  credentialBinding: HostedCredentialBinding;
}> {
  const continuationId = hostedAuthChallengeContinuationId({
    authPrincipal: input.authPrincipal,
    chatSessionId: input.chatSessionId,
    toolCallId: input.toolCallId,
  });
  const negotiatedEra = resolveMrtrNegotiatedEra(input.manager, input.serverId);
  const bindingFingerprint = computeMrtrBindingFingerprintFromManager(
    input.manager,
    {
      serverId: input.serverId,
      negotiatedEra,
      authPrincipal: input.authPrincipal,
    },
  );
  const resourceUrl = readProtectedResourceUrl(input.manager, input.serverId);
  const credentialBinding = await resolveHostedCredentialBinding({
    bearer: input.bearer,
    projectId: input.projectId,
    serverId: input.serverId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.ownsCredential ? { ownsCredential: input.ownsCredential } : {}),
  });
  const state: HostedScopeStepUpState = {
    v: 1,
    reason: AUTH_CHALLENGE_REASON,
    serverId: input.serverId,
    ...(input.serverName ? { serverName: input.serverName } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    credentialBinding,
    ...(resourceUrl ? { resourceUrl } : {}),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    toolInput: input.toolInput,
    inputHash: hashInput(input.toolInput),
  };
  const created = await createContinuation(
    input.bearer,
    {
      continuationId,
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      serverId: input.serverId,
      operationId: input.toolCallId,
      operationMethod: "tools/call",
      negotiatedEra,
      bindingFingerprint,
      resumeState: encodeState(state),
      round: 0,
      maxRounds: 1,
      ttlMs: SCOPE_STEP_UP_LIVE_TTL_MS,
    },
    input.abortSignal,
  );
  if (!created.ok) {
    throw new Error(
      `auth_challenge_continuation_create_failed:${created.error}`,
    );
  }
  if (created.idempotent) {
    // The create response does not expose the stored input or credential. A
    // reused provider call ID cannot safely authorize a newly observed call.
    throw new Error(`auth_challenge_continuation_${created.status}`);
  }
  return { continuationId, expiresAt: created.expiresAt, credentialBinding };
}
