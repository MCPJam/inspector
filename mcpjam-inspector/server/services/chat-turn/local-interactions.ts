import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ToolSet, UIMessageChunk } from "ai";
import { parseToolResultAuthChallenge } from "@mcpjam/sdk";
import {
  AUTH_CHALLENGE_REASON,
  authChallengeCancelledText,
  authChallengeMayHaveRunText,
} from "@/shared/auth-challenge";
import type { ChatV2Request } from "@/shared/chat-v2";
import { toolConnectionAttribution } from "@/shared/mcp-tool-origin-metadata";
import { executeToolCallsFromMessages } from "@/shared/http-tool-calls";
import { scopeStepUpInfoFromToolError } from "../../utils/insufficient-scope-step-up.js";
import {
  SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
  SCOPE_STEP_UP_VERSION,
  type ScopeStepUpResumeRequest,
  type ScopeStepUpCancelRequest,
} from "@/shared/scope-step-up";
import {
  AUTH_CHALLENGE_REPEATED_REASON,
  cancelLocalContinuationForNewMessage,
  claimLocalScopeStepUpContinuation,
  failLocalScopeStepUpContinuation,
  markLocalScopeStepUpWireStarted,
  cancelLocalScopeStepUpContinuation,
  completeLocalScopeStepUpContinuation,
  cancelLocalScopeStepUpContinuationForRequest,
  settleLocalAuthChallengeHistoryCall,
} from "../../utils/scope-step-up-continuation.js";
import {
  authChallengeInfoFromToolError,
  emitRepeatedSignInNotice,
} from "../../utils/auth-challenge-chat.js";
import type { SettleSuspendedToolCall } from "../../utils/direct-chat-scope-step-up.js";
import type {
  MrtrEngineResume,
  MrtrChatResumeResolution,
} from "../../utils/mrtr-hosted-chat.js";

function buildScopeStepUpErrorToolResult(
  toolCallId: string,
  toolName: string,
  message: string,
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
  };
}

export function readProtectedResourceUrl(
  mcpClientManager: {
    getServerConfig?: (serverId: string) => unknown;
  },
  serverId: string,
): string | undefined {
  const config = mcpClientManager.getServerConfig?.(serverId);
  if (!config || typeof config !== "object") return undefined;
  const raw = (config as { url?: unknown }).url;
  if (typeof raw === "string") return raw;
  if (raw instanceof URL) return raw.toString();
  return undefined;
}

