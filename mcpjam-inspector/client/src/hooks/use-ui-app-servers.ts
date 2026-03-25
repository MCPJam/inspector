import { useEffect, useMemo, useState } from "react";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import {
  isMCPApp,
  isOpenAIApp,
  isOpenAIAppAndMCPApp,
} from "@/lib/mcp-ui/mcp-apps-utils";
import type { ServerWithName } from "./use-app-state";

export function useUiAppServers(servers: Record<string, ServerWithName>) {
  const [toolsDataMap, setToolsDataMap] = useState<
    Record<string, ListToolsResultWithMetadata | null>
  >({});

  const connectedServerNames = useMemo(
    () =>
      Object.entries(servers)
        .filter(([, server]) => server.connectionStatus === "connected")
        .map(([name]) => name),
    [servers],
  );

  const connectedServerNamesKey = connectedServerNames.join(",");

  useEffect(() => {
    let cancelled = false;

    const fetchToolsData = async () => {
      if (connectedServerNames.length === 0) {
        if (!cancelled) {
          setToolsDataMap({});
        }
        return;
      }

      if (!cancelled) {
        setToolsDataMap((prev) =>
          Object.fromEntries(
            Object.entries(prev).filter(([serverName]) =>
              connectedServerNames.includes(serverName),
            ),
          ),
        );
      }

      await Promise.all(
        connectedServerNames.map(async (serverName) => {
          let result: ListToolsResultWithMetadata | null = null;
          try {
            result = await listTools({
              serverId: serverName,
            });
          } catch {
            result = null;
          }

          if (!cancelled) {
            setToolsDataMap((prev) => ({
              ...prev,
              [serverName]: result,
            }));
          }
        }),
      );
    };

    void fetchToolsData();

    return () => {
      cancelled = true;
    };
  }, [connectedServerNamesKey]);

  const appServerNames = useMemo(
    () =>
      connectedServerNames.filter((serverName) => {
        const toolsData = toolsDataMap[serverName];
        return (
          !!toolsData &&
          (isMCPApp(toolsData) ||
            isOpenAIApp(toolsData) ||
            isOpenAIAppAndMCPApp(toolsData))
        );
      }),
    [connectedServerNames, toolsDataMap],
  );

  const resolvedServerNames = useMemo(
    () =>
      connectedServerNames.filter((serverName) =>
        Object.prototype.hasOwnProperty.call(toolsDataMap, serverName),
      ),
    [connectedServerNames, toolsDataMap],
  );

  return {
    appServerNames,
    hasAppServer: appServerNames.length > 0,
    resolvedServerNames,
  };
}
