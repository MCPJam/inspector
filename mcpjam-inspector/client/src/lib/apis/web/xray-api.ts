import type { UIMessage } from "ai";
import type { XRayPayloadResponse } from "../mcp-xray-api";
import { webPost } from "./base";
import {
  isGuestMode,
  buildHostedServerRequest,
  buildHostedServerBatchRequest,
} from "./context";

export async function getHostedXRayPayload(request: {
  messages: UIMessage[];
  systemPrompt?: string;
  selectedServers?: string[];
}): Promise<XRayPayloadResponse> {
  const servers = request.selectedServers ?? [];

  if (isGuestMode() && servers.length > 0) {
    // Guest mode: send the first server's direct config (serverUrl, etc.)
    // instead of workspaceId + serverIds. The server endpoint detects the
    // guest shape and creates a direct ephemeral connection.
    const guestFields = buildHostedServerRequest(servers[0]);

    return webPost("/api/web/xray-payload", {
      ...guestFields,
      messages: request.messages,
      systemPrompt: request.systemPrompt,
    });
  }

  const { workspaceId, serverIds, oauthTokens } =
    buildHostedServerBatchRequest(servers);

  return webPost("/api/web/xray-payload", {
    workspaceId,
    selectedServerIds: serverIds,
    oauthTokens,
    messages: request.messages,
    systemPrompt: request.systemPrompt,
  });
}
