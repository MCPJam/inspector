import { useMemo, useSyncExternalStore } from "react";
import { captureSentryMessage } from "@/lib/sentry";

export const CHAT_AUTH_RECOVERY_MESSAGE =
  "Could not retry the call after sign-in. Run it again.";
/** A sign-in card whose window ran out before the user finished signing in. */
export const AUTH_CHALLENGE_EXPIRED_MESSAGE =
  "This call expired. Sign in and run it again.";
const KEY = "mcp-chat-auth-recovery-v1";
export type RecoveryReason =
  | "comparison_restore_failed"
  | "save_failed"
  | "missing_pending"
  | "invalid_pending"
  | "missing_continuation"
  | "server_missing"
  | "flow_mismatch"
  | "server_mismatch"
  | "expired"
  | "resume_failed"
  | "resume_incomplete"
  | "cancel_failed"
  | "resume_interrupted";
export interface RecoveryContext {
  continuationId?: string;
  toolCallId?: string;
  chatSessionId?: string;
  projectId?: string | null;
  serverId?: string;
  serverName?: string;
  phase?: string;
  flowDigest?: string;
  callbackDigest?: string;
  storageOutcome?: string;
  recoveryResult?: string;
}
export interface ChatAuthRecoveryFailure extends RecoveryContext {
  id: string;
  reason: RecoveryReason;
  timestamp: number;
  dismissed?: boolean;
}

/**
 * What the user reads for a failed sign-in recovery. A card that expired
 * while still waiting for the user (no click, or a sign-in left unfinished)
 * says so; "could not retry after sign-in" would claim a sign-in that never
 * happened. Every other failure, including one that expired after the user
 * signed in, keeps the retry copy.
 */
