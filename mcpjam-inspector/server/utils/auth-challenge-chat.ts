/**
 * Chat's reaction to a mid-session sign-in challenge ("lazy authentication").
 *
 * A server that let the chat connect anonymously refuses one protected tool
 * call, either with an HTTP 401 (thrown) or with a ChatGPT-style
 * `_meta["mcp/www_authenticate"]` result (returned). The SDK has already
 * recognized it as an `AuthChallengeSignal`; this module decides what the
 * emulated host does with it and carries that out on the chat stream:
 *
 *   - `prompt`, and the connection's auth method may sign in: save the call
 *     as a continuation, emit `data-auth-required`, and suspend exactly like a
 *     403 step-up. Without a way to save the call (a hosted turn with no chat
 *     session) the card is display-only and the call fails as it is.
 *   - `prompt`, but the method may not (`none`, `bearer`, `xaa`, unknown): the
 *     failure passes through, with a notice saying why nothing was offered.
 *   - `notify`: the model gets the generic sign-in text as the tool result, a
 *     notice explains, and a Connect card that does not replay is offered when
 *     the method allows a sign-in.
 *   - `passthrough`: the failure passes through unchanged, with a notice.
 *
 * ONLY THE CHAT WRAPPERS USE THIS. The harness proxy and host-executed harness
 * tools keep calling `scopeStepUpInfoFromToolError`, whose semantics are
 * unchanged, so nothing outside an interactive chat turn can start a redirect
 * on a 401. Scenario and share-link visitors run with `interactive:
 * false`: the model sees what the host would show, but no card is offered.
 *
 * The auth-method gate reads the effective method recorded server-side for
 * the connection, never anything the browser or the target server sent.
 */

import {
  authChallengeNotifyText,
  decideAuthChallengeAction,
  describeAuthChallengeDecision,
  parseAuthChallengeSignal,
  parseToolResultAuthChallenge,
  type AuthChallengeEffectiveAuth,
  type AuthChallengePolicy,
  type AuthChallengeSignal,
  type ToolSecuritySchemeResolution,
} from "@mcpjam/sdk";
import type { UIMessageChunk } from "ai";
import {
  AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
  AUTH_CHALLENGE_WIRE_VERSION,
  AUTH_REQUIRED_DATA_PART_TYPE,
  authChallengeRepeatText,
  type AuthChallengeNoticeEvent,
  type AuthChallengeNoticeReason,
  type AuthRequiredEvent,
  type AuthRequiredSource,
} from "@/shared/auth-challenge";
import { SCOPE_STEP_UP_LIVE_TTL_MS } from "@/shared/scope-step-up";
import type { ElicitationChunkWriter } from "../routes/web/hosted-elicitation.js";
import {
  readAuthChallenge,
  stampAuthChallenge,
} from "./connection-effective-auth.js";
import { logger } from "./logger.js";
import { AuthChallengeSuspendSignal } from "./scope-step-up-continuation.js";

