import { toolConnectionAttribution } from "@/shared/mcp-tool-origin-metadata";
import { createHash, randomUUID } from "node:crypto";
import type { ModelMessage, ToolSet, UIMessageChunk } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  SCOPE_STEP_UP_LIVE_TTL_MS,
  SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
  SCOPE_STEP_UP_VERSION,
  type ScopeStepUpRequiredEvent,
  type ScopeStepUpCancelRequest,
  type ScopeStepUpResumeRequest,
} from "@/shared/scope-step-up";
import { executeToolCallsFromMessages } from "@/shared/http-tool-calls";
import type { InsufficientScopeInfo } from "../routes/web/hosted-elicitation.js";
import {
  cancelContinuation,
  claimContinuation,
  createContinuation,
  finalizeContinuation,
  markContinuationWireStarted,
  scrubContinuation,
} from "./mrtr-continuation-state.js";
import {
  computeMrtrBindingFingerprintFromManager,
  resolveMrtrNegotiatedEra,
} from "./mrtr-hosted-collector.js";
import type {
  MrtrChatResumeResolution,
  MrtrEngineResume,
} from "./mrtr-hosted-chat.js";
import { scopeStepUpInfoFromToolError } from "./insufficient-scope-step-up.js";
import {
  parseToolResultAuthChallenge,
  type AuthChallengeSignal,
} from "@mcpjam/sdk";
import {
  AUTH_CHALLENGE_REASON,
  authChallengeCancelledText,
} from "@/shared/auth-challenge";
import {
  authChallengeInfoFromToolError,
  emitRepeatedSignInNotice,
} from "./auth-challenge-chat.js";
import { logger } from "./logger.js";

/**
 * Which credential a saved call used, and so how a sign-in may settle it
 *:
 *
 *   - `none`: the call used no credential (a tokenless first sign-in). The
 *     sign-in creates a personal connection, and the resume may bind to it.
 *   - `owned`: the initiating user's own credential. Reauthorized in place;
 *     the resume must land on that very credential.
 *   - `shared`: a project credential, or one the user does not own. Never
 *     replaced: the user signs in with their own account and runs the tool
 *     again, so the saved call is never replayed across credentials.
 */
export type HostedCredentialBinding =
  | { kind: "none" }
  | { kind: "owned"; credentialId: string }
  | { kind: "shared"; credentialId?: string };

type HostedScopeStepUpState = {
  v: 1;
  /** Absent: a 403 step-up. */
  reason?: typeof AUTH_CHALLENGE_REASON;
  serverId: string;
  serverName?: string;
  connectionId?: string;
  /** Recorded for sign-in continuations. */
  credentialBinding?: HostedCredentialBinding;
  resourceUrl?: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  inputHash: string;
};

/**
 * A sign-in continuation's id carries its reason, so a cancel (which never
 * reads the saved state) can still answer with sign-in copy. The id stays
 * opaque to the browser, and a forged prefix names no continuation: the store
 * refuses it, so the copy is only ever chosen for a real sign-in.
 */
export const HOSTED_AUTH_CHALLENGE_CONTINUATION_PREFIX = "authz-";

export function isHostedAuthChallengeContinuationId(id: string): boolean {
  return id.startsWith(HOSTED_AUTH_CHALLENGE_CONTINUATION_PREFIX);
}

/**
 * The id is derived from the suspended call rather than drawn at random, so a
 * later turn that resends the call unresolved can find its continuation
 * without the browser naming it (history settlement). The store still
 * owns the row: only its owner can cancel or claim it, under the binding
 * fingerprint, so a derivable id grants nothing.
 */
export function hostedAuthChallengeContinuationId(input: {
  authPrincipal: string;
  chatSessionId: string;
  toolCallId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        "mcpjam/auth-challenge-continuation/v1",
        input.authPrincipal,
        input.chatSessionId,
        input.toolCallId,
      ].join("\u0000"),
    )
    .digest("base64url");
  return `${HOSTED_AUTH_CHALLENGE_CONTINUATION_PREFIX}${digest}`;
}

