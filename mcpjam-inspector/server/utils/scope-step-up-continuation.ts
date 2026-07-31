import { createHash, randomUUID } from "node:crypto";
import {
  SCOPE_STEP_UP_LIVE_TTL_MS,
  SCOPE_STEP_UP_SUSPEND_CODE,
  SCOPE_STEP_UP_VERSION,
  type ScopeStepUpRequiredEvent,
} from "@/shared/scope-step-up";
import type { InsufficientScopeInfo } from "../routes/web/hosted-elicitation.js";

export type ScopeStepUpContinuationStatus =
  | "pending"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "indeterminate";

type StoredScopeStepUpContinuation = {
  continuationId: string;
  bindingKey: string;
  serverId: string;
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
  terminalReason?: string;
};

export type ClaimedScopeStepUpContinuation = Readonly<{
  continuationId: string;
  bindingKey: string;
  serverId: string;
  resourceUrl?: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  inputHash: string;
  challenge: InsufficientScopeInfo;
  expiresAt: number;
}>;

const localContinuations = new Map<string, StoredScopeStepUpContinuation>();

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
  record: StoredScopeStepUpContinuation
): StoredScopeStepUpContinuation {
  if (
    (record.status === "pending" || record.status === "retrying") &&
    record.expiresAt <= Date.now()
  ) {
    record.status = "expired";
    record.input = undefined;
    record.inputPresent = false;
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
  record.terminalReason = reason;
  const timer = setTimeout(() => {
    if (localContinuations.get(record.continuationId) === record) {
      localContinuations.delete(record.continuationId);
    }
  }, SCOPE_STEP_UP_LIVE_TTL_MS);
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

export function isScopeStepUpSuspendSignal(
  value: unknown
): value is ScopeStepUpSuspendSignal {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { code?: unknown }).code === SCOPE_STEP_UP_SUSPEND_CODE
  );
}

export function createLocalScopeStepUpContinuation(input: {
  bindingKey: string;
  serverId: string;
  resourceUrl?: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  challenge: InsufficientScopeInfo;
  serverName?: string;
}): ScopeStepUpRequiredEvent {
  const continuationId = randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + SCOPE_STEP_UP_LIVE_TTL_MS;
  localContinuations.set(continuationId, {
    continuationId,
    bindingKey: input.bindingKey,
    serverId: input.serverId,
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
  return {
    version: SCOPE_STEP_UP_VERSION,
    kind: "scope_step_up_required",
    continuationId,
    serverId: input.serverId,
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
    serverId: record.serverId,
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
}): { serverId: string; toolName: string } {
  const record = localContinuations.get(input.continuationId);
  if (!record) throw new Error("scope_step_up_continuation_not_found");
  expireIfNeeded(record);
  if (
    record.bindingKey !== input.bindingKey ||
    record.toolCallId !== input.toolCallId
  ) {
    throw new Error("scope_step_up_continuation_not_found");
  }
  if (record.status !== "pending") {
    throw new Error(`scope_step_up_continuation_${record.status}`);
  }
  const toolName = record.toolName;
  const serverId = record.serverId;
  scrubTerminal(record, "cancelled", input.reason);
  return { serverId, toolName };
}

export function __resetLocalScopeStepUpContinuationsForTests(): void {
  localContinuations.clear();
}
