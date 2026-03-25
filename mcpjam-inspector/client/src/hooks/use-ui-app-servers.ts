import { useEffect, useMemo, useRef, useState } from "react";
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

const RESOLUTION_TIMEOUT_MS = 5_000;

export function useUiAppServers(servers: Record<string, ServerWithName>) {
  const [toolsDataMap, setToolsDataMap] = useState<
    Record<string, ListToolsResultWithMetadata | null>
  >({});
  const [timedOutNames, setTimedOutNames] = useState<Set<string>>(new Set());
  const timeoutRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

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

    // Clear stale timeouts and timed-out names on server list change
    for (const [name, timer] of timeoutRefs.current) {
      if (!connectedServerNames.includes(name)) {
        clearTimeout(timer);
        timeoutRefs.current.delete(name);
      }
    }
    setTimedOutNames((prev) => {
      const next = new Set<string>();
      for (const name of prev) {
        if (connectedServerNames.includes(name)) next.add(name);
      }
      return next.size === prev.size ? prev : next;
    });

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

      // Start per-server timeouts
      for (const serverName of connectedServerNames) {
        if (!timeoutRefs.current.has(serverName)) {
          const timer = setTimeout(() => {
            timeoutRefs.current.delete(serverName);
            if (!cancelled) {
              setTimedOutNames((prev) => {
                if (prev.has(serverName)) return prev;
                return new Set([...prev, serverName]);
              });
            }
          }, RESOLUTION_TIMEOUT_MS);
          timeoutRefs.current.set(serverName, timer);
        }
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
            // Clear timeout since we resolved
            const timer = timeoutRefs.current.get(serverName);
            if (timer) {
              clearTimeout(timer);
              timeoutRefs.current.delete(serverName);
            }
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
      for (const timer of timeoutRefs.current.values()) {
        clearTimeout(timer);
      }
      timeoutRefs.current.clear();
    };
  }, [connectedServerNamesKey, connectedServerNames]);

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
      connectedServerNames.filter(
        (serverName) =>
          Object.prototype.hasOwnProperty.call(toolsDataMap, serverName) ||
          timedOutNames.has(serverName),
      ),
    [connectedServerNames, toolsDataMap, timedOutNames],
  );

  return {
    appServerNames,
    hasAppServer: appServerNames.length > 0,
    resolvedServerNames,
  };
}