/**
 * History settlement on the hosted engine: cancel the pending sign-in
 * continuation a resent, still-unresolved call belongs to. True when there
 * was one to cancel, so the caller answers the call with the cancel copy; a
 * call this conversation never suspended for sign-in (or one already
 * terminal) keeps its default handling.
 */
export async function settleHostedAuthChallengeHistoryCall(input: {
  bearer: string;
  authPrincipal: string;
  chatSessionId: string;
  toolCallId: string;
}): Promise<boolean> {
  const continuationId = hostedAuthChallengeContinuationId(input);
  const cancelled = await cancelContinuation(input.bearer, {
    continuationId,
    reason: "the user continued without signing in",
  });
  if (!cancelled.ok) return false;
  await scrubContinuation(input.bearer, { continuationId });
  return true;
}

/**
 * A cancel the client spliced into the user's next message. Cancels
 * the continuation when the store still holds it waiting; never fails, so an
 * unknown or expired continuation cannot cost the user their message. The
 * copy follows the id: a sign-in id answers with sign-in copy.
 */
export async function cancelHostedContinuationForNewMessage(input: {
  bearer: string;
  continuationId: string;
}): Promise<{ cancelled: boolean; isSignIn: boolean }> {
  const isSignIn = isHostedAuthChallengeContinuationId(input.continuationId);
  const cancelled = await cancelContinuation(input.bearer, {
    continuationId: input.continuationId,
    reason: "the user sent a new message instead of signing in",
  });
  if (!cancelled.ok) return { cancelled: false, isSignIn };
  await scrubContinuation(input.bearer, {
    continuationId: input.continuationId,
  });
  return { cancelled: true, isSignIn };
}

/** The terminal reason of a sign-in whose replay was refused again. */
export const HOSTED_AUTH_CHALLENGE_REPEATED_REASON =
  "authorization_required repeated after sign-in";

/** The model-facing text when a sign-in settled on another credential. */
export function signedInWithAnotherCredentialText(
  serverName: string,
  toolName: string,
  binding: HostedCredentialBinding | undefined,
): string {
  return binding?.kind === "shared"
    ? `Not run: the user signed in to MCP server "${serverName}" with their own account instead of the shared connection "${toolName}" used, so it was not retried. Run it again if the user asks.`
    : `Not run: the user signed in to MCP server "${serverName}" with a different account than "${toolName}" used, so it was not retried. Run it again if the user asks.`;
}

function isCredentialBinding(value: unknown): value is HostedCredentialBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as { kind?: unknown; credentialId?: unknown };
  if (binding.kind === "none") return true;
  if (binding.kind === "owned") {
    return (
      typeof binding.credentialId === "string" && binding.credentialId !== ""
    );
  }
  return (
    binding.kind === "shared" &&
    (binding.credentialId === undefined ||
      typeof binding.credentialId === "string")
  );
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

function hashInput(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("base64url");
}

function encodeState(state: HostedScopeStepUpState): string {
  return JSON.stringify(state);
}

function decodeState(value: unknown): HostedScopeStepUpState {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("scope_step_up_continuation_invalid");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { serverId?: unknown }).serverId !== "string" ||
    typeof (parsed as { toolCallId?: unknown }).toolCallId !== "string" ||
    typeof (parsed as { toolName?: unknown }).toolName !== "string" ||
    typeof (parsed as { inputHash?: unknown }).inputHash !== "string" ||
    !Object.prototype.hasOwnProperty.call(parsed, "toolInput")
  ) {
    throw new Error("scope_step_up_continuation_invalid");
  }
  const state = parsed as HostedScopeStepUpState;
  if (
    (state.reason !== undefined && state.reason !== AUTH_CHALLENGE_REASON) ||
    (state.credentialBinding !== undefined &&
      !isCredentialBinding(state.credentialBinding)) ||
    (state.serverName !== undefined && typeof state.serverName !== "string")
  ) {
    throw new Error("scope_step_up_continuation_invalid");
  }
  if (hashInput(state.toolInput) !== state.inputHash) {
    throw new Error("scope_step_up_continuation_input_mismatch");
  }
  return state;
}

