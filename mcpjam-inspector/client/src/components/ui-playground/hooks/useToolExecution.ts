/**
 * useToolExecution Hook
 *
 * Manages tool execution logic for the UI Playground.
 * Handles API calls, result processing, and pending
 * execution state for chat injection.
 */

import { useCallback, useEffect, useState } from "react";
import type { FormField } from "@/lib/tool-form";
import { buildParametersFromFields } from "@/lib/tool-form";
import {
  executeToolApi,
  type ToolExecutionResponse,
} from "@/lib/apis/mcp-tools-api";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

// Result metadata type for tool responses
interface ToolResponseMeta {
  [key: string]: unknown;
}

// Pending execution to be injected into chat
export interface PendingExecution {
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
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

export function useToolExecution({
  serverName,
  selectedTool,
  toolsMetadata,
  formFields,
  setIsExecuting,
  setExecutionError,
  setToolOutput,
  setToolResponseMetadata,
}: UseToolExecutionOptions): UseToolExecutionReturn {
  const posthog = usePostHog();

  // Pending execution to inject into chat thread
  const [pendingExecution, setPendingExecution] =
    useState<PendingExecution | null>(null);

  // Clear pending execution (called when chat consumes it)
  const clearPendingExecution = useCallback(() => {
    setPendingExecution(null);
  }, []);

  const storeCompletedToolResult = useCallback(
    (
      effectiveToolName: string,
      params: Record<string, unknown>,
      result: unknown,
      toolCallId?: string,
    ) => {
      // Store raw output for inspector
      setToolOutput(result);

      // Extract metadata safely
      const resultMeta = extractMetadata(result);
      setToolResponseMetadata(resultMeta || null);

      const definitionMeta = toolsMetadata[effectiveToolName];
      const mergedMeta =
        definitionMeta || resultMeta
          ? {
              ...(definitionMeta ?? {}),
              ...(resultMeta ?? {}),
            }
          : undefined;

      // Set pending execution for chat thread to inject
      setPendingExecution({
        toolName: effectiveToolName,
        params,
        result,
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
      const params =
        options?.parameters ?? buildParametersFromFields(effectiveFormFields);

      if (!effectiveToolName || !serverName) {
        return {
          ok: false,
          error: "A connected server and tool selection are required.",
        };
      }

      setIsExecuting(true);
      setExecutionError(null);

      try {
        const response = await executeToolApi(
          serverName,
          effectiveToolName,
          params,
        );

        if ("error" in response) {
          // Log tool execution failure
          posthog.capture("app_builder_tool_executed", {
            location: "app_builder_tab",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            toolName: effectiveToolName,
            success: false,
            errorType: "api_error",
          });

          setExecutionError(response.error);
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
        storeCompletedToolResult(effectiveToolName, params, result);

        // Log successful tool execution
        posthog.capture("app_builder_tool_executed", {
          location: "app_builder_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          toolName: effectiveToolName,
          success: true,
        });

        return {
          ok: true,
          toolName: effectiveToolName,
          parameters: params,
          result,
          response,
        };
      } catch (err) {
        console.error("Tool execution error:", err);
        const errorMessage =
          err instanceof Error ? err.message : "Tool execution failed";

        posthog.capture("app_builder_tool_executed", {
          location: "app_builder_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          toolName: effectiveToolName,
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
      posthog,
      selectedTool,
      serverName,
      setExecutionError,
      setIsExecuting,
      storeCompletedToolResult,
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
      storeCompletedToolResult(toolName, parameters, result, toolCallId);

      return {
        ok: true,
        toolName,
        parameters,
        result,
        response: { status: "completed", result },
      };
    },
    [setExecutionError, storeCompletedToolResult],
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
