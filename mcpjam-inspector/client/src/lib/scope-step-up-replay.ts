import {
  SCOPE_STEP_UP_LIVE_TTL_MS,
  type StepUpOperationKey,
} from "@/shared/scope-step-up";
import {
  isStepUpCredentialBinding,
  settleStepUpCredential,
  type StepUpCredentialBinding,
} from "@/lib/scope-step-up-credential";

const PENDING_DIRECT_REPLAY_KEY = "mcp-scope-step-up-replay-v1";

export type DirectScopeStepUpReplayDescriptor =
  | {
      kind: "tool";
      surface: "tools" | "playground";
      serverName: string;
      toolName: string;
      parameters: Record<string, unknown>;
      taskOptions?: { ttl?: number };
      allowTaskResult?: boolean;
    }
  | {
      kind: "resource";
      surface: "resources";
      serverName: string;
      uri: string;
      target: "resource" | "template";
      /** Original UI selection (a URI template for template reads). */
      selection?: string;
    }
  | {
      kind: "prompt";
      surface: "prompts";
      serverName: string;
      promptName: string;
      arguments: Record<string, string>;
    };

export type PendingDirectScopeStepUpReplay = {
  version: 1;
  phase: "awaiting_oauth" | "ready" | "replaying";
  operation: StepUpOperationKey;
  descriptor: DirectScopeStepUpReplayDescriptor;
  returnPath: string;
  createdAt: number;
  expiresAt: number;
  /** Which credential the sign-in authorizes; see `scope-step-up-credential`. */
  credentialBinding?: StepUpCredentialBinding;
  /**
   * A digest of the authorization request's `state`, recorded right before
   * the redirect (never the state itself; see `authorizationFlowDigest`).
   * Only the callback for THIS flow may mark the call ready; another flow for
   * the same server cancels it instead of replaying it.
   */
  flowDigest?: string;
  /**
   * Set for a mid-session sign-in. A step-up leaves it absent.
   */
  reason?: "authorization_required";
  /**
   * The call may change something (no `readOnlyHint: true`): after sign-in
   * the surface asks "Run again?" instead of replaying it on its own.
   */
  requiresConfirmation?: boolean;
};

function readStored(): PendingDirectScopeStepUpReplay | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_DIRECT_REPLAY_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<PendingDirectScopeStepUpReplay>;
    if (
      value.version !== 1 ||
      (value.phase !== "awaiting_oauth" &&
        value.phase !== "ready" &&
        value.phase !== "replaying") ||
      !value.operation ||
      !value.descriptor ||
      typeof value.returnPath !== "string" ||
      typeof value.createdAt !== "number" ||
      typeof value.expiresAt !== "number" ||
      (value.credentialBinding !== undefined &&
        !isStepUpCredentialBinding(value.credentialBinding)) ||
      (value.flowDigest !== undefined &&
        typeof value.flowDigest !== "string") ||
      (value.reason !== undefined &&
        value.reason !== "authorization_required") ||
      (value.requiresConfirmation !== undefined &&
        typeof value.requiresConfirmation !== "boolean")
    ) {
      sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
      return undefined;
    }
    if (value.expiresAt <= Date.now()) {
      sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
      return undefined;
    }
    return value as PendingDirectScopeStepUpReplay;
  } catch {
    sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
    return undefined;
  }
}

function write(value: PendingDirectScopeStepUpReplay): void {
  sessionStorage.setItem(PENDING_DIRECT_REPLAY_KEY, JSON.stringify(value));
}

export function savePendingDirectScopeStepUpReplay(input: {
  operation: StepUpOperationKey;
  descriptor: DirectScopeStepUpReplayDescriptor;
  reason?: "authorization_required";
  requiresConfirmation?: boolean;
}): void {
  const now = Date.now();
  write({
    version: 1,
    phase: "awaiting_oauth",
    operation: input.operation,
    descriptor: input.descriptor,
    returnPath:
      window.location.pathname + window.location.search + window.location.hash,
    createdAt: now,
    expiresAt: now + SCOPE_STEP_UP_LIVE_TTL_MS,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.requiresConfirmation ? { requiresConfirmation: true } : {}),
  });
}

