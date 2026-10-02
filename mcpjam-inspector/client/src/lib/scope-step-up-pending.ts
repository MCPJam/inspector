import {
  isScopeStepUpRequiredEvent,
  type ScopeStepUpRequiredEvent,
} from "@/shared/scope-step-up";
import {
  isAuthRequiredEvent,
  type AuthRequiredEvent,
} from "@/shared/auth-challenge";
import {
  isStepUpCredentialBinding,
  settleStepUpCredential,
  type StepUpCredentialBinding,
} from "@/lib/scope-step-up-credential";

const PENDING_SCOPE_STEP_UP_KEY = "mcp-scope-step-up-chat-v1";

/** A mid-session sign-in that can resume: it carries its continuation. */
export type ResumableAuthRequiredEvent = AuthRequiredEvent & {
  continuationId: string;
};

export type PendingChatScopeStepUp = {
  version: 1;
  /**
   * `awaiting_click` exists only for a mid-session sign-in: the Connect card
   * is showing and nothing has redirected. It is saved when the card arrives,
   * so a send without clicking (or a reload) can cancel the suspended call.
   */
  phase: "awaiting_click" | "awaiting_oauth" | "ready" | "cancelled" | "resuming";
  event: ScopeStepUpRequiredEvent | ResumableAuthRequiredEvent;
  serverName: string;
  chatSessionId: string;
  returnPath: string;
  createdAt: number;
  cancellationMessage?: string;
  /**
   * Which credential the sign-in authorizes, recorded before the redirect.
   * Settled on the callback: a sign-in that did not reauthorize the very
   * credential the call used cancels the saved call instead of replaying it.
   */
  credentialBinding?: StepUpCredentialBinding;
  /**
   * A digest of the authorization request's `state` (never the state itself;
   * see `authorizationFlowDigest`). Only the callback for this flow may mark
   * the call ready; another flow for the server cancels it.
   */
  flowDigest?: string;
};

function isPendingChatEvent(
  value: unknown,
): value is PendingChatScopeStepUp["event"] {
  if (isScopeStepUpRequiredEvent(value)) return true;
  return (
    isAuthRequiredEvent(value) &&
    typeof value.continuationId === "string" &&
    value.action === "prompt"
  );
}

/** Whether a pending chat entry is a mid-session sign-in (not a step-up). */
export function isPendingChatAuthRequired(
  pending: PendingChatScopeStepUp,
): pending is PendingChatScopeStepUp & { event: ResumableAuthRequiredEvent } {
  return (pending.event as { kind?: unknown }).kind === "auth_required";
}

function isPendingChatScopeStepUp(
  value: unknown
): value is PendingChatScopeStepUp {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingChatScopeStepUp>;
  return (
    candidate.version === 1 &&
    (candidate.phase === "awaiting_click" ||
      candidate.phase === "awaiting_oauth" ||
      candidate.phase === "ready" ||
      candidate.phase === "cancelled" ||
      candidate.phase === "resuming") &&
    typeof candidate.serverName === "string" &&
    typeof candidate.chatSessionId === "string" &&
    typeof candidate.returnPath === "string" &&
    typeof candidate.createdAt === "number" &&
    (candidate.cancellationMessage === undefined ||
      typeof candidate.cancellationMessage === "string") &&
    (candidate.credentialBinding === undefined ||
      isStepUpCredentialBinding(candidate.credentialBinding)) &&
    (candidate.flowDigest === undefined ||
      typeof candidate.flowDigest === "string") &&
    isPendingChatEvent(candidate.event) &&
    // Only a sign-in has a click to wait for.
    (candidate.phase !== "awaiting_click" ||
      (candidate.event as { kind?: unknown }).kind === "auth_required")
  );
}

export function readPendingChatScopeStepUp():
  | PendingChatScopeStepUp
  | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_SCOPE_STEP_UP_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!isPendingChatScopeStepUp(parsed)) {
      sessionStorage.removeItem(PENDING_SCOPE_STEP_UP_KEY);
      return undefined;
    }
    if (parsed.event.expiresAt <= Date.now()) {
      sessionStorage.removeItem(PENDING_SCOPE_STEP_UP_KEY);
      return undefined;
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(PENDING_SCOPE_STEP_UP_KEY);
    return undefined;
  }
}

function writePending(value: PendingChatScopeStepUp): void {
  sessionStorage.setItem(PENDING_SCOPE_STEP_UP_KEY, JSON.stringify(value));
}

