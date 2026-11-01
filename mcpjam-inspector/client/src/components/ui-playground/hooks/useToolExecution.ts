/**
 * useToolExecution Hook
 *
 * Manages tool execution logic for the UI Playground.
 * Handles API calls, result processing, and pending
 * execution state for chat injection.
 */

import type { AuthChallengeAttempt } from "@/state/oauth-orchestrator";
import { useCallback, useEffect, useState } from "react";
import type { FormField } from "@/lib/tool-form";
import { buildParametersFromFields } from "@/lib/tool-form";
import {
  executeToolApi,
  type ToolExecutionResponse,
} from "@/lib/apis/mcp-tools-api";
import { readResource } from "@/lib/apis/mcp-resources-api";
import { reportCaught } from "@/lib/error-reporting";
import {
  driveScopeStepUpFromChallenge,
  resetScopeStepUp,
} from "@/lib/scope-step-up";
import {
  isActionableStepUpChallenge,
  parseInsufficientScopeChallenge,
} from "@/lib/apis/insufficient-scope";
import { savePendingDirectScopeStepUpReplay } from "@/lib/scope-step-up-replay";
import { clearAuthChallengeCards } from "@/lib/auth-challenge-lifecycle";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import {
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
  type McpModelVisibleToolResultPolicy,
} from "@mcpjam/sdk/browser";
import { track } from "@/lib/analytics";
import { useToolAuthChallengePresentation } from "./useToolAuthChallengeReplay";

// Result metadata type for tool responses
interface ToolResponseMeta {
  [key: string]: unknown;
}

// Pending execution to be injected into chat
export interface PendingExecution {
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  modelOutput?: unknown;
  toolMeta: Record<string, unknown> | undefined;
  toolCallId?: string;
}

export interface UseToolExecutionOptions {
  serverName: string | undefined;
  selectedTool: string | null;
  toolsMetadata: Record<string, Record<string, unknown>>;
  formFields: FormField[];
  setIsExecuting: (executing: boolean) => void;
  setExecutionError: (error: string | null) => void;
  setToolOutput: (output: unknown) => void;
  setToolResponseMetadata: (meta: Record<string, unknown> | null) => void;
  modelVisibleMcpToolResults?: McpModelVisibleToolResultPolicy["modelVisibleMcpToolResults"];
  /**
   * The listed tools, read for `readOnlyHint`, which the sign-in card
   * reports. Reads and writes both run again after a mid-session sign-in.
   */
  tools?: Record<string, { annotations?: unknown }>;
}

export interface UseToolExecutionReturn {
  pendingExecution: PendingExecution | null;
  clearPendingExecution: () => void;
  executeTool: (
    options?: ExecuteToolInvocationOptions,
  ) => Promise<ExecuteToolInvocationResult>;
  injectToolResult: (
    options: InjectToolResultOptions,
  ) => Promise<CompletedToolInvocationResult>;
}

export interface ExecuteToolInvocationOptions {
  toolName?: string;
  parameters?: Record<string, unknown>;
  formFields?: FormField[];
  /**
   * Override the hook-init `serverName` for this call. Used by the Playground
   * multi-server tools pane to route execution to the correct server when the
   * user selects a tool from a non-primary server.
   */
  serverName?: string;
  /** Internal: the one post-OAuth replay must never start another redirect. */
  scopeStepUpReplay?: boolean;
  authAttempt?: AuthChallengeAttempt;
  /**
   * The call comes from an inspector command or an agent, not a click. It
   * never offers sign-in: a challenge is reported to the caller instead.
   */
  fromCommand?: boolean;
}

export interface InjectToolResultOptions {
  toolName: string;
  parameters: Record<string, unknown>;
  result: unknown;
  toolCallId?: string;
}

export type CompletedToolInvocationResult = {
  ok: true;
  toolName: string;
  parameters: Record<string, unknown>;
  result: unknown;
  response: { status: "completed"; result: unknown; durationMs?: number };
};

export type ExecuteToolInvocationResult =
  | CompletedToolInvocationResult
  | {
      ok: false;
      toolName?: string;
      parameters?: Record<string, unknown>;
      error: string;
      response?: ToolExecutionResponse;
    };

/**
 * Safely extracts metadata from tool result.
 */
