import type {
  CallToolResult,
  ElicitRequest,
  ElicitResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { MCPTask, TaskOptions } from "@/sdk";
import { authFetch } from "@/lib/session-token";

export type ListToolsResultWithMetadata = ListToolsResult & {
  toolsMetadata?: Record<string, Record<string, any>>;
  tokenCount?: number;
};

export type ToolServerMap = Record<string, string>;

export type { TaskOptions };

// Re-export SDK type for task data
export type TaskData = MCPTask;

export type ToolExecutionResponse =
  | {
      status: "completed";
      result: CallToolResult;
    }
  | {
      status: "elicitation_required";
      executionId: string;
      requestId: string;
      request: ElicitRequest["params"];
      timestamp: string;
    }
  | {
      status: "task_created";
      task: TaskData;
      // Optional string for LLM hosts to return as immediate tool result while task executes
      // Per MCP Tasks spec (2025-11-25): io.modelcontextprotocol/model-immediate-response in _meta
      modelImmediateResponse?: string;
    }
  | {
      error: string;
    };

export async function listTools(
  serverId: string,
  modelId?: string,
): Promise<ListToolsResultWithMetadata> {
  const res = await authFetch("/api/mcp/tools/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, modelId }),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    const message = body?.error || `List tools failed (${res.status})`;
    throw new Error(message);
  }
  return body as ListToolsResultWithMetadata;
}

export async function executeToolApi(
  serverId: string,
  toolName: string,
  parameters: Record<string, unknown>,
  taskOptions?: TaskOptions,
): Promise<ToolExecutionResponse> {
  const res = await authFetch("/api/mcp/tools/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, toolName, parameters, taskOptions }),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    // Surface server-provided error message if present
    const message = body?.error || `Execute tool failed (${res.status})`;
    return { error: message } as ToolExecutionResponse;
  }

  // Server now returns { status: "task_created", task: { taskId, ... } } for task-augmented requests
  // per MCP Tasks spec (2025-11-25)
  return body as ToolExecutionResponse;
}

export async function callTool(
  serverId: string,
  toolName: string,
  parameters: Record<string, unknown>,
): Promise<CallToolResult> {
  const response = await executeToolApi(serverId, toolName, parameters);

  if ("error" in response) {
    throw new Error(response.error);
  }

  if (response.status === "elicitation_required") {
    throw new Error(
      "Tool execution requires elicitation, which is not supported in the emulator yet.",
    );
  }

  return (response as { result: CallToolResult }).result;
}

export async function respondToElicitationApi(
  executionId: string,
  requestId: string,
  response: ElicitResult,
): Promise<ToolExecutionResponse> {
  const res = await authFetch("/api/mcp/tools/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ executionId, requestId, response }),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    const message = body?.error || `Respond failed (${res.status})`;
    return { error: message } as ToolExecutionResponse;
  }
  return body as ToolExecutionResponse;
}

export interface ToolsMetadataAggregate {
  metadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  tokenCounts: Record<string, number> | null;
}

export function getToolServerId(
  toolName: string,
  map: ToolServerMap,
): string | undefined {
  return map[toolName];
}

export async function getToolsMetadata(
  serverIds: string[],
  modelId?: string,
): Promise<ToolsMetadataAggregate> {
  const aggregate: ToolsMetadataAggregate = {
    metadata: {},
    toolServerMap: {},
    tokenCounts: modelId ? {} : null,
  };

  await Promise.all(
    serverIds.map(async (serverId) => {
      const data = await listTools(serverId, modelId);
      const toolsMetadata = data.toolsMetadata ?? {};

      for (const [toolName, meta] of Object.entries(toolsMetadata)) {
        aggregate.metadata[toolName] = meta as Record<string, unknown>;
        aggregate.toolServerMap[toolName] = serverId;
      }

      // Collect token counts if modelId was provided
      if (modelId && data.tokenCount !== undefined && aggregate.tokenCounts) {
        aggregate.tokenCounts[serverId] = data.tokenCount;
      }
    }),
  );

  return aggregate;
}
