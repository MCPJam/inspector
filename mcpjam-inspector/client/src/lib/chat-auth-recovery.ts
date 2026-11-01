import { useMemo, useSyncExternalStore } from "react";
import { captureSentryMessage } from "@/lib/sentry";

export const CHAT_AUTH_RECOVERY_MESSAGE =
  "MCPJam couldn’t continue this call after sign-in. Please try again.";
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

/** Persist before dispatch; unavailable storage must never allow a repeated cancellation. */
export function claimMissingCallCancellation(continuationId: string): boolean {
  const key = "mcp-chat-auth-cancel-v1:" + continuationId;
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "attempted");
    return sessionStorage.getItem(key) === "attempted";
  } catch {
    return false;
  }
}
