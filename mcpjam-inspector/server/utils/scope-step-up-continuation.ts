import { createHash, randomUUID } from "node:crypto";
import {
  SCOPE_STEP_UP_LIVE_TTL_MS,
  SCOPE_STEP_UP_SUSPEND_CODE,
  SCOPE_STEP_UP_VERSION,
  type ScopeStepUpRequiredEvent,
} from "@/shared/scope-step-up";
import {
  AUTH_CHALLENGE_REASON,
  type AuthRequiredEvent,
} from "@/shared/auth-challenge";
import type { InsufficientScopeInfo } from "../routes/web/hosted-elicitation.js";

export type ScopeStepUpContinuationStatus =
  | "pending"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "indeterminate";

/**
 * Why a call was suspended. Absent is the original 403 `insufficient_scope`
 * step-up; `authorization_required` is a mid-session sign-in (a 401, or a
 * honored `_meta` challenge). The reason picks the model-facing copy and which
 * history settlement applies; the replay machinery is the same.
 */
export type ContinuationReason = typeof AUTH_CHALLENGE_REASON;

type StoredScopeStepUpContinuation = {
  continuationId: string;
  bindingKey: string;
  reason?: ContinuationReason;
  serverId: string;
  serverName?: string;
  connectionId?: string;
  resourceUrl?: string;
  toolCallId: string;
  toolName: string;
  inputPresent: boolean;
  input?: unknown;
  inputHash: string;
  challenge: InsufficientScopeInfo;
  status: ScopeStepUpContinuationStatus;
  wireStartedAt?: number;
  createdAt: number;
  expiresAt: number;
  /** When the record left `pending` / `retrying`. */
  settledAt?: number;
  terminalReason?: string;
};

export type ClaimedScopeStepUpContinuation = Readonly<{
  continuationId: string;
  bindingKey: string;
  reason?: ContinuationReason;
  serverId: string;
  serverName?: string;
  connectionId?: string;
  resourceUrl?: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  inputHash: string;
  challenge: InsufficientScopeInfo;
  expiresAt: number;
}>;

const localContinuations = new Map<string, StoredScopeStepUpContinuation>();

/**
 * How long a settled sign-in record outlives its window. Its input is already
 * gone; what is kept is the fact that the call was suspended, so a later turn
 * that resends the still-unresolved call answers it with the sign-in copy
 * instead of failing on a missing tool result.
 */
export const AUTH_CHALLENGE_TOMBSTONE_TTL_MS = 60 * 60_000;

/** How often the sweeper looks for expired windows. */
export const LOCAL_CONTINUATION_SWEEP_INTERVAL_MS = 30_000;

let sweeper: ReturnType<typeof setInterval> | undefined;

function tombstoneTtl(record: StoredScopeStepUpContinuation): number {
  return record.reason === AUTH_CHALLENGE_REASON
    ? AUTH_CHALLENGE_TOMBSTONE_TTL_MS
    : SCOPE_STEP_UP_LIVE_TTL_MS;
}

/**
 * Expire every window that ran out, clearing its saved input, and drop
 * tombstones past their retention. Expiry otherwise happens only when someone
 * claims the record, so an abandoned sign-in would keep the call's arguments
 * in memory until the process exits.
 */
export function sweepLocalScopeStepUpContinuations(now = Date.now()): void {
  for (const [continuationId, record] of localContinuations) {
    expireIfNeeded(record, now);
    if (
      record.status !== "pending" &&
      record.status !== "retrying" &&
      (record.settledAt ?? record.expiresAt) + tombstoneTtl(record) <= now
    ) {
      localContinuations.delete(continuationId);
    }
  }
  if (localContinuations.size === 0) stopSweeper();
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(
    () => sweepLocalScopeStepUpContinuations(),
    LOCAL_CONTINUATION_SWEEP_INTERVAL_MS
  );
  sweeper.unref?.();
}