function readProtectedResourceUrl(
  manager: Pick<MCPClientManager, "getServerConfig">,
  serverId: string
): string | undefined {
  const config = manager.getServerConfig(serverId);
  if (!config || typeof config !== "object") return undefined;
  const raw = (config as { url?: unknown }).url;
  if (typeof raw === "string") return raw;
  if (raw instanceof URL) return raw.toString();
  return undefined;
}

function findUnresolvedToolCall(
  messages: ModelMessage[],
  toolCallId: string
): { toolName: string; input: unknown } | undefined {
  const resolved = new Set<string>();
  for (const message of messages) {
    if (message?.role !== "tool" || !Array.isArray((message as any).content)) {
      continue;
    }
    for (const part of (message as any).content) {
      if (part?.type === "tool-result" && typeof part.toolCallId === "string") {
        resolved.add(part.toolCallId);
      }
    }
  }
  if (resolved.has(toolCallId)) return undefined;
  for (const message of messages) {
    if (
      message?.role !== "assistant" ||
      !Array.isArray((message as any).content)
    ) {
      continue;
    }
    const part = (message as any).content.find(
      (candidate: any) =>
        candidate?.type === "tool-call" &&
        candidate.toolCallId === toolCallId &&
        typeof candidate.toolName === "string"
    );
    if (part) {
      return {
        toolName: part.toolName,
        input: part.input ?? part.args ?? {},
      };
    }
  }
  return undefined;
}

function buildErrorToolResult(
  toolCallId: string,
  toolName: string,
  message: string
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "error-text", value: message },
      },
    ],
  } as unknown as ModelMessage;
}

/**
 * Whether a resumed call may run on the credential the rebuilt connection
 * resolves to.
 *
 * - The call used a credential: only that same credential. A sign-in that
 *   produced another one (an account switch at the authorization server, or a
 *   personal connection made beside a shared one) is not a reauthorization of
 *   the call's credential, and the client cancels instead of resuming.
 * - The call used none (a tokenless first sign-in): the first binding is
 *   allowed. The continuation is already pinned to this server
 *   (`claimed.state.serverId`) and, through the binding fingerprint's auth
 *   principal, to the user who started it, so the credential the rebuilt
 *   connection resolves to is the one that user just authorized.
 */
export function checkResumeCredentialBinding(
  recordedConnectionId: string | undefined,
  resolvedConnectionId: string | undefined,
): { ok: true; firstBinding: boolean } | { ok: false } {
  if (!recordedConnectionId) return { ok: true, firstBinding: true };
  return resolvedConnectionId === recordedConnectionId
    ? { ok: true, firstBinding: false }
    : { ok: false };
}

/**
 * The resume check for a continuation that recorded its credential binding
 *. A shared credential is never resumed: the sign-in made a personal
 * connection, and replaying onto it would run the call on another account.
 */
export function checkRecordedCredentialBinding(
  recorded: HostedCredentialBinding,
  resolvedConnectionId: string | undefined,
): { ok: true; firstBinding: boolean } | { ok: false } {
  switch (recorded.kind) {
    case "none":
      return checkResumeCredentialBinding(undefined, resolvedConnectionId);
    case "owned":
      return checkResumeCredentialBinding(
        recorded.credentialId,
        resolvedConnectionId,
      );
    case "shared":
      return { ok: false };
  }
}

/**
 * Whether the initiating user owns this credential, from the same listing the
 * client reads (`/web/oauth/connections`): a personal row, and not the
 * project's shared one. Anything else, including a failed lookup, is not
 * theirs; a credential that cannot be proven owned is never replaced.
 */
