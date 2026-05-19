import type {
  CallToolResult,
  ElicitRequest,
  ElicitResult,
  ListToolsResult,
} from "@modelcontextprotocol/client";
import type { MCPTask, TaskOptions } from "@mcpjam/sdk/browser";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";
import { authFetch } from "@/lib/session-token";
import { executeHostedTool, listHostedTools } from "@/lib/apis/web/tools-api";
import { isHostedMode, runByMode } from "@/lib/apis/mode-client";

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
      durationMs?: number;
    }
  | {
      status: "elicitation_required";
      executionId: string;
      requestId: string;
      request: ElicitRequest["params"];
      timestamp: string;
      durationMs?: number;
    }
  | {
      status: "task_created";
      task: TaskData;
      durationMs?: number;
      // Optional string for LLM hosts to return as immediate tool result while task executes
      // Per MCP Tasks spec (2025-11-25): io.modelcontextprotocol/model-immediate-response in _meta
      modelImmediateResponse?: string;
    }
  | {
      error: string;
    };

export async function listTools({
  serverId,
  modelId,
  cursor,
}: {
  serverId?: string | undefined;
  modelId?: string | undefined;
  cursor?: string | undefined;
}): Promise<ListToolsResultWithMetadata> {
  return runByMode({
    hosted: async () => {
      if (!serverId) {
        throw new Error("serverId is required in hosted mode");
      }
      return (await listHostedTools({
        serverNameOrId: serverId,
        modelId,
        cursor,
      })) as ListToolsResultWithMetadata;
    },
    local: async () => {
      const res = await authFetch("/api/mcp/tools/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, modelId, cursor }),
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
    },
  });
}

export async function executeToolApi(
  serverId: string,
  toolName: string,
  parameters: Record<string, unknown>,
  taskOptions?: TaskOptions,
): Promise<ToolExecutionResponse> {
  return runByMode({
    hosted: async () => {
      try {
        return (await executeHostedTool({
          serverNameOrId: serverId,
          toolName,
          parameters,
          taskOptions: taskOptions as Record<string, unknown> | undefined,
        })) as ToolExecutionResponse;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: message };
      }
    },
    local: async () => {
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
    },
  });
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
  if (isHostedMode()) {
    return {
      error: "Elicitation responses are not supported in hosted mode",
    };
  }

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
  /** Bare-name → serverId. Collision-prone (last-seen wins) — see `scopedMetadata` for unambiguous lookups. */
  toolServerMap: ToolServerMap;
  /** `${serverId}:${toolName}` → metadata. Multi-server collision-safe. */
  scopedMetadata: Record<string, Record<string, unknown>>;
  /** Bare tool names that appear on more than one server. */
  collidingToolNames: string[];
  tokenCounts: Record<string, number> | null;
  /**
   * Tool schemas advertised to the model (name + description + inputSchema),
   * keyed by bare tool name. Used by the Raw view when rendering rehydrated
   * sessions that never replayed `request_payload`. Last-seen wins on name
   * collisions, mirroring `toolServerMap`.
   */
  serializedTools: Record<string, SerializedModelRequestTool>;
}

export function getToolServerId(
  toolName: string,
  map: ToolServerMap,
): string | undefined {
  return map[toolName];
}

export function scopedToolKey(serverId: string, toolName: string): string {
  return `${serverId}:${toolName}`;
}

export async function getToolsMetadata(
  serverIds: string[],
  modelId?: string,
): Promise<ToolsMetadataAggregate> {
  const aggregate: ToolsMetadataAggregate = {
    metadata: {},
    toolServerMap: {},
    scopedMetadata: {},
    collidingToolNames: [],
    tokenCounts: modelId ? {} : null,
    serializedTools: {},
  };
  // Track which servers have seen each tool name so we can surface collisions
  // to callers (e.g. the Playground tools pane uses this to disambiguate via
  // a server badge).
  const seenOn = new Map<string, Set<string>>();

  await Promise.all(
    serverIds.map(async (serverId) => {
      const data = await listTools({ serverId, modelId });
      const toolsMetadata = data.toolsMetadata ?? {};

      for (const [toolName, meta] of Object.entries(toolsMetadata)) {
        aggregate.metadata[toolName] = meta as Record<string, unknown>;
        aggregate.toolServerMap[toolName] = serverId;
        aggregate.scopedMetadata[scopedToolKey(serverId, toolName)] =
          meta as Record<string, unknown>;
        const servers = seenOn.get(toolName) ?? new Set<string>();
        servers.add(serverId);
        seenOn.set(toolName, servers);
      }

      for (const tool of data.tools ?? []) {
        aggregate.serializedTools[tool.name] = {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
        };
      }

      // Collect token counts if modelId was provided
      if (modelId && data.tokenCount !== undefined && aggregate.tokenCounts) {
        aggregate.tokenCounts[serverId] = data.tokenCount;
      }
    }),
  );

  aggregate.collidingToolNames = Array.from(seenOn.entries())
    .filter(([, servers]) => servers.size > 1)
    .map(([name]) => name);

  return aggregate;
}