function extractMetadata(result: unknown): ToolResponseMeta | undefined {
  if (result === null || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const meta = record._meta ?? record.meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  return meta as ToolResponseMeta;
}

function resolveDirectModelOutputForToolResult(
  result: unknown,
  policy: McpModelVisibleToolResultPolicy,
): unknown | undefined {
  try {
    return mcpCallToolResultToModelOutput(result as never, policy);
  } catch {
    return undefined;
  }
}

async function resolveModelOutputForToolResult(
  result: unknown,
  serverId: string | undefined,
  policy: McpModelVisibleToolResultPolicy,
): Promise<unknown | undefined> {
  if (serverId) {
    let linkedReadFailed = false;
    try {
      const modelOutput =
        await mcpCallToolResultToModelOutputWithLinkedResources(
          result as never,
          {
            ...policy,
            readResource: async ({ uri }) => {
              try {
                return await readResource(serverId, uri);
              } catch (error) {
                linkedReadFailed = true;
                throw error;
              }
            },
          },
        );
      return linkedReadFailed
        ? resolveDirectModelOutputForToolResult(result, policy)
        : modelOutput;
    } catch {
      return resolveDirectModelOutputForToolResult(result, policy);
    }
  }

  return resolveDirectModelOutputForToolResult(result, policy);
}

export function useToolExecution({
  serverName,
  selectedTool,
  toolsMetadata,
  formFields,
  setIsExecuting,
  setExecutionError,
  setToolOutput,
  setToolResponseMetadata,
  modelVisibleMcpToolResults,
  tools,
}: UseToolExecutionOptions): UseToolExecutionReturn {
  // Pending execution to inject into chat thread
  const [pendingExecution, setPendingExecution] =
    useState<PendingExecution | null>(null);

  // Clear pending execution (called when chat consumes it)
  const clearPendingExecution = useCallback(() => {
    setPendingExecution(null);
  }, []);

  // SEP-2350 step-up. Resolve the live server entry (non-throwing: the hook is
  // exercised in tests without an AppStateProvider) so the orchestrator can read
  // its stored issuer + originally-granted scopes on a `403 insufficient_scope`.
  const sharedAppState = useOptionalSharedAppState();
  const resetStepUpOnSuccess = useCallback(
    (
      name: string | undefined,
      toolName: string,
      attempt?: AuthChallengeAttempt,
    ) => {
      const liveServer = name ? sharedAppState?.servers[name] : undefined;
      resetScopeStepUp(
        liveServer,
        {
          method: "tools/call",
          operation: toolName,
        },
        attempt,
      );
      if (liveServer) clearAuthChallengeCards(liveServer.name, attempt);
    },
    [sharedAppState],
  );

  const presentAuthChallengeFromResponse = useToolAuthChallengePresentation(
    sharedAppState,
    tools,
    setExecutionError,
  );

  const driveStepUpFromResponse = useCallback(
    (
      name: string | undefined,
      toolName: string,
      parameters: Record<string, unknown>,
      response: ToolExecutionResponse,
    ) => {
      const challenge = parseInsufficientScopeChallenge(
        (response as { insufficientScope?: unknown }).insufficientScope,
      );
      const replayServer = name ? sharedAppState?.servers[name] : undefined;
      if (name && isActionableStepUpChallenge(challenge)) {
        savePendingDirectScopeStepUpReplay({
          operation: {
            resourceUrl: String((replayServer?.config as any)?.url ?? name),
            method: "tools/call",
            operation: toolName,
          },
          descriptor: {
            kind: "tool",
            surface: "playground",
            serverName: name,
            toolName,
            parameters,
          },
        });
      }
      driveScopeStepUpFromChallenge(replayServer, challenge, {
        method: "tools/call",
        operation: toolName,
      });
    },
    [sharedAppState],
  );

  const storeCompletedToolResult = useCallback(
    (
      effectiveToolName: string,
      params: Record<string, unknown>,
      result: unknown,
      toolCallId?: string,
      serverId?: string,
      modelOutput?: unknown,
    ) => {
      // Store raw output for inspector
      setToolOutput(result);

      // Extract metadata safely
      const resultMeta = extractMetadata(result);
      setToolResponseMetadata(resultMeta || null);

      const definitionMeta = toolsMetadata[effectiveToolName];
      const mergedMeta =
        definitionMeta || resultMeta || serverId
          ? {
              ...(definitionMeta ?? {}),
              ...(resultMeta ?? {}),
              ...(serverId ? { _serverId: serverId } : {}),
            }
          : undefined;

      // Set pending execution for chat thread to inject
      setPendingExecution({
        toolName: effectiveToolName,
        params,
        result,
        ...(modelOutput ? { modelOutput } : {}),
        toolMeta: mergedMeta,
        ...(toolCallId ? { toolCallId } : {}),
      });
    },
    [setToolOutput, setToolResponseMetadata, toolsMetadata],
  );

  const executeTool = useCallback(
    async (
      options?: ExecuteToolInvocationOptions,
    ): Promise<ExecuteToolInvocationResult> => {
      const effectiveToolName = options?.toolName ?? selectedTool;
      const effectiveFormFields = options?.formFields ?? formFields;
      const effectiveServerName = options?.serverName ?? serverName;
      const params =
        options?.parameters ?? buildParametersFromFields(effectiveFormFields);

      if (!effectiveToolName) {
        return {
          ok: false,
          error: "Select a tool to run.",
        };
      }

      if (!effectiveServerName) {
        return {
          ok: false,
          error: "Connect to a server, then select a tool to run.",
        };
      }

      const liveServer = sharedAppState?.servers[effectiveServerName];
      if (liveServer && liveServer.connectionStatus !== "connected") {
        const error = "Reconnect the server before running this tool.";
        setExecutionError(error);
        return { ok: false, error };
      }

      setIsExecuting(true);
      setExecutionError(null);

      try {
        const response = await executeToolApi(
          effectiveServerName,
          effectiveToolName,
          params,
        );

        if ("error" in response) {
          // Log tool execution failure
          track("app_builder_tool_executed", {
            location: "app_builder_tab",
            toolName: effectiveToolName,
            source: "server",
            success: false,
            errorType: "api_error",
          });

          setExecutionError(response.error);
          // SEP-2350: on a `403 insufficient_scope`, drive the union-scope
          // step-up re-authorization for this server.
          if (!options?.scopeStepUpReplay) {
            driveStepUpFromResponse(
              effectiveServerName,
              effectiveToolName,
              params,
              response,
            );
          }
          if (!options?.scopeStepUpReplay && !options?.fromCommand) {
            presentAuthChallengeFromResponse(
              effectiveServerName,
              effectiveToolName,
              params,
              response,
            );
          }
          return {
            ok: false,
            toolName: effectiveToolName,
            parameters: params,
            error: response.error,
            response,
          };
        }

        if (response.status === "elicitation_required") {
          const error =
            "Tool requires elicitation, which is not supported in the UI Playground yet.";
          setExecutionError(error);
          return {
            ok: false,
            toolName: effectiveToolName,
            parameters: params,
            error,
            response,
          };
        }

        if (response.status === "task_created") {
          const error =
            "Task-based tool execution is not supported in the UI Playground yet.";
          setExecutionError(error);
          return {
            ok: false,
            toolName: effectiveToolName,
            parameters: params,
            error,
            response,
          };
        }

        const result = response.result;
        const modelOutput = await resolveModelOutputForToolResult(
          result,
          effectiveServerName,
          { modelVisibleMcpToolResults },
        );
        storeCompletedToolResult(
          effectiveToolName,
          params,
          result,
          undefined,
          effectiveServerName,
          modelOutput,
        );

        // Log successful tool execution
        track("app_builder_tool_executed", {
          location: "app_builder_tab",
          toolName: effectiveToolName,
          source: "server",
          success: true,
        });

        // SEP-2350: a successful call clears the bounded step-up counter. A
        // result carrying a sign-in challenge is a refusal, not a success,
        // and the one post-sign-in replay never prompts again.
        if (response.authChallenge) {
          if (!options?.scopeStepUpReplay && !options?.fromCommand) {
            presentAuthChallengeFromResponse(
              effectiveServerName,
              effectiveToolName,
              params,
              response,
            );
          }
        } else {
          resetStepUpOnSuccess(
            effectiveServerName,
            effectiveToolName,
            options?.authAttempt,
          );
        }

        return {
          ok: true,
          toolName: effectiveToolName,
          parameters: params,
          result,
          response,
        };
      } catch (err) {
        console.error("Tool execution error:", err);
        reportCaught(err, {
          source: "app_builder_tool_execution",
          extra: { toolName: effectiveToolName, toolSource: "server" },
        });
        const errorMessage =
          err instanceof Error ? err.message : "Tool execution failed";

        track("app_builder_tool_executed", {
          location: "app_builder_tab",
          toolName: effectiveToolName,
          source: "server",
          success: false,
          errorType: "exception",
        });

        setExecutionError(errorMessage);
        return {
          ok: false,
          toolName: effectiveToolName,
          parameters: params,
          error: errorMessage,
        };
      } finally {
        setIsExecuting(false);
      }
    },
    [
      formFields,
      selectedTool,
      serverName,
      setExecutionError,
      setIsExecuting,
      storeCompletedToolResult,
      modelVisibleMcpToolResults,
      driveStepUpFromResponse,
      presentAuthChallengeFromResponse,
      resetStepUpOnSuccess,
    ],
  );

  const injectToolResult = useCallback(
    async ({
      toolName,
      parameters,
      result,
      toolCallId,
    }: InjectToolResultOptions): Promise<CompletedToolInvocationResult> => {
      setExecutionError(null);
      const modelOutput = await resolveModelOutputForToolResult(
        result,
        undefined,
        { modelVisibleMcpToolResults },
      );
      storeCompletedToolResult(
        toolName,
        parameters,
        result,
        toolCallId,
        undefined,
        modelOutput,
      );

      return {
        ok: true,
        toolName,
        parameters,
        result,
        response: { status: "completed", result },
      };
    },
    [setExecutionError, storeCompletedToolResult, modelVisibleMcpToolResults],
  );

  // Keyboard shortcut for execute (Cmd/Ctrl + Enter)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isExecuteShortcut = (e.metaKey || e.ctrlKey) && e.key === "Enter";
      if (isExecuteShortcut && selectedTool) {
        e.preventDefault();
        void executeTool();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedTool, executeTool]);

  return {
    pendingExecution,
    clearPendingExecution,
    executeTool,
    injectToolResult,
  };
}