async function ownsHostedCredential(input: {
  bearer: string;
  projectId: string;
  serverId: string;
  connectionId: string;
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) return false;
  try {
    const response = await fetch(`${convexUrl}/web/oauth/connections`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: input.bearer.startsWith("Bearer ")
          ? input.bearer
          : `Bearer ${input.bearer}`,
      },
      body: JSON.stringify({
        projectId: input.projectId,
        serverId: input.serverId,
      }),
      signal: input.abortSignal
        ? AbortSignal.any([input.abortSignal, AbortSignal.timeout(5_000)])
        : AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      connections?: Array<{ connectionId?: unknown }>;
      shared?: unknown;
    };
    return (
      body.shared !== true &&
      Array.isArray(body.connections) &&
      body.connections.some(
        (connection) => connection?.connectionId === input.connectionId,
      )
    );
  } catch (error) {
    logger.warn("[auth-challenge] credential ownership lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function resolveHostedCredentialBinding(input: {
  bearer: string;
  projectId: string;
  serverId: string;
  connectionId?: string;
  abortSignal?: AbortSignal;
  ownsCredential?: (connectionId: string) => Promise<boolean>;
}): Promise<HostedCredentialBinding> {
  // Hosted chat stamps attribution on every call made with a live OAuth
  // credential, so a call without one used none.
  if (!input.connectionId) return { kind: "none" };
  const connectionId = input.connectionId;
  const owned = input.ownsCredential
    ? await input.ownsCredential(connectionId).catch(() => false)
    : await ownsHostedCredential({ ...input, connectionId });
  return owned
    ? { kind: "owned", credentialId: connectionId }
    : { kind: "shared", credentialId: connectionId };
}

/**
 * Save a call that a mid-session sign-in suspended. The same durable
 * store, binding fingerprint and single-claim rules as a step-up, plus the
 * reason and the credential binding the resume is checked against.
 */
export async function createHostedAuthChallengeContinuation(input: {
  bearer: string;
  authPrincipal: string;
  projectId: string;
  chatSessionId: string;
  manager: MCPClientManager;
  serverId: string;
  serverName?: string;
  connectionId?: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  abortSignal?: AbortSignal;
  /** Test seam; defaults to the backend's connection listing. */
  ownsCredential?: (connectionId: string) => Promise<boolean>;
}): Promise<{
  continuationId: string;
  expiresAt: number;
  credentialBinding: HostedCredentialBinding;
}> {
  const continuationId = hostedAuthChallengeContinuationId({
    authPrincipal: input.authPrincipal,
    chatSessionId: input.chatSessionId,
    toolCallId: input.toolCallId,
  });
  const negotiatedEra = resolveMrtrNegotiatedEra(input.manager, input.serverId);
  const bindingFingerprint = computeMrtrBindingFingerprintFromManager(
    input.manager,
    {
      serverId: input.serverId,
      negotiatedEra,
      authPrincipal: input.authPrincipal,
    },
  );
  const resourceUrl = readProtectedResourceUrl(input.manager, input.serverId);
  const credentialBinding = await resolveHostedCredentialBinding({
    bearer: input.bearer,
    projectId: input.projectId,
    serverId: input.serverId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.ownsCredential ? { ownsCredential: input.ownsCredential } : {}),
  });
  const state: HostedScopeStepUpState = {
    v: 1,
    reason: AUTH_CHALLENGE_REASON,
    serverId: input.serverId,
    ...(input.serverName ? { serverName: input.serverName } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    credentialBinding,
    ...(resourceUrl ? { resourceUrl } : {}),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    toolInput: input.toolInput,
    inputHash: hashInput(input.toolInput),
  };
  const created = await createContinuation(
    input.bearer,
    {
      continuationId,
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      serverId: input.serverId,
      operationId: input.toolCallId,
      operationMethod: "tools/call",
      negotiatedEra,
      bindingFingerprint,
      resumeState: encodeState(state),
      round: 0,
      maxRounds: 1,
      ttlMs: SCOPE_STEP_UP_LIVE_TTL_MS,
    },
    input.abortSignal,
  );
  if (!created.ok) {
    throw new Error(`auth_challenge_continuation_create_failed:${created.error}`);
  }
  if (created.idempotent && created.status !== "awaiting_input") {
    // This call already suspended once and settled; it is not offered again.
    throw new Error(`auth_challenge_continuation_${created.status}`);
  }
  return { continuationId, expiresAt: created.expiresAt, credentialBinding };
}

