import {
  isScopeStepUpRequiredEvent,
  type ScopeStepUpRequiredEvent,
} from "@/shared/scope-step-up";

const PENDING_SCOPE_STEP_UP_KEY = "mcp-scope-step-up-chat-v1";

export type PendingChatScopeStepUp = {
  version: 1;
  phase: "awaiting_oauth" | "ready" | "cancelled" | "resuming";
  event: ScopeStepUpRequiredEvent;
  serverName: string;
  chatSessionId: string;
  returnPath: string;
  createdAt: number;
  cancellationMessage?: string;
};

function isPendingChatScopeStepUp(
  value: unknown
): value is PendingChatScopeStepUp {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingChatScopeStepUp>;
  return (
    candidate.version === 1 &&
    (candidate.phase === "awaiting_oauth" ||
      candidate.phase === "ready" ||
      candidate.phase === "cancelled" ||
      candidate.phase === "resuming") &&
    typeof candidate.serverName === "string" &&
    typeof candidate.chatSessionId === "string" &&
    typeof candidate.returnPath === "string" &&
    typeof candidate.createdAt === "number" &&
    (candidate.cancellationMessage === undefined ||
      typeof candidate.cancellationMessage === "string") &&
    isScopeStepUpRequiredEvent(candidate.event)
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
  event: ScopeStepUpRequiredEvent;
  serverName: string;
  chatSessionId: string;
}): void {
  writePending({
    version: 1,
    phase: "awaiting_oauth",
    event: input.event,
    serverName: input.serverName,
    chatSessionId: input.chatSessionId,
    returnPath:
      window.location.pathname + window.location.search + window.location.hash,
    createdAt: Date.now(),
  });
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
