import { webPost } from "./base";
import { buildHostedServerRequest } from "./context";

export async function listHostedTools(request: {
  serverNameOrId: string;
  modelId?: string;
  cursor?: string;
}): Promise<any> {
  const serverRequest = buildHostedServerRequest(request.serverNameOrId);
  return webPost("/api/web/tools/list", {
    ...serverRequest,
    modelId: request.modelId,
    cursor: request.cursor,
  });
}

export async function executeHostedTool(request: {
  serverNameOrId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  taskOptions?: Record<string, unknown>;
}): Promise<any> {
  const serverRequest = buildHostedServerRequest(request.serverNameOrId);
  return webPost("/api/web/tools/execute", {
    ...serverRequest,
    toolName: request.toolName,
    parameters: request.parameters,
    ...(request.taskOptions ? { taskOptions: request.taskOptions } : {}),
  });
}