export async function createHostedScopeStepUpContinuation(input: {
  bearer: string;
  authPrincipal: string;
  projectId: string;
  chatSessionId: string;
  manager: MCPClientManager;
  serverName?: string;
  connectionId?: string;
  info: InsufficientScopeInfo & { toolCallId: string };
  toolName: string;
  toolInput: unknown;
  abortSignal?: AbortSignal;
}): Promise<ScopeStepUpRequiredEvent> {
  const continuationId = randomUUID();
  const negotiatedEra = resolveMrtrNegotiatedEra(
    input.manager,
    input.info.serverId
  );
  const bindingFingerprint = computeMrtrBindingFingerprintFromManager(
    input.manager,
    {
      serverId: input.info.serverId,
      negotiatedEra,
      authPrincipal: input.authPrincipal,
    }
  );
  const resourceUrl = readProtectedResourceUrl(
    input.manager,
    input.info.serverId
  );
  const state: HostedScopeStepUpState = {
    v: 1,
    serverId: input.info.serverId,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(resourceUrl ? { resourceUrl } : {}),
    toolCallId: input.info.toolCallId,
    toolName: input.toolName,
    toolInput: input.toolInput,
    inputHash: hashInput(input.toolInput),
  };
  const created = await createContinuation(
    input.bearer,
    {
      continuationId,
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      serverId: input.info.serverId,
      operationId: input.info.toolCallId,
      operationMethod: "tools/call",
      negotiatedEra,
      bindingFingerprint,
      resumeState: encodeState(state),
      round: 0,
      maxRounds: 1,
      ttlMs: SCOPE_STEP_UP_LIVE_TTL_MS,
    },
    input.abortSignal
  );
  if (!created.ok) {
    throw new Error(
      `scope_step_up_continuation_create_failed:${created.error}`
    );
  }
  return {
    version: SCOPE_STEP_UP_VERSION,
    kind: "scope_step_up_required",
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    continuationId,
    serverId: input.info.serverId,
    ...(input.serverName ? { serverName: input.serverName } : {}),
    toolCallId: input.info.toolCallId,
    operation: { method: "tools/call", operation: input.toolName },
    ...(input.info.requiredScope
      ? { requiredScope: input.info.requiredScope }
      : {}),
    ...(input.info.resourceMetadataUrl
      ? { resourceMetadataUrl: input.info.resourceMetadataUrl }
      : {}),
    ...(input.info.errorDescription
      ? { errorDescription: input.info.errorDescription }
      : {}),
    expiresAt: created.expiresAt,
  };
}