/** A thrown sign-in challenge, ready for the chat decision. */
export type AuthChallengeInfo = {
  serverId: string;
  toolCallId?: string;
  /** Stamped with the connection's effective auth method when it is known. */
  signal: AuthChallengeSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The challenge a hosted tokenless connection's `onUnauthorized` attaches to
 * the `403 UPSTREAM_AUTH_FAILED` error it throws (`routes/web/auth.ts`): the
 * route error carries it in `details`, outside the cause chain the SDK walks.
 */
function hostedEnvelopeChallenge(
  error: unknown,
): AuthChallengeSignal | undefined {
  if (!isRecord(error) || !isRecord(error.details)) return undefined;
  if (error.details.upstreamAuthRequired !== true) return undefined;
  return parseAuthChallengeSignal(error.details.authChallenge);
}

/**
 * Convert a thrown tool error into a mid-session sign-in challenge, for the
 * chat wrappers only.
 *
 * Only a `401` qualifies. A `403 insufficient_scope` belongs to the step-up
 * path (`scopeStepUpInfoFromToolError`), whose semantics this deliberately
 * leaves alone: the harness and host-executed callers of that helper must
 * never start acting on 401s.
 */
export function authChallengeInfoFromToolError(context: {
  error: unknown;
  serverId: string;
  toolCallId?: string;
  /** The connection's recorded method; wins over any stamp on the error. */
  effectiveAuth?: AuthChallengeEffectiveAuth;
}): AuthChallengeInfo | undefined {
  const signal =
    readAuthChallenge(context.error) ?? hostedEnvelopeChallenge(context.error);
  if (!signal || signal.source !== "http_401") return undefined;
  return {
    serverId: context.serverId,
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    signal: stampAuthChallenge(
      signal,
      context.effectiveAuth ?? signal.effectiveAuth,
    ),
  };
}

/**
 * Whether a completed tool result is a sign-in challenge. A challenged result
 * is never a success: it must not settle a continuation as completed or reset
 * any retry budget.
 */
export function isAuthChallengedToolResult(result: unknown): boolean {
  return parseToolResultAuthChallenge(result) !== undefined;
}

/** What the chat turn knows to decide and carry out a sign-in challenge. */
export interface AuthChallengeChatObserver {
  /** The host's reaction, read per turn. Absent = spec defaults. */
  policy?: AuthChallengePolicy;
  /**
   * Whether anyone on this surface may sign in. `false` for scenario and
   * share-link visitors: decisions still shape what the model sees, but no
   * Connect card is ever offered.
   */
  interactive: boolean;
  /** The connection's effective auth method, recorded at connect time. */
  effectiveAuthFor: (
    serverId: string,
  ) => AuthChallengeEffectiveAuth | undefined;
  /** The tool's resolved `securitySchemes`, for the `_meta` trigger rule. */
  securitySchemesFor?: (
    serverId: string,
    toolName: string,
  ) => ToolSecuritySchemeResolution | Promise<ToolSecuritySchemeResolution>;
  /** Whether the tool declared `readOnlyHint: true`. */
  readOnlyFor?: (serverId: string, toolName: string) => boolean;
  serverNameFor?: (serverId: string) => string | undefined;
  /** The credential the call used, when the server reported one. */
  connectionIdFor?: (
    toolName: string,
    toolInput: unknown,
    toolCallId: string,
  ) => string | undefined;
  /** A sign-in for this operation just completed (a repeat is permanent). */
  hasRecentSignIn?: (input: { serverId: string; toolName: string }) => boolean;
  /**
   * Save the call so it can be replayed after sign-in. Absent when this turn
   * cannot resume (a hosted turn without a chat session): the card is then
   * display-only and the call fails as it is.
   */
  createContinuation?: (input: {
    serverId: string;
    serverName?: string;
    connectionId?: string;
    toolCallId: string;
    toolName: string;
    toolInput: unknown;
    signal: AuthChallengeSignal;
  }) =>
    | { continuationId: string; expiresAt: number }
    | Promise<{ continuationId: string; expiresAt: number }>;
  /** The call is suspending: the engine pauses after this step. */
  onSuspend?: (toolCallId: string) => void;
}

export type AuthChallengeChatOutcome =
  /** Rethrow the error, or return the result, unchanged. */
  | { kind: "passthrough" }
  /** Answer the call with this result instead. */
  | { kind: "result"; result: AuthChallengeTextResult };

export type AuthChallengeTextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
};

export function authChallengeTextResult(text: string): AuthChallengeTextResult {
  return { content: [{ type: "text", text }], isError: true };
}

function canSignIn(
  effectiveAuth: AuthChallengeEffectiveAuth | undefined,
): effectiveAuth is "discover" | "oauth" {
  return effectiveAuth === "discover" || effectiveAuth === "oauth";
}

