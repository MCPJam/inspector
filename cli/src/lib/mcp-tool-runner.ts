import type { EvalToolName } from "@mcpjam/sdk/internal/mcp-surface";
import { normalizeCliError } from "./output.js";

/** Every tool `mcpjam mcp` serves. Telemetry sends only these names. */
export const MCPJAM_MCP_TOOLS = [
  "connect_server",
  "disconnect_server",
  "list_servers",
  "server_info",
  "ping_server",
  "list_tools",
  "call_tool",
  "list_resources",
  "read_resource",
  "list_skills",
  "get_skill",
  "read_skill_file",
  "list_prompts",
  "get_prompt",
  "get_notifications",
  "server_doctor",
  "probe_server",
] as const;

export type McpJamMcpToolName = (typeof MCPJAM_MCP_TOOLS)[number];

/** One finished tool call. Carries no arguments, results or error text. */
export interface McpJamToolCall {
  /** A server-debugging tool, or one of the eval tools `--evals` adds. */
  tool: McpJamMcpToolName | EvalToolName;
  success: boolean;
  durationMs: number;
  /** The CLI error code when the call failed. */
  errorCode?: string;
}

export type OnToolCalled = (call: McpJamToolCall) => void;

function toToolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function toToolError(normalized: ReturnType<typeof normalizeCliError>) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: {
              code: normalized.code,
              message: normalized.message,
              ...(normalized.details === undefined
                ? {}
                : { details: normalized.details }),
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

/** Tells `onToolCalled` about a finished call; a throwing callback changes nothing. */
export function reportToolCall(
  onToolCalled: OnToolCalled | undefined,
  call: McpJamToolCall,
): void {
  try {
    onToolCalled?.(call);
  } catch {
    // Reporting is best-effort and must never affect the tool result.
  }
}

/**
 * Runs a tool's operation and turns its value or error into a tool result.
 * Each finished call is reported to `onToolCalled`, which `mcpjam mcp` uses
 * for telemetry so this server module stays free of it. A throwing callback
 * never changes the result.
 */
export function createToolRunner(onToolCalled?: OnToolCalled) {
  const report = (call: McpJamToolCall) => reportToolCall(onToolCalled, call);

  return async (
    tool: McpJamMcpToolName,
    operation: () => Promise<unknown>,
  ) => {
    const startedAt = Date.now();
    try {
      const result = toToolResult(await operation());
      report({ tool, success: true, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      const normalized = normalizeCliError(error);
      report({
        tool,
        success: false,
        durationMs: Date.now() - startedAt,
        errorCode: normalized.code,
      });
      return toToolError(normalized);
    }
  };
}