export function chatAuthRecoveryFailureMessage(
  failure: Pick<ChatAuthRecoveryFailure, "reason" | "phase">,
): string {
  return failure.reason === "expired" &&
    (failure.phase === "awaiting_click" || failure.phase === "awaiting_oauth")
    ? AUTH_CHALLENGE_EXPIRED_MESSAGE
    : CHAT_AUTH_RECOVERY_MESSAGE;
}
interface RecoveryState {
  history: Array<RecoveryContext & { stage: string; timestamp: number }>;
  failures: ChatAuthRecoveryFailure[];
  reported: string[];
}
let fallback: string | undefined;
const listeners = new Set<() => void>();
export function subscribeChatAuthRecovery(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function snapshot(): string {
  try {
    return fallback ?? sessionStorage.getItem(KEY) ?? "";
  } catch {
    return fallback ?? "";
  }
}
function read(): RecoveryState {
  try {
    const value = JSON.parse(snapshot());
    if (
      Array.isArray(value.history) &&
      Array.isArray(value.failures) &&
      Array.isArray(value.reported)
    ) {
      return {
        history: value.history
          .filter((item: unknown) => item && typeof item === "object")
          .slice(-80)
          .map(
            (item: RecoveryContext & { stage: string; timestamp: number }) => ({
              ...safe(item),
              stage: String(item.stage).slice(0, 40),
              timestamp: Number(item.timestamp),
            }),
          ),
        failures: value.failures
          .filter(
            (item: ChatAuthRecoveryFailure) =>
              item &&
              typeof item.id === "string" &&
              typeof item.reason === "string",
          )
          .slice(-MAX_FAILURES)
          .map((item: ChatAuthRecoveryFailure) => ({
            ...safe(item),
            id: item.id,
            reason: item.reason,
            timestamp: item.timestamp,
            dismissed: item.dismissed === true,
          })),
        reported: value.reported
          .filter((item: unknown) => typeof item === "string")
          .slice(-200),
      };
    }
  } catch {
    /* A broken diagnostic record must not break recovery. */
  }
  return { history: [], failures: [], reported: [] };
}
function write(value: RecoveryState): void {
  const raw = JSON.stringify(value);
  try {
    sessionStorage.setItem(KEY, raw);
    fallback = undefined;
  } catch {
    fallback = raw;
  }
  listeners.forEach((listener) => listener());
}
/** Explicit allowlist: never serialize the event, error, URL, or tool arguments. */
function safe(context: RecoveryContext): RecoveryContext {
  const result: RecoveryContext = {};
  for (const key of [
    "continuationId",
    "toolCallId",
    "chatSessionId",
    "projectId",
    "serverId",
    "serverName",
    "phase",
    "storageOutcome",
    "recoveryResult",
  ] as const) {
    const value = context[key];
    if (typeof value === "string") result[key] = value.slice(0, 160);
  }
  if (context.flowDigest) result.flowDigest = context.flowDigest.slice(0, 8);
  if (context.callbackDigest)
    result.callbackDigest = context.callbackDigest.slice(0, 8);
  return result;
}
const MAX_FAILURES = 50;
export function traceChatAuthRecovery(
  stage: string,
  context: RecoveryContext,
): void {
  const state = read();
  state.history = [
    ...state.history,
    { ...safe(context), stage, timestamp: Date.now() },
  ].slice(-80);
  write(state);
}
export function recordChatAuthRecoveryFailure(
  reason: RecoveryReason,
  context: RecoveryContext,
  options: { report?: boolean } = {},
): void {
  const state = read();
  const details = safe({
    storageOutcome: "not_checked",
    recoveryResult: "failed",
    ...context,
  });
  const id = JSON.stringify([
    context.continuationId ??
      context.toolCallId ??
      context.chatSessionId ??
      "unknown",
    reason,
  ]);
  const failure = { ...details, id, reason, timestamp: Date.now() };
  // Bounded like `history`; a dismissed entry ages out instead of being
  // dropped, so it cannot show again while it is still recent.
  if (!state.failures.some((item) => item.id === id))
    state.failures = [...state.failures, failure].slice(-MAX_FAILURES);
  const report = options.report !== false && !state.reported.includes(id);
  if (report) state.reported = [...state.reported, id].slice(-200);
  write(state);
  if (!report) return;
  try {
    captureSentryMessage(CHAT_AUTH_RECOVERY_MESSAGE, {
      level: "error",
      tags: { source: "chat_auth_resume", origin: "mcpjam", reason },
      fingerprint: ["chat_auth_resume", reason],
      extra: {
        ...failure,
        appVersion:
          typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown",
        history: state.history,
      },
    });
  } catch {
    /* Telemetry must never prevent the user from recovering. */
  }
}
export function clearChatAuthRecoveryFailure(toolCallId: string): void {
  const state = read();
  if (!state.failures.some((item) => item.toolCallId === toolCallId)) return;
  state.failures = state.failures.filter(
    (item) => item.toolCallId !== toolCallId,
  );
  write(state);
}
export function dismissChatAuthRecoveryFailure(id: string): void {
  const state = read();
  state.failures = state.failures.map((item) =>
    item.id === id ? { ...item, dismissed: true } : item,
  );
  write(state);
}
export function useChatAuthRecoveryFailures(): ChatAuthRecoveryFailure[] {
  const raw = useSyncExternalStore(
    subscribeChatAuthRecovery,
    snapshot,
    () => "",
  );
  return useMemo(() => read().failures, [raw]);
}

const CANCEL_KEY = "mcp-chat-auth-cancel-v1";
// Same bound as `reported`. A claim outlives the call it cancels by far: a
// waiting call expires within minutes, long before 200 newer ones are claimed.
const MAX_CANCEL_CLAIMS = 200;
function readCancelClaims(): string[] {
  const value: unknown = JSON.parse(sessionStorage.getItem(CANCEL_KEY) ?? "[]");
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
/** Persist before dispatch; unavailable storage must never allow a repeated cancellation. */
export function claimMissingCallCancellation(continuationId: string): boolean {
  try {
    const claims = readCancelClaims();
    if (claims.includes(continuationId)) return false;
    sessionStorage.setItem(
      CANCEL_KEY,
      JSON.stringify([...claims, continuationId].slice(-MAX_CANCEL_CLAIMS)),
    );
    return readCancelClaims().includes(continuationId);
  } catch {
    return false;
  }
}
