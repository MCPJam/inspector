import { useEffect, useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import {
  listTools,
  type ListToolsResultWithMetadata,
  type ToolServerMap,
} from "@/lib/apis/mcp-tools-api";
import { HOSTED_MODE } from "@/lib/config";
import { CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE } from "@/lib/client-config";
import { buildOAuthTokensByServerId } from "@/lib/oauth/oauth-tokens";
import { useWorkspaceClientConfigSyncPending } from "@/hooks/use-workspace-client-config-sync-pending";
import { useWorkspaceServers } from "@/hooks/useViews";
import { useSharedAppState } from "@/state/app-state-context";

const EMPTY_SERVER_NAMES: string[] = [];

type EvalTraceToolContextState = {
  toolsMetadata: Record<string, Record<string, unknown>>;
  toolServerMap: ToolServerMap;
  connectedServerIds: string[];
  hostedSelectedServerIds: string[];
  hostedOAuthTokens?: Record<string, string>;
  isLoading: boolean;
  isReady: boolean;
  error: string | null;
};

function buildEmptyState(
  overrides: Partial<EvalTraceToolContextState> = {},
): EvalTraceToolContextState {
  return {
    toolsMetadata: {},
    toolServerMap: {},
    connectedServerIds: [],
    hostedSelectedServerIds: [],
    hostedOAuthTokens: undefined,
    isLoading: false,
    isReady: false,
    error: null,
    ...overrides,
  };
}

function isTransientHostedToolContextError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const withMessage = error as { message?: unknown; status?: unknown };
  if (withMessage.status === 401 || withMessage.status === 403) {
    return true;
  }

  if (typeof withMessage.message !== "string") {
    return false;
  }

  return (
    withMessage.message === CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE ||
    withMessage.message === "Hosted workspace is not available yet" ||
    withMessage.message.startsWith("Hosted server not found") ||
    /\b(401|403)\b|unauthorized|forbidden/i.test(withMessage.message)
  );
}

export function useEvalTraceToolContext({
  serverNames = EMPTY_SERVER_NAMES,
  workspaceId,
  retryKey,
}: {
  serverNames?: string[];
  workspaceId?: string | null;
  retryKey?: string | number | null;
}) {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const appState = useSharedAppState();
  const activeWorkspace = appState.workspaces[appState.activeWorkspaceId];
  const effectiveHostedWorkspaceId =
    workspaceId ?? activeWorkspace?.sharedWorkspaceId ?? null;
  const isClientConfigSyncPending = useWorkspaceClientConfigSyncPending(
    appState.activeWorkspaceId,
  );
  const serverNamesSignature = useMemo(
    () => Array.from(new Set(serverNames.filter(Boolean))).join("\u0000"),
    [serverNames],
  );
  const normalizedServerNames = useMemo(
    () =>
      serverNamesSignature.length > 0
        ? serverNamesSignature.split("\u0000")
        : EMPTY_SERVER_NAMES,
    [serverNamesSignature],
  );
  const { serversByName, isLoading: isWorkspaceServersLoading } =
    useWorkspaceServers({
      isAuthenticated,
      workspaceId: effectiveHostedWorkspaceId,
    });
  const hostedSelectedServerIds = useMemo(
    () =>
      normalizedServerNames
        .map((serverName) => serversByName.get(serverName))
        .filter((serverId): serverId is string => !!serverId),
    [normalizedServerNames, serversByName],
  );
  const hostedOAuthTokens = useMemo(
    () =>
      buildOAuthTokensByServerId(
        normalizedServerNames,
        (serverName) => serversByName.get(serverName),
        (serverName) => appState.servers[serverName]?.oauthTokens?.access_token,
      ),
    [normalizedServerNames, serversByName, appState.servers],
  );
  const hostedContextReady =
    !HOSTED_MODE ||
    (Boolean(effectiveHostedWorkspaceId) &&
      !isAuthLoading &&
      isAuthenticated &&
      !isWorkspaceServersLoading &&
      !isClientConfigSyncPending &&
      hostedSelectedServerIds.length === normalizedServerNames.length);
  const [state, setState] = useState<EvalTraceToolContextState>(() =>
    buildEmptyState({
      isLoading: normalizedServerNames.length > 0,
      isReady: normalizedServerNames.length === 0,
    }),
  );

  useEffect(() => {
    let cancelled = false;

    if (normalizedServerNames.length === 0) {
      setState(buildEmptyState({ isReady: true }));
      return () => {
        cancelled = true;
      };
    }

    if (!hostedContextReady) {
      setState((previous) =>
        buildEmptyState({
          toolsMetadata: previous.toolsMetadata,
          toolServerMap: previous.toolServerMap,
          connectedServerIds: previous.connectedServerIds,
          hostedSelectedServerIds,
          hostedOAuthTokens,
          isLoading: true,
        }),
      );
      return () => {
        cancelled = true;
      };
    }

    setState((previous) =>
      buildEmptyState({
        toolsMetadata: previous.toolsMetadata,
        toolServerMap: previous.toolServerMap,
        connectedServerIds: previous.connectedServerIds,
        hostedSelectedServerIds,
        hostedOAuthTokens,
        isLoading: true,
      }),
    );

    async function run() {
      try {
        const responses = await Promise.all(
          normalizedServerNames.map(
            async (serverName) =>
              [serverName, await listTools({ serverId: serverName })] as const,
          ),
        );

        if (cancelled) {
          return;
        }

        const nextToolsMetadata: Record<string, Record<string, unknown>> = {};
        const nextToolServerMap: ToolServerMap = {};
        const nextConnectedServerIds = new Set<string>();
        const hostedServerIdByName = new Map(
          normalizedServerNames.map((serverName, index) => [
            serverName,
            hostedSelectedServerIds[index] ?? serverName,
          ]),
        );

        for (const serverName of normalizedServerNames) {
          const resolvedServerId =
            hostedServerIdByName.get(serverName) ?? serverName;
          nextConnectedServerIds.add(serverName);
          nextConnectedServerIds.add(resolvedServerId);
        }

        for (const [serverName, result] of responses) {
          const resolvedServerId =
            hostedServerIdByName.get(serverName) ?? serverName;

          for (const tool of result.tools ?? []) {
            nextToolServerMap[tool.name] = resolvedServerId;
          }

          if (result.toolsMetadata) {
            for (const [toolName, meta] of Object.entries(
              result.toolsMetadata,
            )) {
              nextToolsMetadata[toolName] = meta as Record<string, unknown>;
            }
          }
        }

        setState(
          buildEmptyState({
            toolsMetadata: nextToolsMetadata,
            toolServerMap: nextToolServerMap,
            connectedServerIds: Array.from(nextConnectedServerIds),
            hostedSelectedServerIds,
            hostedOAuthTokens,
            isReady: true,
          }),
        );
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (HOSTED_MODE && isTransientHostedToolContextError(error)) {
          setState((previous) =>
            buildEmptyState({
              toolsMetadata: previous.toolsMetadata,
              toolServerMap: previous.toolServerMap,
              connectedServerIds: previous.connectedServerIds,
              hostedSelectedServerIds,
              hostedOAuthTokens,
              isLoading: true,
            }),
          );
          return;
        }

        setState(
          buildEmptyState({
            hostedSelectedServerIds,
            hostedOAuthTokens,
            error:
              error instanceof Error
                ? error.message
                : "Failed to load tool context.",
          }),
        );
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    hostedContextReady,
    hostedOAuthTokens,
    hostedSelectedServerIds,
    normalizedServerNames,
    retryKey,
    serverNamesSignature,
  ]);

  return state;
}