function stopSweeper(): void {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function scopeStepUpInputHash(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("base64url");
}

function expireIfNeeded(
  record: StoredScopeStepUpContinuation,
  now = Date.now()
): StoredScopeStepUpContinuation {
  if (
    (record.status === "pending" || record.status === "retrying") &&
    record.expiresAt <= now
  ) {
    record.status = "expired";
    record.input = undefined;
    record.inputPresent = false;
    record.settledAt = now;
    record.terminalReason = "continuation expired";
  }
  return record;
}

function scrubTerminal(
  record: StoredScopeStepUpContinuation,
  status: Exclude<ScopeStepUpContinuationStatus, "pending" | "retrying">,
  reason?: string
): void {
  record.status = status;
  record.input = undefined;
  record.inputPresent = false;
  record.settledAt = Date.now();
  record.terminalReason = reason;
  const timer = setTimeout(() => {
    if (localContinuations.get(record.continuationId) === record) {
      localContinuations.delete(record.continuationId);
    }
  }, tombstoneTtl(record));
  timer.unref?.();
}

export class ScopeStepUpSuspendSignal extends Error {
  readonly code = SCOPE_STEP_UP_SUSPEND_CODE;
  readonly event: ScopeStepUpRequiredEvent;

  constructor(event: ScopeStepUpRequiredEvent) {
    super("MCP tool call suspended for scope step-up authorization");
    this.name = "ScopeStepUpSuspendSignal";
    this.event = event;
  }
}

/**
 * The mid-session sign-in counterpart of {@link ScopeStepUpSuspendSignal}. It
 * carries the same code, so every engine that pauses on a step-up pauses on a
 * sign-in the same way, without learning a second signal.
 */
export class AuthChallengeSuspendSignal extends Error {
  readonly code = SCOPE_STEP_UP_SUSPEND_CODE;
  readonly event: AuthRequiredEvent;

  constructor(event: AuthRequiredEvent) {
    super("MCP tool call suspended for sign-in");
    this.name = "AuthChallengeSuspendSignal";
    this.event = event;
  }
}

export function isScopeStepUpSuspendSignal(
  value: unknown
): value is ScopeStepUpSuspendSignal {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { code?: unknown }).code === SCOPE_STEP_UP_SUSPEND_CODE
  );
}

function storeLocalContinuation(input: {
  bindingKey: string;
  reason?: ContinuationReason;
  serverId: string;
  serverName?: string;
  connectionId?: string;
  resourceUrl?: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  challenge: InsufficientScopeInfo;
}): { continuationId: string; expiresAt: number } {
  const continuationId = randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + SCOPE_STEP_UP_LIVE_TTL_MS;
  localContinuations.set(continuationId, {
    continuationId,
    bindingKey: input.bindingKey,
    ...(input.reason ? { reason: input.reason } : {}),
    serverId: input.serverId,
    ...(input.serverName ? { serverName: input.serverName } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.resourceUrl ? { resourceUrl: input.resourceUrl } : {}),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    inputPresent: true,
    input: input.toolInput,
    inputHash: scopeStepUpInputHash(input.toolInput),
    challenge: input.challenge,
    status: "pending",
    createdAt,
    expiresAt,
  });
  startSweeper();
  return { continuationId, expiresAt };
}

export function createLocalScopeStepUpContinuation(input: {
  bindingKey: string;
  serverId: string;
  connectionId?: string;
  resourceUrl?: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  challenge: InsufficientScopeInfo;
  serverName?: string;
}): ScopeStepUpRequiredEvent {
  const { continuationId, expiresAt } = storeLocalContinuation({
    bindingKey: input.bindingKey,
    serverId: input.serverId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.resourceUrl ? { resourceUrl: input.resourceUrl } : {}),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    toolInput: input.toolInput,
    challenge: input.challenge,
  });
  return {
    version: SCOPE_STEP_UP_VERSION,
    kind: "scope_step_up_required",
    continuationId,
    serverId: input.serverId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.serverName ? { serverName: input.serverName } : {}),
    toolCallId: input.toolCallId,
    operation: { method: "tools/call", operation: input.toolName },
    ...(input.challenge.requiredScope
      ? { requiredScope: input.challenge.requiredScope }
      : {}),
    ...(input.challenge.resourceMetadataUrl
      ? { resourceMetadataUrl: input.challenge.resourceMetadataUrl }
      : {}),
    ...(input.challenge.errorDescription
      ? { errorDescription: input.challenge.errorDescription }
      : {}),
    expiresAt,
  };
}

