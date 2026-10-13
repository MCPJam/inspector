import { useLayoutEffect, useRef } from "react";
import isEqual from "fast-deep-equal";
import { setApiContext, type ApiContext } from "@/lib/apis/web/context";
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
  toolCallCancellation?: { legacy?: boolean; modern?: boolean };
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
  toolCallCancellation,
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
  // Callers rebuild some inputs as fresh objects with equal values. Each
  // publish bumps the revision every all-server tools/list fan-out refetches
  // on, so publishing on identity alone loops (PLB-145).
  const publishedRef = useRef<ApiContext | null>(null);

  // useLayoutEffect so the global hosted context is set synchronously before
  // any child useEffect hooks fire (e.g. fetchToolsMetadata in useChatSession).
  // With useEffect, React's bottom-up ordering means child passive effects run
  // between this effect's cleanup (which nulls the context) and its setup,
  // causing "Hosted server not found" errors for shared-chat OAuth servers.
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    const next: ApiContext = {
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
      toolCallCancellation,
      xaaPolicy,
      clientConfigSyncPending,
      getAccessToken,
      oauthTokensByServerId,
      scenarioId,
      accessVersion,
      isAuthenticated,
      hasSession,
    };
    if (publishedRef.current && isEqual(publishedRef.current, next)) {
      return;
    }
    publishedRef.current = next;
    setApiContext(next);
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
    toolCallCancellation,
    xaaPolicy,
    clientConfigSyncPending,
    getAccessToken,
    oauthTokensByServerId,
    scenarioId,
    accessVersion,
    isAuthenticated,
    hasSession,
  ]);

  // Torn down only when disabled or unmounted, not on every input change.
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    return () => {
      publishedRef.current = null;
      setApiContext(null);
    };
  }, [enabled]);
}
