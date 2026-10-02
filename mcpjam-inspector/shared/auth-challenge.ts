/**
 * Chat wire contract for mid-session sign-in ("lazy authentication").
 *
 * A server that let the chat connect anonymously refuses one protected tool
 * call and asks the user to sign in. This is a NEW, fail-closed wire, kept
 * apart from the 403 step-up part (`data-scope-step-up-required`):
 *
 *   - `data-auth-required` asks the client to show a Connect card. A client
 *     that predates it does not know the part type and ignores it, so a stale
 *     client can never start a redirect from it. The existing step-up
 *     validator would have accepted an extended step-up part.
 *   - `data-auth-challenge-notice` is display-only. It explains why the
 *     emulated host did not prompt, and NO client code may start OAuth from
 *     it.
 *
 * Every string in these events came from the server under test (length-capped
 * by the SDK parser) and must be rendered as text only.
 */

import type { StepUpOperationKey } from "./scope-step-up";

export const AUTH_CHALLENGE_WIRE_VERSION = 1;
export const AUTH_REQUIRED_DATA_PART_TYPE = "data-auth-required" as const;
export const AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE =
  "data-auth-challenge-notice" as const;

/** The continuation `reason` for a mid-session sign-in. */
export const AUTH_CHALLENGE_REASON = "authorization_required" as const;

/** Where the challenge came from. A 403 step-up keeps its own wire. */
export type AuthRequiredSource = "http_401" | "tool_result_meta";

/** Effective auth methods that may start an interactive sign-in. */
export type AuthRequiredEffectiveAuth = "discover" | "oauth";

export interface AuthRequiredEvent {
  version: typeof AUTH_CHALLENGE_WIRE_VERSION;
  kind: "auth_required";
  /**
   * The suspended call's continuation. Absent when the call cannot resume
   * (a `notify` host, or a hosted turn without a chat session): the card then
   * offers sign-in only, and says to run the tool again.
   */
  continuationId?: string;
  serverId: string;
  serverName?: string;
  /** Hosted: the credential the turn used, when it used one. */
  connectionId?: string;
  toolCallId: string;
  operation: Omit<StepUpOperationKey, "resourceUrl">;
  source: AuthRequiredSource;
  /** Stamped by the server that ran the call (never a browser parse). */
  effectiveAuth: AuthRequiredEffectiveAuth;
  /** Whether the saved call is replayed after sign-in. */
  action: "prompt" | "notify";
  /** The tool declared `readOnlyHint: true`; otherwise the replay asks first. */
  readOnly: boolean;
  requiredScope?: string;
  resourceMetadataUrl?: string;
  errorDescription?: string;
  expiresAt: number;
}

export interface AuthRequiredDataPart {
  type: typeof AUTH_REQUIRED_DATA_PART_TYPE;
  data: AuthRequiredEvent;
}

/** Why a recognized challenge did not prompt (or why prompting is blocked). */
export type AuthChallengeNoticeReason =
  | "honored"
  | "not-honored"
  | "missing-bearer-header"
  | "missing-resource-metadata"
  | "missing-oauth2-scheme"
  | "schemes-unresolved"
  | "missing-error-params"
  /** The policy said prompt, but the server's auth method cannot sign in. */
  | "auth-method-blocked"
  /** A repeat challenge after a completed sign-in for the same call. */
  | "repeat-after-sign-in";

export interface AuthChallengeNoticeEvent {
  version: typeof AUTH_CHALLENGE_WIRE_VERSION;
  kind: "auth_challenge_notice";
  serverId: string;
  serverName?: string;
  toolCallId: string;
  operation: Omit<StepUpOperationKey, "resourceUrl">;
  source: AuthRequiredSource;
  action: "prompt" | "notify" | "passthrough";
  reason: AuthChallengeNoticeReason;
  effectiveAuth?: "discover" | "oauth" | "xaa" | "bearer" | "none";
  /** Developer-only explanation. Never model-visible. Text only. */
  explanation: string;
}