/**
 * Save a call that a mid-session sign-in suspended. Same window, binding and
 * single-claim rules as a step-up; the caller builds the `data-auth-required`
 * event from the returned handle.
 */
export function createLocalAuthChallengeContinuation(input: {
  bindingKey: string;
  serverId: string;
  serverName?: string;
  connectionId?: string;
  resourceUrl?: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  challenge: InsufficientScopeInfo;
}): { continuationId: string; expiresAt: number } {
  return storeLocalContinuation({ ...input, reason: AUTH_CHALLENGE_REASON });
}

export function claimLocalScopeStepUpContinuation(input: {
  continuationId: string;
  toolCallId: string;
  bindingKey: string;
}): ClaimedScopeStepUpContinuation {
  const record = localContinuations.get(input.continuationId);
  if (!record) throw new Error("scope_step_up_continuation_not_found");
  expireIfNeeded(record);
  if (
    record.bindingKey !== input.bindingKey ||
    record.toolCallId !== input.toolCallId
  ) {
    throw new Error("scope_step_up_continuation_not_found");
  }
  if (record.status === "retrying") {
    throw new Error("scope_step_up_retry_in_progress");
  }
  if (record.status !== "pending" || !record.inputPresent) {
    throw new Error(`scope_step_up_continuation_${record.status}`);
  }
  record.status = "retrying";
  return {
    continuationId: record.continuationId,
    bindingKey: record.bindingKey,
    ...(record.reason ? { reason: record.reason } : {}),
    serverId: record.serverId,
    ...(record.serverName ? { serverName: record.serverName } : {}),
    ...(record.connectionId ? { connectionId: record.connectionId } : {}),
    ...(record.resourceUrl ? { resourceUrl: record.resourceUrl } : {}),
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    input: record.input,
    inputHash: record.inputHash,
    challenge: record.challenge,
    expiresAt: record.expiresAt,
  };
}

export function markLocalScopeStepUpWireStarted(continuationId: string): void {
  const record = localContinuations.get(continuationId);
  if (!record || record.status !== "retrying") {
    throw new Error("scope_step_up_continuation_not_retrying");
  }
  record.wireStartedAt = Date.now();
}

export function completeLocalScopeStepUpContinuation(
  continuationId: string
): void {
  const record = localContinuations.get(continuationId);
  if (!record) return;
  scrubTerminal(record, "completed");
}

export function failLocalScopeStepUpContinuation(
  continuationId: string,
  reason: string
): void {
  const record = localContinuations.get(continuationId);
  if (!record) return;
  scrubTerminal(record, "failed", reason);
}

export function cancelLocalScopeStepUpContinuation(
  continuationId: string,
  reason: string
): void {
  const record = localContinuations.get(continuationId);
  if (!record) return;
  if (record.status === "retrying" && record.wireStartedAt !== undefined) {
    scrubTerminal(record, "indeterminate", reason);
    return;
  }
  scrubTerminal(record, "cancelled", reason);
}

export function cancelLocalScopeStepUpContinuationForRequest(input: {
  continuationId: string;
  toolCallId: string;
  bindingKey: string;
  reason: string;
}): {
  serverId: string;
  serverName?: string;
  toolName: string;
  reason?: ContinuationReason;
} {
  const record = localContinuations.get(input.continuationId);
  if (!record) throw new Error("scope_step_up_continuation_not_found");
  expireIfNeeded(record);
  if (
    record.bindingKey !== input.bindingKey ||
    record.toolCallId !== input.toolCallId
  ) {
    throw new Error("scope_step_up_continuation_not_found");
  }
  const settled = {
    serverId: record.serverId,
    ...(record.serverName ? { serverName: record.serverName } : {}),
    toolName: record.toolName,
    ...(record.reason ? { reason: record.reason } : {}),
  };
  // An unanswered sign-in whose window ran out is still answered: the user
  // moved on without signing in, and the call it saved must not stay
  // unresolved in the conversation.
  if (
    record.reason === AUTH_CHALLENGE_REASON &&
    record.status === "expired"
  ) {
    return settled;
  }
  if (record.status !== "pending") {
    throw new Error(`scope_step_up_continuation_${record.status}`);
  }
  scrubTerminal(record, "cancelled", input.reason);
  return settled;
}