export function buildHostedScopeStepUpResume(input: {
  request: ScopeStepUpResumeRequest;
  bearer: string;
  authPrincipal: string;
  projectId: string;
  chatSessionId: string;
  manager: MCPClientManager;
  messages: ModelMessage[];
  tools: ToolSet;
  modelVisibleMcpToolResults?: Parameters<
    typeof executeToolCallsFromMessages
  >[1]["modelVisibleMcpToolResults"];
  abortSignal?: AbortSignal;
}): MrtrEngineResume {
  return {
    toolCallId: input.request.toolCallId,
    resolve: async (write): Promise<MrtrChatResumeResolution> => {
      const unresolved = findUnresolvedToolCall(
        input.messages,
        input.request.toolCallId
      );
      const originalTool = unresolved
        ? (input.tools as Record<string, any>)[unresolved.toolName]
        : undefined;
      const serverId =
        typeof originalTool?._serverId === "string"
          ? originalTool._serverId
          : undefined;
      if (!unresolved || !originalTool || !serverId) {
        return {
          kind: "halted",
          outcome: "failed",
          reason: "The original tool call could not be restored.",
        };
      }

      const negotiatedEra = resolveMrtrNegotiatedEra(input.manager, serverId);
      const bindingFingerprint = computeMrtrBindingFingerprintFromManager(
        input.manager,
        {
          serverId,
          negotiatedEra,
          authPrincipal: input.authPrincipal,
        }
      );
      const leaseId = randomUUID();
      const claimed = await claimContinuation(
        input.bearer,
        {
          continuationId: input.request.continuationId,
          bindingFingerprint,
          leaseId,
          leasedBy: "scope-step-up-chat",
        },
        input.abortSignal
      );
      if (!claimed.ok || !claimed.state || !claimed.state.resumeState) {
        return {
          kind: "halted",
          outcome:
            claimed.ok && claimed.status === "indeterminate"
              ? "indeterminate"
              : claimed.ok && claimed.status === "expired"
              ? "expired"
              : "failed",
          reason: claimed.ok
            ? claimed.reason ?? `Continuation is ${claimed.status}.`
            : claimed.error,
        };
      }

      let state: HostedScopeStepUpState;
      try {
        state = decodeState(claimed.state.resumeState);
      } catch (error) {
        await cancelContinuation(input.bearer, {
          continuationId: input.request.continuationId,
          reason: "invalid replay state",
        });
        return {
          kind: "halted",
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (
        claimed.state.projectId !== input.projectId ||
        claimed.state.chatSessionId !== input.chatSessionId ||
        claimed.state.serverId !== serverId ||
        claimed.state.operationId !== input.request.toolCallId ||
        state.serverId !== serverId ||
        state.toolCallId !== input.request.toolCallId ||
        state.toolName !== unresolved.toolName ||
        state.inputHash !== hashInput(unresolved.input)
      ) {
        await cancelContinuation(input.bearer, {
          continuationId: input.request.continuationId,
          reason: "scope step-up binding mismatch",
        });
        return {
          kind: "halted",
          outcome: "failed",
          reason: "The saved operation no longer matches this conversation.",
        };
      }

      const resolvedConnectionId = toolConnectionAttribution(
        originalTool,
        state.toolInput,
        state.toolCallId,
      )?.connectionId;
      const binding = state.credentialBinding
        ? checkRecordedCredentialBinding(
            state.credentialBinding,
            resolvedConnectionId,
          )
        : checkResumeCredentialBinding(state.connectionId, resolvedConnectionId);
      if (!binding.ok) {
        await cancelContinuation(input.bearer, {
          continuationId: input.request.continuationId,
          reason: "original account is no longer available",
        });
        if (state.reason === AUTH_CHALLENGE_REASON) {
          // The sign-in produced another credential (a personal connection
          // beside a shared one, or another account at the authorization
          // server). Never replayed across credentials; the model is
          // told to run it again rather than left with a paused call.
          await scrubContinuation(input.bearer, {
            continuationId: input.request.continuationId,
          });
          return {
            kind: "recover",
            reason: "signed in with a different credential",
            toolResultMessage: buildErrorToolResult(
              state.toolCallId,
              state.toolName,
              signedInWithAnotherCredentialText(
                state.serverName ?? serverId,
                state.toolName,
                state.credentialBinding,
              ),
            ),
          };
        }
        return {
          kind: "halted",
          outcome: "failed",
          reason:
            "The original account is no longer available. The operation was not retried.",
        };
      }

      let replayError: unknown;
      let replayResult: unknown;
      const execute = originalTool.execute.bind(originalTool);
      const replayTool = {
        ...originalTool,
        execute: async (toolInput: unknown, options: unknown) => {
          const marked = await markContinuationWireStarted(
            input.bearer,
            {
              continuationId: input.request.continuationId,
              leaseId,
            },
            input.abortSignal
          );
          if (!marked.ok) {
            throw new Error(marked.error);
          }
          try {
            replayResult = await execute(toolInput, options);
            return replayResult;
          } catch (error) {
            replayError = error;
            throw error;
          }
        },
      };
      // A sign-in refused again right after the user signed in is permanent
      //: finalized as failed, answered with the repeat copy, no new card.
      const refused = async (
        terminalReason: string,
        toolResultMessage: ModelMessage,
      ): Promise<MrtrChatResumeResolution> => {
        await finalizeContinuation(
          input.bearer,
          {
            continuationId: input.request.continuationId,
            leaseId,
            expectedStateVersion: claimed.stateVersion,
            status: "failed",
            terminalReason,
          },
          input.abortSignal
        );
        await scrubContinuation(input.bearer, {
          continuationId: input.request.continuationId,
        });
        return { kind: "recover", reason: terminalReason, toolResultMessage };
      };
      const repeatedSignIn = (signal: AuthChallengeSignal) =>
        refused(
          HOSTED_AUTH_CHALLENGE_REPEATED_REASON,
          buildErrorToolResult(
            state.toolCallId,
            state.toolName,
            emitRepeatedSignInNotice(
              { write },
              {
                serverId,
                ...(state.serverName ? { serverName: state.serverName } : {}),
                toolCallId: state.toolCallId,
                toolName: state.toolName,
                signal,
              },
            ),
          ),
        );
      const replayHistory: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: state.toolCallId,
              toolName: state.toolName,
              input: state.toolInput,
            },
          ],
        } as ModelMessage,
      ];

      let resultMessage: ModelMessage | undefined;
      try {
        const results = await executeToolCallsFromMessages(replayHistory, {
          tools: { [state.toolName]: replayTool },
          parallelToolExecution: false,
          modelVisibleMcpToolResults: input.modelVisibleMcpToolResults,
          abortSignal: input.abortSignal,
        });
        resultMessage = results[0];
      } catch (error) {
        replayError = replayError ?? error;
      }

      if (replayError) {
        const repeatedChallenge = scopeStepUpInfoFromToolError({
          error: replayError,
          serverId,
          toolCallId: state.toolCallId,
        });
        const repeatedAuthChallenge =
          state.reason === AUTH_CHALLENGE_REASON && !repeatedChallenge
            ? authChallengeInfoFromToolError({
                error: replayError,
                serverId,
                toolCallId: state.toolCallId,
              })
            : undefined;
        if (repeatedAuthChallenge) {
          return repeatedSignIn(repeatedAuthChallenge.signal);
        }
        if (repeatedChallenge) {
          await finalizeContinuation(
            input.bearer,
            {
              continuationId: input.request.continuationId,
              leaseId,
              expectedStateVersion: claimed.stateVersion,
              status: "failed",
              terminalReason: "insufficient_scope repeated after authorization",
            },
            input.abortSignal
          );
          await scrubContinuation(input.bearer, {
            continuationId: input.request.continuationId,
          });
          return {
            kind: "recover",
            reason: "insufficient_scope repeated after authorization",
            toolResultMessage:
              resultMessage ??
              buildErrorToolResult(
                state.toolCallId,
                state.toolName,
                "Authorization completed, but the server still rejected the requested scope."
              ),
          };
        }
        await cancelContinuation(input.bearer, {
          continuationId: input.request.continuationId,
          reason: "tool replay failed after the request started",
        });
        return {
          kind: "halted",
          outcome: "indeterminate",
          reason:
            "The retried tool call lost its connection after starting and may have run.",
        };
      }

      if (!resultMessage) {
        await finalizeContinuation(
          input.bearer,
          {
            continuationId: input.request.continuationId,
            leaseId,
            expectedStateVersion: claimed.stateVersion,
            status: "failed",
            terminalReason: "tool replay returned no result",
          },
          input.abortSignal
        );
        await scrubContinuation(input.bearer, {
          continuationId: input.request.continuationId,
        });
        return {
          kind: "halted",
          outcome: "failed",
          reason: "The retried tool call returned no result.",
        };
      }

      // A challenged result is a refusal, not a success: it must not settle
      // the continuation as completed.
      const resultChallenge = parseToolResultAuthChallenge(replayResult);
      if (resultChallenge) {
        return state.reason === AUTH_CHALLENGE_REASON
          ? repeatedSignIn(resultChallenge)
          : refused(
              "the retried call returned a sign-in challenge",
              resultMessage,
            );
      }

      const completed = await finalizeContinuation(
        input.bearer,
        {
          continuationId: input.request.continuationId,
          leaseId,
          expectedStateVersion: claimed.stateVersion,
          status: "completed",
        },
        input.abortSignal
      );
      if (!completed.ok) {
        return {
          kind: "halted",
          outcome: "indeterminate",
          reason:
            "The tool completed, but its continuation could not be committed.",
        };
      }
      await scrubContinuation(input.bearer, {
        continuationId: input.request.continuationId,
      });
      write({
        type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
        data: {
          version: SCOPE_STEP_UP_VERSION,
          continuationId: input.request.continuationId,
          serverId: state.serverId,
          operation: { method: "tools/call", operation: state.toolName },
          outcome: "completed",
        },
        transient: true,
      } as unknown as UIMessageChunk);
      return { kind: "complete", toolResultMessage: resultMessage };
    },
  };
}

