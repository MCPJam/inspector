/**
 * Org BYOK Stream Handler
 *
 * Hosted-mode org BYOK chat: the LLM lives in Convex (so vault-resolved org
 * keys never leave Convex), while MCP tools execute locally in the inspector.
 *
 * Wraps handleMCPJamFreeChatModel and points it at /stream/org with the
 * inspector service token + the resolved providerKey.
 */

import type { ToolSet, UIMessageChunk } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { PersistedTurnTrace } from "./chat-ingestion";
import { handleMCPJamFreeChatModel } from "./mcpjam-stream-handler.js";

export interface OrgModelHandlerOptions {
  workspaceId: string;
  providerKey: string;
  modelId: string;
  messages: ModelMessage[];
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  mcpClientManager: MCPClientManager;
  selectedServers?: string[];
  requireToolApproval?: boolean;
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace,
  ) => Promise<void> | void;
  onStreamComplete?: () => Promise<void> | void;
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
  /**
   * The end user's Authorization header from the inbound request. Forwarded
   * to /stream/org so Convex can re-authorize the user against the workspace.
   * Without this, /stream/org can only authenticate the inspector backend
   * (via the service token) and will reject the request as unauthenticated.
   */
  authHeader?: string;
  /**
   * Hosted share/chatbox tokens for guest chat sessions. Forwarded to
   * /stream/org so Convex can authorize the guest against the workspace via
   * the existing authorizeGuestServerAccessBatch query.
   */
  shareToken?: string;
  chatboxToken?: string;
}

export async function handleHostedOrgChatModel(
  options: OrgModelHandlerOptions,
): Promise<Response> {
  if (!process.env.CONVEX_HTTP_URL) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  const inspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!inspectorServiceToken) {
    throw new Error("INSPECTOR_SERVICE_TOKEN is not set");
  }

  return handleMCPJamFreeChatModel({
    messages: options.messages,
    modelId: options.modelId,
    systemPrompt: options.systemPrompt,
    temperature: options.temperature,
    tools: options.tools,
    workspaceId: options.workspaceId,
    authHeader: options.authHeader,
    chatboxToken: options.chatboxToken,
    mcpClientManager: options.mcpClientManager,
    selectedServers: options.selectedServers,
    requireToolApproval: options.requireToolApproval,
    onConversationComplete: options.onConversationComplete,
    onStreamComplete: options.onStreamComplete,
    onStreamWriterReady: options.onStreamWriterReady,
    endpointPath: "/stream/org",
    extraHeaders: {
      "X-Inspector-Service-Token": inspectorServiceToken,
    },
    extraBodyFields: {
      providerKey: options.providerKey,
      ...(options.shareToken ? { shareToken: options.shareToken } : {}),
      // chatboxToken is set on the body by handleMCPJamFreeChatModel itself.
      ...(options.selectedServers && options.selectedServers.length > 0
        ? { serverIds: options.selectedServers }
        : {}),
    },
  });
}