/** Why the auth method kept a `prompt` host from offering sign-in. */
export function authMethodBlockedExplanation(
  effectiveAuth: AuthChallengeEffectiveAuth | undefined,
): string {
  switch (effectiveAuth) {
    case "none":
      return "This server asked for sign-in, but its authentication is set to None. Switch it to Auto or OAuth to sign in from chat.";
    case "bearer":
      return "This server rejected its configured bearer token. Update the token in the server's settings; MCPJam does not start sign-in for a bearer-token server.";
    case "xaa":
      return "This server asked for sign-in, but its access is enterprise-managed (XAA). MCPJam does not start an interactive sign-in for it; check the server's XAA configuration.";
    default:
      return "This server asked for sign-in, but MCPJam could not confirm how it authenticates, so no sign-in was offered.";
  }
}

export const REPEAT_AFTER_SIGN_IN_EXPLANATION =
  "The server asked for sign-in again right after the user signed in for this call, so MCPJam treats it as a permanent failure and does not offer sign-in again.";

/**
 * Report a sign-in the server refused again right after the user signed in
 * (permanent, no second card). Returns the model-facing repeat text.
 */
export function emitRepeatedSignInNotice(
  writer: ElicitationChunkWriter | null | undefined,
  input: {
    serverId: string;
    serverName?: string;
    toolCallId?: string;
    toolName: string;
    signal: AuthChallengeSignal;
  },
): string {
  emitAuthChallengeNoticeChunk(
    writer,
    buildAuthChallengeNotice({
      ...input,
      action: "prompt",
      reason: "repeat-after-sign-in",
      explanation: REPEAT_AFTER_SIGN_IN_EXPLANATION,
    }),
  );
  return authChallengeRepeatText(
    input.serverName ?? input.serverId,
    input.toolName,
  );
}

/**
 * Whether the tool declared `readOnlyHint: true` on the server's last
 * `tools/list`. Anything else, including an unknown tool, is a write: its
 * replay after sign-in asks first.
 */
export function toolReadOnlyHint(
  manager: object,
  serverId: string,
  toolName: string,
): boolean {
  try {
    const annotations = (
      manager as {
        getAllToolAnnotations?: (
          serverId: string,
        ) => Record<string, Record<string, unknown> | undefined>;
      }
    ).getAllToolAnnotations?.(serverId);
    return annotations?.[toolName]?.readOnlyHint === true;
  } catch {
    return false;
  }
}

function sourceOf(signal: AuthChallengeSignal): AuthRequiredSource {
  return signal.source === "tool_result_meta" ? "tool_result_meta" : "http_401";
}

export function emitAuthRequiredChunk(
  writer: ElicitationChunkWriter | null | undefined,
  event: AuthRequiredEvent,
): boolean {
  if (!writer) return false;
  try {
    writer.write({
      type: AUTH_REQUIRED_DATA_PART_TYPE,
      data: event,
      transient: true,
    } as unknown as UIMessageChunk);
    return true;
  } catch (error) {
    logger.warn("[auth-challenge] auth_required stream write failed", {
      error,
    });
    return false;
  }
}

export function emitAuthChallengeNoticeChunk(
  writer: ElicitationChunkWriter | null | undefined,
  event: AuthChallengeNoticeEvent,
): void {
  if (!writer) return;
  try {
    writer.write({
      type: AUTH_CHALLENGE_NOTICE_DATA_PART_TYPE,
      data: event,
      transient: true,
    } as unknown as UIMessageChunk);
  } catch (error) {
    logger.warn("[auth-challenge] notice stream write failed", { error });
  }
}