export function buildHostedScopeStepUpCancellation(input: {
  request: ScopeStepUpCancelRequest;
  bearer: string;
  messages: ModelMessage[];
  tools: ToolSet;
  /** Display names for the sign-in cancel copy. */
  serverNameFor?: (serverId: string) => string | undefined;
}): MrtrEngineResume {
  return {
    toolCallId: input.request.toolCallId,
    resolve: async (write): Promise<MrtrChatResumeResolution> => {
      const unresolved = findUnresolvedToolCall(
        input.messages,
        input.request.toolCallId
      );
      if (!unresolved) {
        return {
          kind: "halted",
          outcome: "failed",
          reason: "The original tool call could not be restored.",
        };
      }
      const originalTool = (input.tools as Record<string, any>)[
        unresolved.toolName
      ];
      const serverId =
        typeof originalTool?._serverId === "string"
          ? originalTool._serverId
          : undefined;
      if (!serverId) {
        return {
          kind: "halted",
          outcome: "failed",
          reason: "The original tool server could not be restored.",
        };
      }
      const cancelled = await cancelContinuation(input.bearer, {
        continuationId: input.request.continuationId,
        reason: "authorization was not completed",
      });
      if (!cancelled.ok) {
        return {
          kind: "halted",
          outcome: "failed",
          reason: cancelled.error,
        };
      }
      await scrubContinuation(input.bearer, {
        continuationId: input.request.continuationId,
      });
      write({
        type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
        data: {
          version: SCOPE_STEP_UP_VERSION,
          continuationId: input.request.continuationId,
          serverId,
          operation: {
            method: "tools/call",
            operation: unresolved.toolName,
          },
          outcome: "cancelled",
        },
        transient: true,
      } as unknown as UIMessageChunk);
      if (isHostedAuthChallengeContinuationId(input.request.continuationId)) {
        return {
          kind: "recover",
          reason: "sign-in was not completed",
          toolResultMessage: buildErrorToolResult(
            input.request.toolCallId,
            unresolved.toolName,
            authChallengeCancelledText(
              input.serverNameFor?.(serverId) ?? serverId,
              unresolved.toolName,
            ),
          ),
        };
      }
      return {
        kind: "recover",
        reason: "authorization was not completed",
        toolResultMessage: buildErrorToolResult(
          input.request.toolCallId,
          unresolved.toolName,
          "Authorization was not completed, so the tool was not retried."
        ),
      };
    },
  };
}
