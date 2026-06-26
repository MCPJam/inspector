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
import {
  recordAppToolInvocation,
  useAppToolsRegistry,
} from "@/components/chat-v2/thread/mcp-apps/app-tools-registry";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

// Matches `app_<8 hex chars>` aliases minted by the app-tools registry.
// Kept local to avoid widening the registry's public surface; the registry
// owns the canonical pattern (`ALIAS_REGEX`) and exports it via `__internal`.
const APP_TOOL_ALIAS_REGEX = /^app_[a-z0-9]{8}$/i;

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

/**
 * Explicit reference to the playground's selected tool. Server tools are
 * keyed by their MCP name; app-provided tools (SEP-1865) are keyed by the
 * opaque `app_<hash>` alias the registry minted for them. Routing branches
 * on `kind` so server execution never accidentally calls the MCP server
 * with a synthetic alias.
 */
export type SelectedToolRef =
  | { kind: "server"; name: string }
  | { kind: "app"; alias: string };

/**
 * Classify a flat tool handle (server name or app alias) by consulting the
 * app-tools registry. Used by the App Builder execution path so the same
 * `selectedTool: string` slot can address both worlds without ambiguity.
 *
 * Read via `getState()` — callers are dispatch sites that just need the
 * current classification once, not a reactive subscription.
 */
export function classifySelectedTool(
  name: string | null,
): SelectedToolRef | null {
  if (!name) return null;
  const aliasEntry = useAppToolsRegistry.getState().aliases.get(name);
  if (aliasEntry) return { kind: "app", alias: name };
  // Treat alias-shaped handles as app even when the registry has forgotten
  // them — the executor surfaces a clean "no longer available" error rather
  // than routing the synthetic name to the MCP server (which would 404).
  if (APP_TOOL_ALIAS_REGEX.test(name)) return { kind: "app", alias: name };
  return { kind: "server", name };
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
      serverId?: string,
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
          error: "A tool selection is required.",
        };
      }

      // App-tool routing: when the selected handle is a registry alias, the
      // playground must dispatch into the live MCP App iframe via
      // `AppBridge.callTool` and NOT call the MCP server with the synthetic
      // `app_<hash>` alias. The alias is a model/server-orchestration name
      // only — the iframe knows the tool by its raw advertised name. See
      // SEP-1865 and `app-tools-registry.ts` for the contract.
      const selectedRef = classifySelectedTool(effectiveToolName);
      if (selectedRef?.kind === "app") {
        return executeAppTool({
          alias: selectedRef.alias,
          params,
          posthog,
          setExecutionError,
          setIsExecuting,
          storeCompletedToolResult,
        });
      }

      if (!effectiveServerName) {
        return {
          ok: false,
          error: "A connected server and tool selection are required.",
        };
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
          posthog.capture("app_builder_tool_executed", {
            location: "app_builder_tab",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            toolName: effectiveToolName,
            source: "server",
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
        storeCompletedToolResult(
          effectiveToolName,
          params,
          result,
          undefined,
          effectiveServerName,
        );

        // Log successful tool execution
        posthog.capture("app_builder_tool_executed", {
          location: "app_builder_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          toolName: effectiveToolName,
          source: "server",
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

interface ExecuteAppToolArgs {
  alias: string;
  params: Record<string, unknown>;
  posthog: ReturnType<typeof usePostHog>;
  setExecutionError: (error: string | null) => void;
  setIsExecuting: (executing: boolean) => void;
  storeCompletedToolResult: (
    effectiveToolName: string,
    params: Record<string, unknown>,
    result: unknown,
    toolCallId?: string,
    serverId?: string,
  ) => void;
}

/**
 * Dispatch a playground-issued tool call into the live MCP App iframe.
 *
 * Mirrors the chat-path dispatch in `use-chat-session.ts`: register an
 * `AbortController` against the bridge's pending set BEFORE awaiting so a
 * mid-flight iframe teardown rejects the await instead of hanging the UI,
 * and call back through the registry's pending bookkeeping in `finally`.
 *
 * The alias is the model/server-orchestration handle; the iframe knows
 * the tool by its `rawName`, so dispatch always uses `entry.rawName`.
 */
async function executeAppTool({
  alias,
  params,
  posthog,
  setExecutionError,
  setIsExecuting,
  storeCompletedToolResult,
}: ExecuteAppToolArgs): Promise<ExecuteToolInvocationResult> {
  const registry = useAppToolsRegistry.getState();
  const entry = registry.resolve(alias);
  // Tag posthog with the raw advertised name when we have it; aliases are
  // intentionally opaque and unhelpful for product analytics.
  const reportedName = entry?.rawName ?? alias;

  if (!entry) {
    const message =
      "App tool is no longer available — the widget was closed or replaced.";
    setExecutionError(message);
    posthog.capture("app_builder_tool_executed", {
      location: "app_builder_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      toolName: reportedName,
      source: "app",
      success: false,
      errorType: "stale_app_alias",
    });
    return {
      ok: false,
      toolName: alias,
      parameters: params,
      error: message,
    };
  }

  setIsExecuting(true);
  setExecutionError(null);

  const controller = new AbortController();
  registry.registerPendingCall(entry.instance.bridgeId, controller);

  try {
    const call = entry.bridge.callTool({
      name: entry.rawName,
      arguments: params,
    });
    const raw = await new Promise<
      Awaited<ReturnType<typeof entry.bridge.callTool>>
    >((resolve, reject) => {
      const onAbort = () =>
        reject(new Error("App iframe was torn down mid-dispatch"));
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      call.then(resolve, reject);
    });

    // Store the full untouched CallToolResult — the playground inspector
    // should be able to see `structuredContent`/`_meta` the chat path
    // intentionally strips before handing back to the model.
    storeCompletedToolResult(
      entry.rawName,
      params,
      raw,
      undefined,
      entry.instance.serverId,
    );

    recordAppToolInvocation(
      {
        alias,
        rawName: entry.rawName,
        appName: entry.instance.appName,
        serverId: entry.instance.serverId,
        parentToolCallId: entry.instance.parentToolCallId,
        bridgeId: entry.instance.bridgeId,
        input: params,
        raw,
      },
      useTrafficLogStore.getState().addLog,
    );

    posthog.capture("app_builder_tool_executed", {
      location: "app_builder_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      toolName: reportedName,
      source: "app",
      success: true,
    });

    return {
      ok: true,
      toolName: entry.rawName,
      parameters: params,
      result: raw,
      response: { status: "completed", result: raw },
    };
  } catch (err) {
    console.error("App tool execution error:", err);
    const message = err instanceof Error ? err.message : "App tool execution failed";
    setExecutionError(message);

    posthog.capture("app_builder_tool_executed", {
      location: "app_builder_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      toolName: reportedName,
      source: "app",
      success: false,
      errorType: "exception",
    });

    return {
      ok: false,
      toolName: entry.rawName,
      parameters: params,
      error: message,
    };
  } finally {
    registry.unregisterPendingCall(entry.instance.bridgeId, controller);
    setIsExecuting(false);
  }
}