export function buildLocalScopeStepUpResume(input: {
  request: ScopeStepUpResumeRequest;
  bindingKey: string;
  tools: ToolSet;
  modelVisibleMcpToolResults?: ChatV2Request["modelVisibleMcpToolResults"];
}): MrtrEngineResume {
  return {
    toolCallId: input.request.toolCallId,
    resolve: async (write): Promise<MrtrChatResumeResolution> => {
      let claimed;
      try {
        claimed = claimLocalScopeStepUpContinuation({
          continuationId: input.request.continuationId,
          toolCallId: input.request.toolCallId,
          bindingKey: input.bindingKey,
        });
      } catch (error) {
        return {
          kind: "halted",
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      const originalTool = input.tools[claimed.toolName];
      if (
        (claimed.connectionId &&
          toolConnectionAttribution(
            originalTool,
            claimed.input,
            claimed.toolCallId,
          )?.connectionId !== claimed.connectionId) ||
        !originalTool ||
        typeof originalTool.execute !== "function" ||
        ("_serverId" in originalTool &&
          typeof originalTool._serverId === "string" &&
          originalTool._serverId !== claimed.serverId)
      ) {
        failLocalScopeStepUpContinuation(
          claimed.continuationId,
          "original tool is no longer available",
        );
        return {
          kind: "halted",
          outcome: "failed",
          reason: "original tool is no longer available",
        };
      }

      let replayError: unknown;
      let replayResult: unknown;
      const execute = originalTool.execute.bind(originalTool);
      const replayTool = {
        ...originalTool,
        execute: async (
          toolInput: unknown,
          options: Parameters<NonNullable<typeof originalTool.execute>>[1],
        ) => {
          markLocalScopeStepUpWireStarted(claimed.continuationId);
          try {
            replayResult = await execute(toolInput, options);
            return replayResult;
          } catch (error) {
            replayError = error;
            throw error;
          }
        },
      };
      // A sign-in the server refuses again right after the user signed in is
      // permanent: the model gets the repeat copy, no second card.
      const repeatedSignIn = (
        signal: Parameters<typeof emitRepeatedSignInNotice>[1]["signal"],
      ): MrtrChatResumeResolution => {
        failLocalScopeStepUpContinuation(
          claimed.continuationId,
          AUTH_CHALLENGE_REPEATED_REASON,
        );
        const repeatText = emitRepeatedSignInNotice(
          { write },
          {
            serverId: claimed.serverId,
            serverName: claimed.serverName,
            toolCallId: claimed.toolCallId,
            toolName: claimed.toolName,
            signal,
          },
        );
        return {
          kind: "recover",
          reason: AUTH_CHALLENGE_REPEATED_REASON,
          toolResultMessage: buildScopeStepUpErrorToolResult(
            claimed.toolCallId,
            claimed.toolName,
            repeatText,
          ),
        };
      };
      const replayHistory: ModelMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: claimed.toolCallId,
              toolName: claimed.toolName,
              input: claimed.input,
            },
          ],
        },
      ];

      let resultMessage: ModelMessage | undefined;
      try {
        const results = await executeToolCallsFromMessages(replayHistory, {
          tools: { [claimed.toolName]: replayTool },
          parallelToolExecution: false,
          modelVisibleMcpToolResults: input.modelVisibleMcpToolResults,
        });
        resultMessage = results[0];
      } catch (error) {
        replayError = replayError ?? error;
      }

      if (replayError) {
        const repeatedChallenge = scopeStepUpInfoFromToolError({
          error: replayError,
          serverId: claimed.serverId,
          toolCallId: claimed.toolCallId,
        });
        const repeatedAuthChallenge =
          claimed.reason === AUTH_CHALLENGE_REASON && !repeatedChallenge
            ? authChallengeInfoFromToolError({
                error: replayError,
                serverId: claimed.serverId,
                toolCallId: claimed.toolCallId,
              })
            : undefined;
        if (repeatedAuthChallenge) {
          return repeatedSignIn(repeatedAuthChallenge.signal);
        }
        if (repeatedChallenge) {
          failLocalScopeStepUpContinuation(
            claimed.continuationId,
            "insufficient_scope repeated after authorization",
          );
          return {
            kind: "recover",
            reason: "insufficient_scope repeated after authorization",
            toolResultMessage:
              resultMessage ??
              buildScopeStepUpErrorToolResult(
                claimed.toolCallId,
                claimed.toolName,
                "Authorization completed, but the server still rejected the requested scope.",
              ),
          };
        }
        cancelLocalScopeStepUpContinuation(
          claimed.continuationId,
          "tool replay failed after the request started",
        );
        return {
          kind: "halted",
          outcome: "indeterminate",
          reason:
            "The retried tool call lost its connection after starting and may have run.",
        };
      }

      if (!resultMessage) {
        failLocalScopeStepUpContinuation(
          claimed.continuationId,
          "tool replay returned no result",
        );
        return {
          kind: "halted",
          outcome: "failed",
          reason: "tool replay returned no result",
        };
      }
      // A challenged result is a refusal, not a success: it must not settle
      // the continuation as completed.
      const resultChallenge = parseToolResultAuthChallenge(replayResult);
      if (resultChallenge) {
        if (claimed.reason === AUTH_CHALLENGE_REASON) {
          return repeatedSignIn(resultChallenge);
        }
        failLocalScopeStepUpContinuation(
          claimed.continuationId,
          "the retried call returned a sign-in challenge",
        );
        return {
          kind: "recover",
          reason: "the retried call returned a sign-in challenge",
          toolResultMessage: resultMessage,
        };
      }
      completeLocalScopeStepUpContinuation(claimed.continuationId);
      write({
        type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
        data: {
          version: SCOPE_STEP_UP_VERSION,
          continuationId: claimed.continuationId,
          serverId: claimed.serverId,
          operation: {
            method: "tools/call",
            operation: claimed.toolName,
          },
          outcome: "completed",
        },
        transient: true,
      });
      return { kind: "complete", toolResultMessage: resultMessage };
    },
  };
}

