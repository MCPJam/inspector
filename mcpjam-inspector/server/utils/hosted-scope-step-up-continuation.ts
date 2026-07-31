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

type HostedScopeStepUpState = {
  v: 1;
  serverId: string;
  resourceUrl?: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  inputHash: string;
};

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

export async function createHostedScopeStepUpContinuation(input: {
  bearer: string;
  authPrincipal: string;
  projectId: string;
  chatSessionId: string;
  manager: MCPClientManager;
  serverName?: string;
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

      let replayError: unknown;
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
