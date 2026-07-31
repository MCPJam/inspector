/**
 * Shared SEP-2350 step-up identities and chat wire contract.
 *
 * The July 2026 flow bounds retries for the same protected resource and
 * operation. Display names and authorization-server issuers are deliberately
 * absent from the identity: one server may expose more than one resource, and
 * one issuer may authorize many unrelated operations.
 */

export const SCOPE_STEP_UP_VERSION = 1;
export const SCOPE_STEP_UP_DATA_PART_TYPE =
  "data-scope-step-up-required" as const;
export const SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE =
  "data-scope-step-up-finished" as const;
export const SCOPE_STEP_UP_LIVE_TTL_MS = 10 * 60_000;
export const SCOPE_STEP_UP_SUSPEND_CODE =
  "MCPJAM_SCOPE_STEP_UP_SUSPEND" as const;

export type StepUpOperationMethod =
  | "tools/call"
  | "resources/read"
  | "prompts/get";

export interface StepUpOperationKey {
  /** Canonical protected-resource URL (normally the MCP server URL). */
  resourceUrl: string;
  method: StepUpOperationMethod;
  /** Tool name, prompt name, or canonical resource URI. */
  operation: string;
}

export function canonicalizeStepUpResourceUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

export function normalizeStepUpOperationKey(
  key: StepUpOperationKey
): StepUpOperationKey {
  return {
    resourceUrl: canonicalizeStepUpResourceUrl(key.resourceUrl),
    method: key.method,
    operation: key.operation.trim(),
  };
}

/** Stable, non-secret serialization used only as a browser-session map key. */
export function serializeStepUpOperationKey(key: StepUpOperationKey): string {
  const normalized = normalizeStepUpOperationKey(key);
  return JSON.stringify([
    normalized.resourceUrl,
    normalized.method,
    normalized.operation,
  ]);
}

export interface ScopeStepUpRequiredEvent {
  version: typeof SCOPE_STEP_UP_VERSION;
  kind: "scope_step_up_required";
  continuationId: string;
  serverId: string;
  serverName?: string;
  toolCallId: string;
  operation: Omit<StepUpOperationKey, "resourceUrl">;
  requiredScope?: string;
  resourceMetadataUrl?: string;
  errorDescription?: string;
  expiresAt: number;
}

export interface ScopeStepUpDataPart {
  type: typeof SCOPE_STEP_UP_DATA_PART_TYPE;
  data: ScopeStepUpRequiredEvent;
}

export interface ScopeStepUpFinishedEvent {
  version: typeof SCOPE_STEP_UP_VERSION;
  continuationId: string;
  serverId: string;
  operation: Omit<StepUpOperationKey, "resourceUrl">;
  outcome: "completed" | "cancelled" | "failed" | "indeterminate";
}

export interface ScopeStepUpFinishedDataPart {
  type: typeof SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE;
  data: ScopeStepUpFinishedEvent;
}

export interface ScopeStepUpResumeRequest {
  continuationId: string;
  toolCallId: string;
}

export interface ScopeStepUpCancelRequest {
  continuationId: string;
  toolCallId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isScopeStepUpRequiredEvent(
  value: unknown
): value is ScopeStepUpRequiredEvent {
  if (!isRecord(value) || !isRecord(value.operation)) return false;
  return (
    value.version === SCOPE_STEP_UP_VERSION &&
    value.kind === "scope_step_up_required" &&
    typeof value.continuationId === "string" &&
    typeof value.serverId === "string" &&
    typeof value.toolCallId === "string" &&
    (value.operation.method === "tools/call" ||
      value.operation.method === "resources/read" ||
      value.operation.method === "prompts/get") &&
    typeof value.operation.operation === "string" &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    (value.serverName === undefined || typeof value.serverName === "string") &&
    (value.requiredScope === undefined ||
      typeof value.requiredScope === "string") &&
    (value.resourceMetadataUrl === undefined ||
      typeof value.resourceMetadataUrl === "string") &&
    (value.errorDescription === undefined ||
      typeof value.errorDescription === "string") &&
    (typeof value.requiredScope === "string" ||
      typeof value.resourceMetadataUrl === "string")
  );
}

export function isScopeStepUpDataPart(
  value: unknown
): value is ScopeStepUpDataPart {
  return (
    isRecord(value) &&
    value.type === SCOPE_STEP_UP_DATA_PART_TYPE &&
    isScopeStepUpRequiredEvent(value.data)
  );
}

export function isScopeStepUpFinishedDataPart(
  value: unknown
): value is ScopeStepUpFinishedDataPart {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  const data = value.data;
  return (
    value.type === SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE &&
    data.version === SCOPE_STEP_UP_VERSION &&
    typeof data.continuationId === "string" &&
    typeof data.serverId === "string" &&
    isRecord(data.operation) &&
    data.operation.method === "tools/call" &&
    typeof data.operation.operation === "string" &&
    (data.outcome === "completed" ||
      data.outcome === "cancelled" ||
      data.outcome === "failed" ||
      data.outcome === "indeterminate")
  );
}

export function parseScopeStepUpResumeRequest(
  value: unknown
): ScopeStepUpResumeRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.continuationId !== "string" ||
    !value.continuationId.trim() ||
    typeof value.toolCallId !== "string" ||
    !value.toolCallId.trim()
  ) {
    return undefined;
  }
  return {
    continuationId: value.continuationId,
    toolCallId: value.toolCallId,
  };
}

export const parseScopeStepUpCancelRequest = parseScopeStepUpResumeRequest as (
  value: unknown
) => ScopeStepUpCancelRequest | undefined;
