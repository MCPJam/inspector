import type { UIMessage } from "ai";
import type { XRayPayloadResponse } from "../mcp-xray-api";
import { webPost } from "./base";
import { buildHostedServerBatchRequest } from "./context";

export async function getHostedXRayPayload(request: {
  messages: UIMessage[];
  systemPrompt?: string;
  selectedServers?: string[];
}): Promise<XRayPayloadResponse> {
  const { workspaceId, serverIds, oauthTokens } = buildHostedServerBatchRequest(
    request.selectedServers ?? [],
  );

  return webPost("/api/web/xray-payload", {
    workspaceId,
    selectedServerIds: serverIds,
    oauthTokens,
    messages: request.messages,
    systemPrompt: request.systemPrompt,
  });
}