/** Bind the saved call to the authorization flow it waits on. */
export function setPendingDirectScopeStepUpReplayFlowDigest(
  serverName: string,
  flowDigest: string,
): void {
  const pending = readStored();
  if (
    !pending ||
    pending.phase !== "awaiting_oauth" ||
    pending.descriptor.serverName !== serverName
  ) {
    return;
  }
  write({ ...pending, flowDigest });
}

export const SIGNED_IN_FOR_ANOTHER_REQUEST_MESSAGE =
  "Signed in, but not from the request that was waiting, so the earlier call was not retried. Run it again.";

/** Record which credential the pending sign-in authorizes. */
export function setPendingDirectScopeStepUpReplayCredentialBinding(
  serverName: string,
  binding: StepUpCredentialBinding,
): void {
  const pending = readStored();
  if (!pending || pending.descriptor.serverName !== serverName) return;
  write({ ...pending, credentialBinding: binding });
}

/**
 * Settle the saved direct call after an OAuth callback that reported the
 * credential it produced. Returns the cancellation message when the call must
 * not be replayed (a different or shared credential), so the caller can say
 * so; `undefined` when it was marked ready or nothing was pending.
 */
export function settlePendingDirectScopeStepUpReplayAfterCallback(
  serverName: string,
  callbackCredentialId: string | undefined,
  callbackDigest?: string,
): string | undefined {
  const pending = readStored();
  if (!pending || pending.descriptor.serverName !== serverName) return undefined;
  // Bound to its flow: a callback for a different authorization request (an
  // older tab, a second Connect) must not replay this call's saved arguments.
  if (
    pending.flowDigest &&
    callbackDigest &&
    pending.flowDigest !== callbackDigest
  ) {
    sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
    return SIGNED_IN_FOR_ANOTHER_REQUEST_MESSAGE;
  }
  const settled = settleStepUpCredential(
    pending.credentialBinding,
    callbackCredentialId,
  );
  if (settled.outcome === "replay") {
    write({ ...pending, phase: "ready" });
    return undefined;
  }
  sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
  return settled.message;
}

export function markPendingDirectScopeStepUpReplayReady(
  serverName: string,
  callbackDigest?: string,
): void {
  const pending = readStored();
  if (!pending || pending.descriptor.serverName !== serverName) return;
  if (
    pending.flowDigest &&
    callbackDigest &&
    pending.flowDigest !== callbackDigest
  ) {
    sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
    return;
  }
  write({ ...pending, phase: "ready" });
}

/** The saved call, without claiming it (for a "Run again?" prompt). */
export function peekPendingDirectScopeStepUpReplay():
  | PendingDirectScopeStepUpReplay
  | undefined {
  return readStored();
}

export function cancelPendingDirectScopeStepUpReplay(
  serverName?: string,
): void {
  const pending = readStored();
  if (
    !pending ||
    (serverName && pending.descriptor.serverName !== serverName)
  ) {
    return;
  }
  sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
}

export function claimPendingDirectScopeStepUpReplay(input: {
  serverName: string;
  surface: DirectScopeStepUpReplayDescriptor["surface"];
}): PendingDirectScopeStepUpReplay | undefined {
  const pending = readStored();
  if (
    !pending ||
    pending.phase !== "ready" ||
    pending.descriptor.serverName !== input.serverName ||
    pending.descriptor.surface !== input.surface
  ) {
    return undefined;
  }
  write({ ...pending, phase: "replaying" });
  return pending;
}

export function clearPendingDirectScopeStepUpReplay(): void {
  sessionStorage.removeItem(PENDING_DIRECT_REPLAY_KEY);
}
