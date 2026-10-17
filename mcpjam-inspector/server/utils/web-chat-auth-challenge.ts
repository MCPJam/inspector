import { UNAPPROVED_HISTORY_CALL_RESULT } from "./tool-approval-token.js";
import { authChallengeCancelledText } from "@/shared/auth-challenge";
import { toolConnectionAttribution } from "@/shared/mcp-tool-origin-metadata";
import {
  SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
  SCOPE_STEP_UP_VERSION,
  type ScopeStepUpCancelRequest,
} from "@/shared/scope-step-up";
import { type ToolSet, type UIMessageChunk } from "ai";
import { type ElicitationChunkWriter } from "./../routes/web/hosted-elicitation.js";
import {
  toolReadOnlyHint,
  type AuthChallengeChatObserver,
} from "./auth-challenge-chat.js";
import {
  challengedToolSecuritySchemes,
  connectionEffectiveAuth,
} from "./connection-effective-auth.js";
import { type SettleSuspendedToolCall } from "./direct-chat-scope-step-up.js";
import {
  cancelHostedContinuationForNewMessage,
  createHostedAuthChallengeContinuation,
  settleHostedAuthChallengeHistoryCall,
} from "./hosted-scope-step-up-continuation.js";
import { logger } from "./logger.js";

import type { StreamWebChatTurnArgs } from "./web-chat-turn.js";
export function buildWebChatAuthChallenge(input: {
  manager: StreamWebChatTurnArgs["manager"];
  persist: StreamWebChatTurnArgs["persist"];
  runtime: StreamWebChatTurnArgs["runtime"];
  preparedTools: ToolSet;
  scopeStepUpServerNamesById: Record<string, string>;
  splicedScopeStepUpCancel: ScopeStepUpCancelRequest | undefined;
  getWriter: () => ElicitationChunkWriter | null;
  onSuspend: (toolCallId: string) => void;
}) {
  const {
    manager,
    persist,
    runtime,
    preparedTools,
    scopeStepUpServerNamesById,
    splicedScopeStepUpCancel,
    getWriter,
    onSuspend,
  } = input;
  // Mid-session sign-in. Never on a harness turn (its MCP tools run out of
  // process and must not start sign-in); scenario and share-link visitors
  // get the host's model-facing behavior but never a Connect card. A call is
  // saved for replay only where a step-up could be (a chat session and the
  // continuation store); otherwise the card is display-only.
  const scopeStepUpRuntime = runtime.scopeStepUp;
  const hostedChatSession = persist.chatSessionId;
  const authChallengeObserver: AuthChallengeChatObserver | undefined =
    runtime.authChallenge && !persist.harness
      ? {
          ...(runtime.authChallenge.policy
            ? { policy: runtime.authChallenge.policy }
            : {}),
          interactive: persist.sourceType !== "scenario",
          effectiveAuthFor: (serverId) =>
            connectionEffectiveAuth(manager, serverId),
          securitySchemesFor: (serverId, toolName) =>
            challengedToolSecuritySchemes(manager, serverId, toolName),
          readOnlyFor: (serverId, toolName) =>
            toolReadOnlyHint(manager, serverId, toolName),
          serverNameFor: (serverId) => scopeStepUpServerNamesById[serverId],
          connectionIdFor: (toolName, toolInput, toolCallId) =>
            toolConnectionAttribution(
              preparedTools[toolName],
              toolInput,
              toolCallId,
            )?.connectionId,
          ...(scopeStepUpRuntime && hostedChatSession
            ? {
                createContinuation: (saved) =>
                  createHostedAuthChallengeContinuation({
                    bearer: scopeStepUpRuntime.bearer,
                    authPrincipal: scopeStepUpRuntime.authPrincipal,
                    projectId: persist.projectId,
                    chatSessionId: hostedChatSession,
                    manager,
                    serverId: saved.serverId,
                    ...(saved.serverName
                      ? { serverName: saved.serverName }
                      : {}),
                    ...(saved.connectionId
                      ? { connectionId: saved.connectionId }
                      : {}),
                    toolCallId: saved.toolCallId,
                    toolName: saved.toolName,
                    toolInput: saved.toolInput,
                    ...(runtime.abortSignal
                      ? { abortSignal: runtime.abortSignal }
                      : {}),
                  }),
              }
            : {}),
          onSuspend: (toolCallId) => {
            onSuspend(toolCallId);
          },
        }
      : undefined;

  // A call a sign-in suspended can come back unresolved: the user sent
  // another message instead of signing in. Its continuation is cancelled and
  // the call answered with the cancel copy. The id is derived from the call,
  // so no browser input is trusted.
  const settleSuspendedHistoryToolCall: SettleSuspendedToolCall | undefined =
    authChallengeObserver && scopeStepUpRuntime && hostedChatSession
      ? async ({ toolCallId, toolName }) => {
          const serverId = (
            preparedTools[toolName] as { _serverId?: unknown } | undefined
          )?._serverId;
          if (splicedScopeStepUpCancel?.toolCallId === toolCallId) {
            // Answered whether or not the store still holds it waiting.
            const { cancelled, isSignIn } =
              await cancelHostedContinuationForNewMessage({
                bearer: scopeStepUpRuntime.bearer,
                continuationId: splicedScopeStepUpCancel.continuationId,
              });
            if (!cancelled) return UNAPPROVED_HISTORY_CALL_RESULT;
            if (typeof serverId === "string") {
              try {
                getWriter()?.write({
                  type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
                  data: {
                    version: SCOPE_STEP_UP_VERSION,
                    continuationId: splicedScopeStepUpCancel.continuationId,
                    serverId,
                    operation: { method: "tools/call", operation: toolName },
                    outcome: "cancelled",
                  },
                  transient: true,
                } satisfies UIMessageChunk);
              } catch (error) {
                // A closed stream must not prevent the history from being settled.
                logger.warn(
                  "Could not deliver the sign-in cancellation notice",
                  { error },
                );
              }
            }
            return isSignIn
              ? authChallengeCancelledText(
                  typeof serverId === "string"
                    ? (scopeStepUpServerNamesById[serverId] ?? serverId)
                    : "unknown",
                  toolName,
                )
              : "Authorization was not completed, so the tool was not retried.";
          }
          // Only an MCP tool can have been suspended for sign-in.
          if (typeof serverId !== "string") return undefined;
          const settled = await settleHostedAuthChallengeHistoryCall({
            bearer: scopeStepUpRuntime.bearer,
            authPrincipal: scopeStepUpRuntime.authPrincipal,
            chatSessionId: hostedChatSession,
            toolCallId,
          });
          return settled
            ? authChallengeCancelledText(
                scopeStepUpServerNamesById[serverId] ?? serverId,
                toolName,
              )
            : undefined;
        }
      : undefined;

  return { authChallengeObserver, settleSuspendedHistoryToolCall };
}