export function buildLocalScopeStepUpCancellation(input: {
  request: ScopeStepUpCancelRequest;
  bindingKey: string;
}): MrtrEngineResume {
  return {
    toolCallId: input.request.toolCallId,
    resolve: async (write): Promise<MrtrChatResumeResolution> => {
      try {
        const cancelled = cancelLocalScopeStepUpContinuationForRequest({
          continuationId: input.request.continuationId,
          toolCallId: input.request.toolCallId,
          bindingKey: input.bindingKey,
          reason: "authorization was not completed",
        });
        write({
          type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
          data: {
            version: SCOPE_STEP_UP_VERSION,
            continuationId: input.request.continuationId,
            serverId: cancelled.serverId,
            operation: {
              method: "tools/call",
              operation: cancelled.toolName,
            },
            outcome: "cancelled",
          },
          transient: true,
        });
        if (cancelled.reason === AUTH_CHALLENGE_REASON) {
          return {
            kind: "recover",
            reason: "sign-in was not completed",
            toolResultMessage: buildScopeStepUpErrorToolResult(
              input.request.toolCallId,
              cancelled.toolName,
              authChallengeCancelledText(
                cancelled.serverName ?? cancelled.serverId,
                cancelled.toolName,
              ),
            ),
          };
        }
        return {
          kind: "recover",
          reason: "authorization was not completed",
          toolResultMessage: buildScopeStepUpErrorToolResult(
            input.request.toolCallId,
            cancelled.toolName,
            "Authorization was not completed, so the tool was not retried.",
          ),
        };
      } catch (error) {
        return {
          kind: "halted",
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * History settlement for local turns, plus a cancel the client spliced into
 * the user's next message.
 *
 * The spliced cancel is settled here instead of driving a resume leg: the
 * named call is answered with the reason-aware copy and the user's message
 * then runs as a normal turn. Its continuation is cancelled when it still
 * waits; when it is unknown or already expired the call is answered all the
 * same, so the message is never dropped. A replay that already started is
 * answered as one that may have run. Every other call a sign-in suspended
 * is answered from the store.
 */
export function buildLocalSuspendedCallSettlement(input: {
  bindingKey: string;
  splicedCancel?: ScopeStepUpCancelRequest;
  tools: ToolSet;
  serverNameFor: (serverId: string) => string;
  getWriter: () => { write: (chunk: UIMessageChunk) => void } | null;
}): SettleSuspendedToolCall {
  return ({ toolCallId, toolName }) => {
    if (input.splicedCancel?.toolCallId === toolCallId) {
      const cancelled = cancelLocalContinuationForNewMessage({
        continuationId: input.splicedCancel.continuationId,
        toolCallId,
        bindingKey: input.bindingKey,
      });
      if (!cancelled.found)
        return "Sign-in recovery could not be completed. This call was not retried.";
      const serverId =
        cancelled.serverId ??
        (input.tools as Record<string, { _serverId?: unknown }>)[toolName]
          ?._serverId;
      const serverName =
        typeof serverId === "string" ? input.serverNameFor(serverId) : "unknown";
      if (
        !cancelled.cancelled &&
        cancelled.status !== "expired" &&
        cancelled.status !== "cancelled"
      ) {
        return authChallengeMayHaveRunText(
          serverName,
          cancelled.toolName ?? toolName,
        );
      }
      if (cancelled.cancelled && cancelled.serverId) {
        input.getWriter()?.write({
          type: SCOPE_STEP_UP_FINISHED_DATA_PART_TYPE,
          data: {
            version: SCOPE_STEP_UP_VERSION,
            continuationId: input.splicedCancel.continuationId,
            serverId: cancelled.serverId,
            operation: {
              method: "tools/call",
              operation: cancelled.toolName ?? toolName,
            },
            outcome: "cancelled",
          },
          transient: true,
        } satisfies UIMessageChunk);
      }
      // A step-up the store still knows keeps its own copy; anything else the
      // client cancelled was a sign-in it was showing.
      if (cancelled.reason !== AUTH_CHALLENGE_REASON) {
        return "Authorization was not completed, so the tool was not retried.";
      }
      return authChallengeCancelledText(
        serverName,
        cancelled.toolName ?? toolName,
      );
    }
    const settled = settleLocalAuthChallengeHistoryCall({
      bindingKey: input.bindingKey,
      toolCallId,
    });
    return settled
      ? authChallengeCancelledText(
          settled.serverName ?? input.serverNameFor(settled.serverId),
          settled.toolName,
        )
      : undefined;
  };
}