export function buildAuthChallengeNotice(input: {
  serverId: string;
  serverName?: string;
  toolCallId?: string;
  toolName: string;
  signal: AuthChallengeSignal;
  action: AuthChallengeNoticeEvent["action"];
  reason: AuthChallengeNoticeReason;
  explanation: string;
}): AuthChallengeNoticeEvent {
  return {
    version: AUTH_CHALLENGE_WIRE_VERSION,
    kind: "auth_challenge_notice",
    serverId: input.serverId,
    ...(input.serverName ? { serverName: input.serverName } : {}),
    toolCallId: input.toolCallId ?? "",
    operation: { method: "tools/call", operation: input.toolName },
    source: sourceOf(input.signal),
    action: input.action,
    reason: input.reason,
    ...(input.signal.effectiveAuth
      ? { effectiveAuth: input.signal.effectiveAuth }
      : {}),
    explanation: input.explanation,
  };
}

function buildAuthRequiredEvent(input: {
  serverId: string;
  serverName?: string;
  connectionId?: string;
  toolCallId: string;
  toolName: string;
  signal: AuthChallengeSignal;
  effectiveAuth: "discover" | "oauth";
  action: "prompt" | "notify";
  readOnly: boolean;
  continuationId?: string;
  expiresAt: number;
}): AuthRequiredEvent {
  return {
    version: AUTH_CHALLENGE_WIRE_VERSION,
    kind: "auth_required",
    ...(input.continuationId ? { continuationId: input.continuationId } : {}),
    serverId: input.serverId,
    ...(input.serverName ? { serverName: input.serverName } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    toolCallId: input.toolCallId,
    operation: { method: "tools/call", operation: input.toolName },
    source: sourceOf(input.signal),
    effectiveAuth: input.effectiveAuth,
    action: input.action,
    readOnly: input.readOnly,
    ...(input.signal.requiredScope
      ? { requiredScope: input.signal.requiredScope }
      : {}),
    ...(input.signal.resourceMetadataUrl
      ? { resourceMetadataUrl: input.signal.resourceMetadataUrl }
      : {}),
    ...(input.signal.errorDescription
      ? { errorDescription: input.signal.errorDescription }
      : {}),
    expiresAt: input.expiresAt,
  };
}

/**
 * Decide and carry out the host's reaction to one challenged call.
 *
 * Throws {@link AuthChallengeSuspendSignal} when the call is suspended for a
 * sign-in; otherwise says whether the caller keeps the original outcome or
 * answers with a replacement result.
 */
export async function handleChatAuthChallenge(input: {
  observer: AuthChallengeChatObserver;
  writer: ElicitationChunkWriter | null | undefined;
  signal: AuthChallengeSignal;
  serverId: string;
  toolCallId?: string;
  /** The chat's tool name (the operation the card and replay are keyed on). */
  toolName: string;
  /** The server's own tool name (annotations and `securitySchemes`). */
  mcpToolName: string;
  toolInput: unknown;
}): Promise<AuthChallengeChatOutcome> {
  const { observer, writer, serverId, toolCallId, toolName } = input;
  const effectiveAuth =
    observer.effectiveAuthFor(serverId) ?? input.signal.effectiveAuth;
  const signal = stampAuthChallenge(input.signal, effectiveAuth);
  const serverName = observer.serverNameFor?.(serverId);
  const displayName = serverName ?? serverId;

  let schemes: ToolSecuritySchemeResolution | undefined;
  if (signal.source === "tool_result_meta" && observer.securitySchemesFor) {
    try {
      schemes = await observer.securitySchemesFor(serverId, input.mcpToolName);
    } catch {
      schemes = { schemes: [], source: "unresolved" };
    }
  }
  const decision = decideAuthChallengeAction(signal, observer.policy, schemes);
  const notice = (
    action: AuthChallengeNoticeEvent["action"],
    reason: AuthChallengeNoticeReason,
    explanation: string,
  ) =>
    emitAuthChallengeNoticeChunk(
      writer,
      buildAuthChallengeNotice({
        serverId,
        serverName,
        toolCallId,
        toolName,
        signal,
        action,
        reason,
        explanation,
      }),
    );
  const readOnly = observer.readOnlyFor?.(serverId, input.mcpToolName) === true;
  const connectionId = toolCallId
    ? observer.connectionIdFor?.(toolName, input.toolInput, toolCallId)
    : undefined;

  if (decision.action === "passthrough") {
    notice(
      "passthrough",
      decision.reason,
      describeAuthChallengeDecision(signal, decision),
    );
    return { kind: "passthrough" };
  }

  if (decision.action === "notify") {
    notice(
      "notify",
      decision.reason,
      describeAuthChallengeDecision(signal, decision),
    );
    if (observer.interactive && toolCallId && canSignIn(effectiveAuth)) {
      emitAuthRequiredChunk(
        writer,
        buildAuthRequiredEvent({
          serverId,
          serverName,
          connectionId,
          toolCallId,
          toolName,
          signal,
          effectiveAuth,
          action: "notify",
          readOnly,
          expiresAt: Date.now() + SCOPE_STEP_UP_LIVE_TTL_MS,
        }),
      );
    }
    return {
      kind: "result",
      result: authChallengeTextResult(authChallengeNotifyText(displayName)),
    };
  }

  // prompt
  if (!canSignIn(effectiveAuth)) {
    notice(
      "prompt",
      "auth-method-blocked",
      authMethodBlockedExplanation(effectiveAuth),
    );
    return { kind: "passthrough" };
  }
  if (observer.hasRecentSignIn?.({ serverId, toolName })) {
    return {
      kind: "result",
      result: authChallengeTextResult(
        emitRepeatedSignInNotice(writer, {
          serverId,
          serverName,
          toolCallId,
          toolName,
          signal,
        }),
      ),
    };
  }
  if (!observer.interactive || !toolCallId || !writer) {
    return { kind: "passthrough" };
  }

  if (!observer.createContinuation) {
    // Nothing can hold the call, so the card offers sign-in only and the call
    // fails as it is; the user runs it again afterwards.
    emitAuthRequiredChunk(
      writer,
      buildAuthRequiredEvent({
        serverId,
        serverName,
        connectionId,
        toolCallId,
        toolName,
        signal,
        effectiveAuth,
        action: "prompt",
        readOnly,
        expiresAt: Date.now() + SCOPE_STEP_UP_LIVE_TTL_MS,
      }),
    );
    return { kind: "passthrough" };
  }

  let saved: { continuationId: string; expiresAt: number };
  try {
    saved = await observer.createContinuation({
      serverId,
      ...(serverName ? { serverName } : {}),
      ...(connectionId ? { connectionId } : {}),
      toolCallId,
      toolName,
      toolInput: input.toolInput,
      signal,
    });
  } catch (error) {
    // The call cannot be saved, so it fails as it is; the card still offers
    // sign-in, and the user runs the tool again afterwards.
    logger.warn("[auth-challenge] could not save the challenged call", {
      error: error instanceof Error ? error.message : String(error),
    });
    emitAuthRequiredChunk(
      writer,
      buildAuthRequiredEvent({
        serverId,
        serverName,
        connectionId,
        toolCallId,
        toolName,
        signal,
        effectiveAuth,
        action: "prompt",
        readOnly,
        expiresAt: Date.now() + SCOPE_STEP_UP_LIVE_TTL_MS,
      }),
    );
    return { kind: "passthrough" };
  }
  const event = buildAuthRequiredEvent({
    serverId,
    serverName,
    connectionId,
    toolCallId,
    toolName,
    signal,
    effectiveAuth,
    action: "prompt",
    readOnly,
    continuationId: saved.continuationId,
    expiresAt: saved.expiresAt,
  });
  if (!emitAuthRequiredChunk(writer, event)) {
    // The card never reached the browser, so nothing can resume the call; the
    // saved window simply expires.
    return { kind: "passthrough" };
  }
  observer.onSuspend?.(toolCallId);
  throw new AuthChallengeSuspendSignal(event);
}
