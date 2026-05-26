import { useLayoutEffect } from "react";
import { setApiContext } from "@/lib/apis/web/context";
import type { McpProtocolVersion } from "@mcpjam/sdk/browser";

interface UseApiContextOptions {
  projectId: string | null;
  serverIdsByName: Record<string, string>;
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  supportedProtocolVersions?: string[];
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
  clientConfigSyncPending?: boolean;
  getAccessToken: () => Promise<string | undefined | null>;
  oauthTokensByServerId?: Record<string, string>;
  // Resolved chatbox identity (post-redeem) — drives chatbox-aware request
  // shaping inside the API context.
  chatboxId?: string;
  accessVersion?: number;
  isAuthenticated?: boolean;
  hasSession?: boolean;
  enabled?: boolean;
}

export function useApiContext({
  projectId,
  serverIdsByName,
  clientCapabilities,
  clientInfo,
  supportedProtocolVersions,
  mcpProtocolVersionsByServerId,
  clientConfigSyncPending,
  getAccessToken,
  oauthTokensByServerId,
  chatboxId,
  accessVersion,
  isAuthenticated,
  hasSession,
  enabled = true,
}: UseApiContextOptions): void {
  // useLayoutEffect so the global hosted context is set synchronously before
  // any child useEffect hooks fire (e.g. fetchToolsMetadata in useChatSession).
  // With useEffect, React's bottom-up ordering means child passive effects run
  // between this effect's cleanup (which nulls the context) and its setup,
  // causing "Hosted server not found" errors for shared-chat OAuth servers.
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    setApiContext({
      projectId,
      serverIdsByName,
      clientCapabilities,
      clientInfo,
      supportedProtocolVersions,
      mcpProtocolVersionsByServerId,
      clientConfigSyncPending,
      getAccessToken,
      oauthTokensByServerId,
      chatboxId,
      accessVersion,
      isAuthenticated,
      hasSession,
    });

    return () => {
      setApiContext(null);
    };
  }, [
    enabled,
    projectId,
    serverIdsByName,
    clientCapabilities,
    clientInfo,
    supportedProtocolVersions,
    mcpProtocolVersionsByServerId,
    clientConfigSyncPending,
    getAccessToken,
    oauthTokensByServerId,
    chatboxId,
    accessVersion,
    isAuthenticated,
    hasSession,
  ]);
}
