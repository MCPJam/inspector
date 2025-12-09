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
import { executeToolApi } from "@/lib/apis/mcp-tools-api";
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
}

export interface UseToolExecutionOptions {
  serverName: string | undefined;
  selectedTool: string | null;
  formFields: FormField[];
  setIsExecuting: (executing: boolean) => void;
  setExecutionError: (error: string | null) => void;
  setToolOutput: (output: unknown) => void;
  setToolResponseMetadata: (meta: Record<string, unknown> | null) => void;
}

export interface UseToolExecutionReturn {
  pendingExecution: PendingExecution | null;
  clearPendingExecution: () => void;
  executeTool: () => Promise<void>;
}

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

  // Execute tool and set up pending injection
  const executeTool = useCallback(async () => {
    if (!selectedTool || !serverName) return;

    setIsExecuting(true);
    setExecutionError(null);

    try {
      const params = buildParametersFromFields(formFields);
      const response = await executeToolApi(serverName, selectedTool, params);

      if ("error" in response) {
        // Log tool execution failure
        posthog.capture("app_builder_tool_executed", {
          location: "app_builder_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          toolName: selectedTool,
          success: false,
          errorType: "api_error",
        });

        setExecutionError(response.error);
        setIsExecuting(false);
        return;
      }

      if (response.status === "elicitation_required") {
        setExecutionError(
          "Tool requires elicitation, which is not supported in the UI Playground yet.",
        );
        setIsExecuting(false);
        return;
      }

      const result = response.result;

      // Store raw output for inspector
      setToolOutput(result);

      // Extract metadata safely
      const meta = extractMetadata(result);
      setToolResponseMetadata(meta || null);

      // Set pending execution for chat thread to inject
      setPendingExecution({
        toolName: selectedTool,
        params,
        result,
        toolMeta: meta,
      });

      // Log successful tool execution
      posthog.capture("app_builder_tool_executed", {
        location: "app_builder_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        toolName: selectedTool,
        success: true,
      });
    } catch (err) {
      console.error("Tool execution error:", err);
      const errorMessage =
        err instanceof Error ? err.message : "Tool execution failed";

      posthog.capture("app_builder_tool_executed", {
        location: "app_builder_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        toolName: selectedTool,
        success: false,
        errorType: "exception",
      });

      setExecutionError(errorMessage);
    } finally {
      setIsExecuting(false);
    }
  }, [
    selectedTool,
    serverName,
    formFields,
    setIsExecuting,
    setExecutionError,
    setToolOutput,
    setToolResponseMetadata,
  ]);

  // Keyboard shortcut for execute (Cmd/Ctrl + Enter)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isExecuteShortcut = (e.metaKey || e.ctrlKey) && e.key === "Enter";
      if (isExecuteShortcut && selectedTool) {
        e.preventDefault();
        executeTool();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedTool, executeTool]);

  return {
    pendingExecution,
    clearPendingExecution,
    executeTool,
  };
}
