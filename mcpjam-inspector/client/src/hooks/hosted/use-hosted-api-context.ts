import { useLayoutEffect } from "react";
import { setApiContext } from "@/lib/apis/web/context";
import type {
  McpProtocolVersion,
  XaaEnterprisePolicy,
} from "@mcpjam/sdk/browser";

interface UseApiContextOptions {
  projectId: string | null;
  serverIdsByName: Record<string, string>;
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
  supportedProtocolVersions?: string[];
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
  // SEP-2243 mirroring, resolved from the active host's
  // `mcpProfile.toolParamHeaderMirroring`. Only ever `false`.
  mirrorToolParamHeaders?: boolean;
  // Sibling conformance knobs; only the non-default value is ever set.
  firstPageOnly?: true;
  supportsMrtr?: false;
  suppressListenChannel?: true;
  dropToolListChanged?: true;
  suppressLegacyRequestCancellation?: true;
  suppressModernRequestCancellation?: true;
  // Active host's enterprise-managed authorization policy (validated `on`
  // value only) — rides ad-hoc chat/eval request bodies.
  xaaPolicy?: XaaEnterprisePolicy;
  clientConfigSyncPending?: boolean;
  getAccessToken: () => Promise<string | undefined | null>;
  oauthTokensByServerId?: Record<string, string>;
  // Resolved scenario identity (post-redeem) — drives scenario-aware request
  // shaping inside the API context.
  scenarioId?: string;
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
  mirrorToolParamHeaders,
  firstPageOnly,
  supportsMrtr,
  suppressListenChannel,
  dropToolListChanged,
  suppressLegacyRequestCancellation,
  suppressModernRequestCancellation,
  xaaPolicy,
  clientConfigSyncPending,
  getAccessToken,
  oauthTokensByServerId,
  scenarioId,
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
      mirrorToolParamHeaders,
      firstPageOnly,
      supportsMrtr,
      suppressListenChannel,
      dropToolListChanged,
      suppressLegacyRequestCancellation,
      suppressModernRequestCancellation,
      xaaPolicy,
      clientConfigSyncPending,
      getAccessToken,
      oauthTokensByServerId,
      scenarioId,
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
    mirrorToolParamHeaders,
    firstPageOnly,
    supportsMrtr,
    suppressListenChannel,
    dropToolListChanged,
    suppressLegacyRequestCancellation,
    suppressModernRequestCancellation,
    xaaPolicy,
    clientConfigSyncPending,
    getAccessToken,
    oauthTokensByServerId,
    scenarioId,
    accessVersion,
    isAuthenticated,
    hasSession,
  ]);
}
