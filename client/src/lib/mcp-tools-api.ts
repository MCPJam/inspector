import type {
  CallToolResult,
  ElicitRequest,
  ElicitResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

export type ListToolsResultWithMetadata = ListToolsResult & {
  toolsMetadata?: Record<string, Record<string, any>>;
};

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
      error: string;
    };

export async function listTools(
  serverId: string,
): Promise<ListToolsResultWithMetadata> {
  const res = await fetch("/api/mcp/tools/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId }),
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
): Promise<ToolExecutionResponse> {
  const res = await fetch("/api/mcp/tools/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, toolName, parameters }),
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
  return body as ToolExecutionResponse;
}

export async function respondToElicitationApi(
  requestId: string,
  response: ElicitResult,
): Promise<ToolExecutionResponse> {
  const res = await fetch("/api/mcp/tools/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, response }),
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