export interface AuthChallengeNoticeDataPart {
  type: typeof AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE;
  data: AuthChallengeNoticeEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOperation(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.method === "tools/call" ||
      value.method === "resources/read" ||
      value.method === "prompts/get") &&
    typeof value.operation === "string" &&
    value.operation.length > 0
  );
}

function isSource(value: unknown): value is AuthRequiredSource {
  return value === "http_401" || value === "tool_result_meta";
}

export function isAuthRequiredEvent(
  value: unknown,
): value is AuthRequiredEvent {
  if (!isRecord(value)) return false;
  return (
    value.version === AUTH_CHALLENGE_WIRE_VERSION &&
    value.kind === "auth_required" &&
    (value.continuationId === undefined ||
      (typeof value.continuationId === "string" &&
        value.continuationId.length > 0)) &&
    typeof value.serverId === "string" &&
    value.serverId.length > 0 &&
    optionalString(value.serverName) &&
    (value.connectionId === undefined ||
      (typeof value.connectionId === "string" &&
        value.connectionId.length > 0)) &&
    typeof value.toolCallId === "string" &&
    value.toolCallId.length > 0 &&
    isOperation(value.operation) &&
    isSource(value.source) &&
    // Fail closed: only the methods that may start a sign-in are accepted.
    (value.effectiveAuth === "discover" || value.effectiveAuth === "oauth") &&
    (value.action === "prompt" || value.action === "notify") &&
    typeof value.readOnly === "boolean" &&
    optionalString(value.requiredScope) &&
    optionalString(value.resourceMetadataUrl) &&
    optionalString(value.errorDescription) &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt)
  );
}

export function isAuthRequiredDataPart(
  value: unknown,
): value is AuthRequiredDataPart {
  return (
    isRecord(value) &&
    value.type === AUTH_REQUIRED_DATA_PART_TYPE &&
    isAuthRequiredEvent(value.data)
  );
}

const NOTICE_REASONS: readonly AuthChallengeNoticeReason[] = [
  "honored",
  "not-honored",
  "missing-bearer-header",
  "missing-resource-metadata",
  "missing-oauth2-scheme",
  "schemes-unresolved",
  "missing-error-params",
  "auth-method-blocked",
  "repeat-after-sign-in",
];

export function isAuthChallengeNoticeEvent(
  value: unknown,
): value is AuthChallengeNoticeEvent {
  if (!isRecord(value)) return false;
  return (
    value.version === AUTH_CHALLENGE_WIRE_VERSION &&
    value.kind === "auth_challenge_notice" &&
    typeof value.serverId === "string" &&
    optionalString(value.serverName) &&
    typeof value.toolCallId === "string" &&
    isOperation(value.operation) &&
    isSource(value.source) &&
    (value.action === "prompt" ||
      value.action === "notify" ||
      value.action === "passthrough") &&
    (NOTICE_REASONS as readonly unknown[]).includes(value.reason) &&
    (value.effectiveAuth === undefined ||
      value.effectiveAuth === "discover" ||
      value.effectiveAuth === "oauth" ||
      value.effectiveAuth === "xaa" ||
      value.effectiveAuth === "bearer" ||
      value.effectiveAuth === "none") &&
    typeof value.explanation === "string"
  );
}

export function isAuthChallengeNoticeDataPart(
  value: unknown,
): value is AuthChallengeNoticeDataPart {
  return (
    isRecord(value) &&
    value.type === AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE &&
    isAuthChallengeNoticeEvent(value.data)
  );
}

/**
 * The tool result the model sees when the user did not sign in (the call was
 * cancelled, or its continuation expired). Reason-aware: a sign-in, not a
 * scope upgrade.
 */
export function authChallengeCancelledText(
  serverName: string,
  toolName: string,
): string {
  return `Not run: MCP server "${serverName}" asked the user to sign in before "${toolName}" could run, and the user did not sign in. Do not retry this call unless the user asks.`;
}

/** The tool result after sign-in when the server still refuses the call. */
export function authChallengeRepeatText(
  serverName: string,
  toolName: string,
): string {
  return `MCP server "${serverName}" still asked for sign-in after the user signed in, so "${toolName}" was not run. The account may not have access to this tool.`;
}
