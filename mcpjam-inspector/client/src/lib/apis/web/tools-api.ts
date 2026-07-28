import { webPost } from "./base";
import { buildServerRequest } from "./context";
import { webPostWithMrtr } from "./mrtr-api";

export async function listHostedTools(request: {
  serverNameOrId: string;
  modelId?: string;
  cursor?: string;
}): Promise<any> {
  const serverRequest = buildServerRequest(request.serverNameOrId);
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
  /** SEP-2663 per-request declaration that a task response is acceptable. */
  allowTaskResult?: boolean;
}): Promise<any> {
  const serverRequest = buildServerRequest(request.serverNameOrId);
  // Carries the hosted-MRTR handshake and drives any `input_required` rounds
  // (§12.5) through the shared dialog rail before resolving, so this still
  // settles with a single `{ status: "completed", result }` envelope.
  return webPostWithMrtr(
    "/api/web/tools/execute",
    {
      ...serverRequest,
      toolName: request.toolName,
      parameters: request.parameters,
      // The two are different wires and the route rejects both at once.
      ...(request.taskOptions ? { taskOptions: request.taskOptions } : {}),
      ...(request.allowTaskResult ? { allowTaskResult: true } : {}),
    },
    {
      serverNameOrId: request.serverNameOrId,
      wrapResult: (result) => ({ status: "completed", result }),
    },
  );
}