/**
 * History settlement for a mid-session sign-in. A conversation can
 * come back with the suspended call still unresolved: the user sent another
 * message instead of clicking Connect. Such a call is answered, never run,
 * when its sign-in is still pending (cancelled here) or already expired.
 *
 * Only `authorization_required` records answer; a step-up keeps its own
 * handling. Returns `undefined` for any call this conversation did not
 * suspend for sign-in.
 */
export function settleLocalAuthChallengeHistoryCall(input: {
  bindingKey: string;
  toolCallId: string;
}): { serverId: string; serverName?: string; toolName: string } | undefined {
  for (const record of localContinuations.values()) {
    if (
      record.reason !== AUTH_CHALLENGE_REASON ||
      record.bindingKey !== input.bindingKey ||
      record.toolCallId !== input.toolCallId
    ) {
      continue;
    }
    expireIfNeeded(record);
    if (record.status === "pending") {
      scrubTerminal(
        record,
        "cancelled",
        "the user continued without signing in"
      );
    } else if (record.status !== "expired" && record.status !== "cancelled") {
      return undefined;
    }
    return {
      serverId: record.serverId,
      ...(record.serverName ? { serverName: record.serverName } : {}),
      toolName: record.toolName,
    };
  }
  return undefined;
}

/**
 * A cancel the client spliced into the user's next message: the user
 * moved on instead of signing in. Cancels the continuation when it is still
 * waiting, and reports what it knew about the call so the route can answer it
 * with the right copy. Never throws: an unknown, expired or already settled
 * continuation must not cost the user their message.
 */
export function cancelLocalContinuationForNewMessage(input: {
  continuationId: string;
  toolCallId: string;
  bindingKey: string;
}): {
  found: boolean;
  cancelled: boolean;
  reason?: ContinuationReason;
  serverId?: string;
  serverName?: string;
  toolName?: string;
} {
  const record = localContinuations.get(input.continuationId);
  if (
    !record ||
    record.bindingKey !== input.bindingKey ||
    record.toolCallId !== input.toolCallId
  ) {
    return { found: false, cancelled: false };
  }
  expireIfNeeded(record);
  const cancelled = record.status === "pending";
  if (cancelled) {
    scrubTerminal(
      record,
      "cancelled",
      "the user sent a new message instead of signing in"
    );
  }
  return {
    found: true,
    cancelled,
    ...(record.reason ? { reason: record.reason } : {}),
    serverId: record.serverId,
    ...(record.serverName ? { serverName: record.serverName } : {}),
    toolName: record.toolName,
  };
}

/** The terminal reason of a sign-in whose replay was refused again. */
export const AUTH_CHALLENGE_REPEATED_REASON =
  "authorization_required repeated after sign-in";

/**
 * Whether this conversation just completed a sign-in for the same operation.
 * A challenge right after one is permanent: it is answered with the
 * repeat copy instead of another Connect card.
 */
export function hasRecentLocalAuthSignIn(input: {
  bindingKey: string;
  serverId: string;
  toolName: string;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  for (const record of localContinuations.values()) {
    if (
      record.reason === AUTH_CHALLENGE_REASON &&
      record.bindingKey === input.bindingKey &&
      record.serverId === input.serverId &&
      record.toolName === input.toolName &&
      (record.status === "completed" ||
        (record.status === "failed" &&
          record.terminalReason === AUTH_CHALLENGE_REPEATED_REASON)) &&
      (record.settledAt ?? 0) + SCOPE_STEP_UP_LIVE_TTL_MS > now
    ) {
      return true;
    }
  }
  return false;
}

export function __peekLocalScopeStepUpContinuationForTests(
  continuationId: string
):
  | Readonly<{ status: ScopeStepUpContinuationStatus; inputPresent: boolean }>
  | undefined {
  const record = localContinuations.get(continuationId);
  return record
    ? { status: record.status, inputPresent: record.inputPresent }
    : undefined;
}

export function __resetLocalScopeStepUpContinuationsForTests(): void {
  localContinuations.clear();
  stopSweeper();
}
