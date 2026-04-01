import { useEffect, useRef, useMemo } from "react";
import { useSharedAppRuntime } from "@/state/app-state-context";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const LEARNING_SERVER_ID = "__learning__";

const DEFAULT_LEARNING_SERVER_URL = "https://learning-server.mcpjam.com/mcp";

function getLearningServerUrl(): string {
  try {
    const envUrl = import.meta.env.VITE_LEARNING_SERVER_URL;
    if (typeof envUrl === "string" && envUrl.trim().length > 0) {
      return envUrl.trim();
    }
  } catch {
    // import.meta.env may not be available in test environments.
  }
  return DEFAULT_LEARNING_SERVER_URL;
}

function buildLearningServerConfig(url: string): MCPServerConfig {
  return {
    url: new URL(url),
    transportType: "streamable-http",
  } as MCPServerConfig;
}

/**
 * Auto-connects the learning server on mount, reconnects when the URL changes,
 * and disconnects on unmount.
 *
 * Must be used inside a `<LearningStateProvider>`.
 */
export function useLearningServer() {
  const runtime = useSharedAppRuntime();
  const urlRef = useRef(getLearningServerUrl());
  const mountedRef = useRef(true);

  const serverName = LEARNING_SERVER_ID;

  useEffect(() => {
    mountedRef.current = true;

    if (!runtime) return;

    const url = getLearningServerUrl();
    urlRef.current = url;

    const config = buildLearningServerConfig(url);
    runtime.connectRuntimeServer({ name: serverName, config, silent: true });

    return () => {
      mountedRef.current = false;
      runtime.disconnectRuntimeServer(serverName);
    };
  }, [runtime, serverName]);

  // Reconnect when the env URL changes (hot-reload / dev scenario).
  useEffect(() => {
    if (!runtime) return;

    const currentUrl = getLearningServerUrl();
    if (currentUrl !== urlRef.current) {
      urlRef.current = currentUrl;
      const config = buildLearningServerConfig(currentUrl);
      runtime.connectRuntimeServer({ name: serverName, config, silent: true });
    }
  });

  const serverEntry = runtime?.getServerEntry(serverName);

  return useMemo(
    () => ({
      serverName,
      serverEntry,
      connectionStatus: serverEntry?.connectionStatus ?? "disconnected",
      config: serverEntry?.config,
    }),
    [serverName, serverEntry],
  );
}
