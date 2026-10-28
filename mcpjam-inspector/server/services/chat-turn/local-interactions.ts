import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
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
  claimLocalScopeStepUpContinuation,
  failLocalScopeStepUpContinuation,
  markLocalScopeStepUpWireStarted,
  cancelLocalScopeStepUpContinuation,
  completeLocalScopeStepUpContinuation,
  cancelLocalScopeStepUpContinuationForRequest,
} from "../../utils/scope-step-up-continuation.js";
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
      const execute = originalTool.execute.bind(originalTool);
      const replayTool = {
        ...originalTool,
        execute: async (
          toolInput: unknown,
          options: Parameters<NonNullable<typeof originalTool.execute>>[1],
        ) => {
          markLocalScopeStepUpWireStarted(claimed.continuationId);
          try {
            return await execute(toolInput, options);
          } catch (error) {
            replayError = error;
            throw error;
          }
        },
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
