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

import {
  CHAT_AUTH_RECOVERY_MESSAGE,
  recordChatAuthRecoveryFailure,
  traceChatAuthRecovery,
  type RecoveryContext,
} from "@/lib/chat-auth-recovery";

const LEGACY_KEY = "mcp-scope-step-up-chat-v1";
const PENDING_SCOPE_STEP_UP_KEY = "mcp-scope-step-up-chat-v2";
const ATTEMPTS_KEY = "mcp-chat-auth-attempts-v1";
let revision = 0;
const listeners = new Set<() => void>();
export function subscribePendingChatScopeStepUps(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function pendingChatScopeStepUpRevision() {
  return revision;
}
function changed() {
  revision++;
  listeners.forEach((listener) => listener());
}

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
  phase:
    | "awaiting_click"
    | "awaiting_oauth"
    | "ready"
    | "cancelled"
    | "resuming"
    | "cancelling";
  resumeAttempted?: boolean;
  cancelAttempted?: boolean;
  event: ScopeStepUpRequiredEvent | ResumableAuthRequiredEvent;
  serverName: string;
  chatSessionId: string;
  projectId?: string | null;
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
  value: unknown,
): value is PendingChatScopeStepUp {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingChatScopeStepUp>;
  return (
    candidate.version === 1 &&
    (candidate.phase === "awaiting_click" ||
      candidate.phase === "awaiting_oauth" ||
      candidate.phase === "ready" ||
      candidate.phase === "cancelled" ||
      candidate.phase === "resuming" ||
      candidate.phase === "cancelling") &&
    typeof candidate.serverName === "string" &&
    typeof candidate.chatSessionId === "string" &&
    typeof candidate.returnPath === "string" &&
    typeof candidate.createdAt === "number" &&
    (candidate.resumeAttempted === undefined ||
      typeof candidate.resumeAttempted === "boolean") &&
    (candidate.cancelAttempted === undefined ||
      typeof candidate.cancelAttempted === "boolean") &&
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

export type PendingChatSelector = {
  continuationId?: string;
  chatSessionId?: string;
  projectId?: string | null;
  serverName?: string;
  phases?: PendingChatScopeStepUp["phase"][];
};
export type PendingWriteResult =
  | { ok: true }
  | { ok: false; reason: "storage" | "missing" | "expired" | "phase" | "loading" };
export interface ChatAuthAttempt extends RecoveryContext {
  continuationId: string;
  toolCallId: string;
  chatSessionId: string;
  serverName: string;
  expiresAt: number;
  startedAt: number;
}
export function pendingRecoveryContext(
  pending: PendingChatScopeStepUp,
): RecoveryContext {
  return {
    continuationId: pending.event.continuationId,
    toolCallId: pending.event.toolCallId,
    chatSessionId: pending.chatSessionId,
    projectId: pending.projectId,
    serverName: pending.serverName,
    serverId: pending.event.serverId,
    phase: pending.phase,
    flowDigest: pending.flowDigest,
  };
}
function readAll(): PendingChatScopeStepUp[] {
  try {
    const raw = sessionStorage.getItem(PENDING_SCOPE_STEP_UP_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.version !== 2 || !Array.isArray(data.entries)) return [];
      return data.entries.filter(isPendingChatScopeStepUp);
    }
    const legacy = sessionStorage.getItem(LEGACY_KEY);
    if (!legacy) return [];
    const data = JSON.parse(legacy);
    if (!isPendingChatScopeStepUp(data)) return [];
    // Migration is verified before the legacy row is removed.
    if (storeEntries([data])) sessionStorage.removeItem(LEGACY_KEY);
    return [data];
  } catch {
    return [];
  }
}
function storeEntries(entries: PendingChatScopeStepUp[]): boolean {
  try {
    const raw = JSON.stringify({ version: 2, entries });
    sessionStorage.setItem(PENDING_SCOPE_STEP_UP_KEY, raw);
    return sessionStorage.getItem(PENDING_SCOPE_STEP_UP_KEY) === raw;
  } catch {
    return false;
  }
}
export function readChatAuthAttempts(): ChatAuthAttempt[] {
  try {
    const data = JSON.parse(sessionStorage.getItem(ATTEMPTS_KEY) ?? "[]");
    return Array.isArray(data)
      ? data.filter(
          (item) =>
            item &&
            typeof item.continuationId === "string" &&
            typeof item.toolCallId === "string" &&
            typeof item.chatSessionId === "string" &&
            typeof item.serverName === "string" &&
            typeof item.expiresAt === "number" &&
            typeof item.startedAt === "number",
        )
      : [];
  } catch {
    return [];
  }
}
function storeAttempts(attempts: ChatAuthAttempt[]): boolean {
  try {
    const raw = JSON.stringify(attempts);
    sessionStorage.setItem(ATTEMPTS_KEY, raw);
    return sessionStorage.getItem(ATTEMPTS_KEY) === raw;
  } catch {
    return false;
  }
}
function rememberAttempt(pending: PendingChatScopeStepUp): boolean {
  const attempt: ChatAuthAttempt = {
    ...pendingRecoveryContext(pending),
    continuationId: pending.event.continuationId,
    toolCallId: pending.event.toolCallId,
    chatSessionId: pending.chatSessionId,
    serverName: pending.serverName,
    expiresAt: pending.event.expiresAt,
    startedAt: Date.now(),
  };
  const attempts = readChatAuthAttempts();
  return storeAttempts([
    ...attempts.filter(
      (item) => item.continuationId !== attempt.continuationId,
    ),
    attempt,
  ]);
}
export function listPendingChatScopeStepUps(
  selector: PendingChatSelector = {},
): PendingChatScopeStepUp[] {
  return readAll().filter(
    (pending) =>
      (selector.continuationId === undefined ||
        pending.event.continuationId === selector.continuationId) &&
      (selector.chatSessionId === undefined ||
        pending.chatSessionId === selector.chatSessionId) &&
      (selector.projectId === undefined ||
        pending.projectId === undefined ||
        pending.projectId === selector.projectId) &&
      (selector.serverName === undefined ||
        pending.serverName === selector.serverName) &&
      (!selector.phases || selector.phases.includes(pending.phase)),
  );
}
/** Name-only legacy callers may act only when the selection is unambiguous. */
export function readPendingChatScopeStepUp(
  selector: PendingChatSelector = {},
): PendingChatScopeStepUp | undefined {
  const entries = listPendingChatScopeStepUps(selector);
  return entries.length === 1 ? entries[0] : undefined;
}
function writePending(value: PendingChatScopeStepUp): PendingWriteResult {
  const entries = readAll().filter(
    (item) => item.event.continuationId !== value.event.continuationId,
  );
  if (!storeEntries([...entries, value])) {
    recordChatAuthRecoveryFailure("save_failed", {
      ...pendingRecoveryContext(value),
      storageOutcome: "write_or_verify_failed",
    });
    return { ok: false, reason: "storage" };
  }
  traceChatAuthRecovery("save", {
    ...pendingRecoveryContext(value),
    storageOutcome: "verified",
  });
  changed();
  return { ok: true };
}
export type SavePendingChatInput = {
  event: PendingChatScopeStepUp["event"];
  serverName: string;
  chatSessionId: string;
  projectId?: string | null;
  phase?: "awaiting_click" | "awaiting_oauth";
};
export function savePendingChatScopeStepUp(
  input: SavePendingChatInput,
): PendingWriteResult {
  return writePending({
    version: 1,
    ...input,
    phase: input.phase ?? "awaiting_oauth",
    returnPath:
      window.location.pathname + window.location.search + window.location.hash,
    createdAt: Date.now(),
  });
}
/** Recover a missing card-time save, but never reset a call already being driven. */
export function preparePendingChatAuthRequired(
  input: SavePendingChatInput,
): PendingWriteResult {
  let pending = readPendingChatScopeStepUp({
    continuationId: input.event.continuationId,
  });
  if (!pending) {
    recordChatAuthRecoveryFailure("missing_pending", {
      continuationId: input.event.continuationId,
      toolCallId: input.event.toolCallId,
      chatSessionId: input.chatSessionId,
      projectId: input.projectId,
      serverName: input.serverName,
      serverId: input.event.serverId,
      recoveryResult: "rebuilding_from_card",
    });
    const saved = savePendingChatScopeStepUp({
      ...input,
      phase: "awaiting_click",
    });
    if (!saved.ok) return saved;
    pending = readPendingChatScopeStepUp({
      continuationId: input.event.continuationId,
    });
  }
  if (!pending) return { ok: false, reason: "missing" };
  if (
    pending.chatSessionId !== input.chatSessionId ||
    pending.serverName !== input.serverName ||
    (pending.projectId !== undefined &&
      pending.projectId !== input.projectId) ||
    pending.event.toolCallId !== input.event.toolCallId
  ) {
    recordChatAuthRecoveryFailure(
      "invalid_pending",
      pendingRecoveryContext(pending),
    );
    return { ok: false, reason: "phase" };
  }
  if (pending.projectId === undefined && input.projectId !== undefined) {
    const saved = writePending({ ...pending, projectId: input.projectId });
    if (!saved.ok) return saved;
  }
  return markPendingChatAuthRequiredClicked(input.event.continuationId)
    ? { ok: true }
    : { ok: false, reason: "phase" };
}
export function markPendingChatAuthRequiredClicked(
  continuationId: string,
): boolean {
  const pending = readPendingChatScopeStepUp({ continuationId });
  if (
    !pending ||
    (pending.phase !== "awaiting_click" && pending.phase !== "awaiting_oauth")
  )
    return false;
  if (pending.event.expiresAt <= Date.now()) {
    recordChatAuthRecoveryFailure("expired", {
      ...pendingRecoveryContext(pending),
      recoveryResult: "click_refused",
    });
    writePending({
      ...pending,
      phase: "cancelled",
      cancellationMessage: CHAT_AUTH_RECOVERY_MESSAGE,
    });
    return false;
  }
  const next = {
    ...pending,
    phase: "awaiting_oauth" as const,
    flowDigest: undefined,
    returnPath:
      window.location.pathname + window.location.search + window.location.hash,
  };
  if (!rememberAttempt(next)) {
    recordChatAuthRecoveryFailure("save_failed", {
      ...pendingRecoveryContext(next),
      storageOutcome: "attempt_write_failed",
    });
    return false;
  }
  if (!writePending(next).ok) return false;
  traceChatAuthRecovery("click", pendingRecoveryContext(next));
  return true;
}
export function setPendingChatScopeStepUpFlowDigest(
  serverName: string,
  flowDigest: string,
  continuationId?: string,
): boolean {
  const pending = readPendingChatScopeStepUp({
    serverName,
    continuationId,
    phases: ["awaiting_oauth"],
  });
  if (!pending) return false;
  const next = { ...pending, flowDigest };
  if (!rememberAttempt(next)) {
    recordChatAuthRecoveryFailure("save_failed", {
      ...pendingRecoveryContext(next),
      storageOutcome: "flow_write_failed",
    });
    return false;
  }
  return writePending(next).ok;
}
export function setPendingChatScopeStepUpCredentialBinding(
  serverName: string,
  binding: StepUpCredentialBinding,
  continuationId?: string,
): boolean {
  const pending = readPendingChatScopeStepUp({ serverName, continuationId });
  return pending
    ? writePending({ ...pending, credentialBinding: binding }).ok
    : false;
}
// A continuation can start a new flow after Back. Its old callback owns nothing.
export function isStaleChatAuthCallback(
  continuationId: string | undefined,
  callbackDigest: string | undefined,
): boolean {
  if (!continuationId) return false;
  const current = readPendingChatScopeStepUp({ continuationId }) ??
    readChatAuthAttempts().find(item => item.continuationId === continuationId);
  return !!current && current.flowDigest !== callbackDigest;
}
export type ChatCallbackSettlement =
  { kind: "ignored" | "ready" } | { kind: "failed"; message: string };
export function settlePendingChatScopeStepUpAfterCallback(
  serverName: string,
  callbackCredentialId: string | undefined,
  callbackDigest?: string,
  continuationId?: string,
): ChatCallbackSettlement {
  if (isStaleChatAuthCallback(continuationId, callbackDigest))
    return { kind: "ignored" };
  const attempts = readChatAuthAttempts();
  // Prefer the exact digest. A foreign callback must never borrow another flow.
  const exact = callbackDigest
    ? attempts.filter((item) => item.flowDigest === callbackDigest)
    : [];
  const attempt = continuationId
    ? attempts.find((item) => item.continuationId === continuationId)
    : exact.length === 1
      ? exact[0]
      : undefined;
  const legacy = !attempt
    ? readPendingChatScopeStepUp({
        serverName,
        continuationId,
        phases: ["awaiting_oauth"],
      })
    : undefined;
  const pending = attempt
    ? readPendingChatScopeStepUp({ continuationId: attempt.continuationId })
    : legacy;
  if (!attempt && !pending) return { kind: "ignored" };
  if (
    !continuationId &&
    !attempt &&
    pending?.flowDigest &&
    pending.flowDigest !== callbackDigest
  )
    return { kind: "ignored" };
  const context = pending ? pendingRecoveryContext(pending) : attempt!;
  traceChatAuthRecovery("callback", { ...context, callbackDigest });
  const fail = (
    reason: "missing_pending" | "expired" | "flow_mismatch" | "server_mismatch",
  ) => {
    recordChatAuthRecoveryFailure(reason, { ...context, callbackDigest });
    if (
      pending &&
      pending.phase !== "resuming" &&
      pending.phase !== "cancelling"
    )
      writePending({
        ...pending,
        phase: "cancelled",
        cancellationMessage: CHAT_AUTH_RECOVERY_MESSAGE,
      });
    return { kind: "failed" as const, message: CHAT_AUTH_RECOVERY_MESSAGE };
  };
  if (!pending) return fail("missing_pending");
  if (pending.serverName !== serverName) return fail("server_mismatch");
  if (pending.phase !== "awaiting_oauth") return { kind: "ignored" };
  if (pending.event.expiresAt <= Date.now()) return fail("expired");
  if (
    (pending.flowDigest || callbackDigest) &&
    pending.flowDigest !== callbackDigest
  )
    return fail("flow_mismatch");
  const settled = settleStepUpCredential(
    pending.credentialBinding,
    callbackCredentialId,
  );
  const result = writePending({
    ...pending,
    phase: settled.outcome === "replay" ? "ready" : "cancelled",
    ...(settled.outcome === "replay"
      ? {}
      : { cancellationMessage: settled.message }),
  });
  if (!result.ok)
    return { kind: "failed", message: CHAT_AUTH_RECOVERY_MESSAGE };
  return settled.outcome === "replay"
    ? { kind: "ready" }
    : { kind: "failed", message: settled.message };
}
export function markPendingChatScopeStepUpReady(
  serverName: string,
  continuationId?: string,
): boolean {
  const pending = readPendingChatScopeStepUp({ serverName, continuationId });
  return pending && !pending.resumeAttempted && !pending.cancelAttempted
    ? writePending({ ...pending, phase: "ready" }).ok
    : false;
}
export function cancelPendingChatScopeStepUp(
  serverName?: string,
  continuationId?: string,
): void {
  const pending = readPendingChatScopeStepUp({ serverName, continuationId });
  if (pending) clearPendingChatScopeStepUp(pending.event.continuationId);
}
export function markPendingChatScopeStepUpCancelled(
  serverName?: string,
  message = "Authorization was not completed.",
  continuationId?: string,
): boolean {
  const pending = readPendingChatScopeStepUp({ serverName, continuationId });
  return pending && !pending.cancelAttempted && pending.phase !== "cancelling"
    ? writePending({
        ...pending,
        phase: "cancelled",
        cancellationMessage: message,
      }).ok
    : false;
}
function claim(
  chatSessionId: string,
  phase: "ready" | "cancelled",
  continuationId?: string,
): PendingChatScopeStepUp | undefined {
  const pending = listPendingChatScopeStepUps({
    chatSessionId,
    continuationId,
    phases: [phase],
  })[0];
  if (
    !pending ||
    (phase === "ready" ? pending.resumeAttempted : pending.cancelAttempted)
  )
    return undefined;
  return writePending({
    ...pending,
    phase: phase === "ready" ? "resuming" : "cancelling",
    ...(phase === "ready"
      ? { resumeAttempted: true }
      : { cancelAttempted: true }),
  }).ok
    ? pending
    : undefined;
}
export function claimPendingChatScopeStepUp(
  chatSessionId: string,
  continuationId?: string,
) {
  return claim(chatSessionId, "ready", continuationId);
}
export function claimCancelledChatScopeStepUp(
  chatSessionId: string,
  continuationId?: string,
) {
  return claim(chatSessionId, "cancelled", continuationId);
}
export function clearPendingChatScopeStepUp(continuationId: string): void {
  const pending = readPendingChatScopeStepUp({ continuationId });
  if (
    !storeEntries(
      readAll().filter((item) => item.event.continuationId !== continuationId),
    )
  ) {
    if (pending)
      recordChatAuthRecoveryFailure("save_failed", {
        ...pendingRecoveryContext(pending),
        storageOutcome: "cleanup_failed",
      });
    return;
  }
  storeAttempts(
    readChatAuthAttempts().filter(
      (item) => item.continuationId !== continuationId,
    ),
  );
  if (pending)
    traceChatAuthRecovery("cleanup", pendingRecoveryContext(pending));
  changed();
}

export function cancelPendingChatScopeStepUpForCallback(
  serverName: string | undefined,
  message: string,
  callbackDigest?: string,
  continuationId?: string,
): boolean {
  const attempt = continuationId
    ? readChatAuthAttempts().find(
        (item) => item.continuationId === continuationId,
      )
    : readChatAuthAttempts().find(
        (item) => callbackDigest && item.flowDigest === callbackDigest,
      );
  const id = continuationId ?? attempt?.continuationId;
  if (!id || !callbackDigest || isStaleChatAuthCallback(id, callbackDigest)) return false;
  return markPendingChatScopeStepUpCancelled(serverName, message, id);
}