export function savePendingChatScopeStepUp(input: {
  event: PendingChatScopeStepUp["event"];
  serverName: string;
  chatSessionId: string;
  /** Default `awaiting_oauth`; a sign-in card is saved as `awaiting_click`. */
  phase?: "awaiting_click" | "awaiting_oauth";
}): void {
  writePending({
    version: 1,
    phase: input.phase ?? "awaiting_oauth",
    event: input.event,
    serverName: input.serverName,
    chatSessionId: input.chatSessionId,
    returnPath:
      window.location.pathname + window.location.search + window.location.hash,
    createdAt: Date.now(),
  });
}

/**
 * The Connect card was clicked: the saved sign-in now waits on OAuth. A no-op
 * unless the entry for this continuation is still waiting for the click.
 */
export function markPendingChatAuthRequiredClicked(
  continuationId: string,
): boolean {
  const pending = readPendingChatScopeStepUp();
  if (
    !pending ||
    pending.phase !== "awaiting_click" ||
    pending.event.continuationId !== continuationId
  ) {
    return false;
  }
  writePending({ ...pending, phase: "awaiting_oauth" });
  return true;
}

/** Bind the saved call to the authorization flow it waits on. */
export function setPendingChatScopeStepUpFlowDigest(
  serverName: string,
  flowDigest: string,
): void {
  const pending = readPendingChatScopeStepUp();
  if (
    !pending ||
    pending.phase !== "awaiting_oauth" ||
    pending.serverName !== serverName
  ) {
    return;
  }
  writePending({ ...pending, flowDigest });
}

/** Record which credential the pending sign-in authorizes. */
export function setPendingChatScopeStepUpCredentialBinding(
  serverName: string,
  binding: StepUpCredentialBinding,
): void {
  const pending = readPendingChatScopeStepUp();
  if (!pending || pending.serverName !== serverName) return;
  writePending({ ...pending, credentialBinding: binding });
}

/**
 * Settle the pending chat step-up after an OAuth callback that reported the
 * credential it produced: replay only when the sign-in reauthorized the
 * credential the call used (or the call used none).
 */
export function settlePendingChatScopeStepUpAfterCallback(
  serverName: string,
  callbackCredentialId: string | undefined,
  callbackDigest?: string,
): void {
  const pending = readPendingChatScopeStepUp();
  if (!pending || pending.serverName !== serverName) return;
  // Nothing redirected for a card that was never clicked; this callback
  // belongs to some other flow.
  if (pending.phase === "awaiting_click") return;
  if (
    pending.flowDigest &&
    callbackDigest &&
    pending.flowDigest !== callbackDigest
  ) {
    markPendingChatScopeStepUpCancelled(
      serverName,
      "Signed in, but not from the request that was waiting, so the earlier call was not retried. Run it again.",
    );
    return;
  }
  const settled = settleStepUpCredential(
    pending.credentialBinding,
    callbackCredentialId,
  );
  if (settled.outcome === "replay") {
    markPendingChatScopeStepUpReady(serverName);
  } else {
    markPendingChatScopeStepUpCancelled(serverName, settled.message);
  }
}

export function markPendingChatScopeStepUpReady(serverName: string): void {
  const pending = readPendingChatScopeStepUp();
  if (!pending || pending.serverName !== serverName) return;
  writePending({ ...pending, phase: "ready" });
}

export function cancelPendingChatScopeStepUp(serverName?: string): void {
  const pending = readPendingChatScopeStepUp();
  if (!pending || (serverName && pending.serverName !== serverName)) return;
  sessionStorage.removeItem(PENDING_SCOPE_STEP_UP_KEY);
}

export function markPendingChatScopeStepUpCancelled(
  serverName?: string,
  message = "Authorization was not completed."
): void {
  const pending = readPendingChatScopeStepUp();
  if (!pending || (serverName && pending.serverName !== serverName)) return;
  writePending({
    ...pending,
    phase: "cancelled",
    cancellationMessage: message,
  });
}

export function claimPendingChatScopeStepUp(
  chatSessionId: string
): PendingChatScopeStepUp | undefined {
  const pending = readPendingChatScopeStepUp();
  if (
    !pending ||
    pending.phase !== "ready" ||
    pending.chatSessionId !== chatSessionId
  ) {
    return undefined;
  }
  writePending({ ...pending, phase: "resuming" });
  return pending;
}

export function claimCancelledChatScopeStepUp(
  chatSessionId: string
): PendingChatScopeStepUp | undefined {
  const pending = readPendingChatScopeStepUp();
  if (
    !pending ||
    pending.phase !== "cancelled" ||
    pending.chatSessionId !== chatSessionId
  ) {
    return undefined;
  }
  writePending({ ...pending, phase: "resuming" });
  return pending;
}

export function clearPendingChatScopeStepUp(continuationId: string): void {
  const pending = readPendingChatScopeStepUp();
  if (pending?.event.continuationId !== continuationId) return;
  sessionStorage.removeItem(PENDING_SCOPE_STEP_UP_KEY);
}
