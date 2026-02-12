import { MCPClientManager, type HttpServerConfig } from "@mcpjam/sdk/browser";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  consumeOAuthReturnHash,
  getPendingOAuthServer,
  getStoredOAuthTokens,
  setPendingOAuthServer,
} from "../lib/oauth/mcpOAuthProvider";
import { finishOAuthCallback, startOAuth } from "../lib/oauth/oauthFlow";
import {
  McpConnectionsContext,
  type ConnectServerInput,
  type MCPConnectionError,
  type MCPServerConnection,
  type McpConnectionsContextValue,
} from "./mcpConnectionsContext";

const STORAGE_SERVERS_KEY = "mcpjam-web-servers";
const STORAGE_ACTIVE_SERVER_KEY = "mcpjam-web-active-server-id";

function createServerId(url: string) {
  return `server-${url.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-")}`;
}

function isLocalAddress(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  if (lowered === "localhost") return true;
  if (lowered.endsWith(".localhost")) return true;
  if (lowered.endsWith(".local")) return true;
  if (lowered === "127.0.0.1" || lowered === "::1") return true;
  if (/^10\./.test(lowered)) return true;
  if (/^192\.168\./.test(lowered)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lowered)) return true;
  return false;
}

function normalizeHeaders(headers?: Record<string, string>) {
  if (!headers) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key.trim()) continue;
    normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toConnectionError(error: unknown): MCPConnectionError {
  const message =
    error instanceof Error ? error.message : "Unknown MCP connection error";
  const lowered = message.toLowerCase();
  const retryable =
    lowered.includes("timeout") ||
    lowered.includes("network") ||
    lowered.includes("fetch") ||
    lowered.includes("disconnect") ||
    lowered.includes("503");

  return {
    message,
    retryable,
    code: error instanceof Error ? error.name : undefined,
  };
}

function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("unauthorized") ||
    message.includes("invalid token") ||
    message.includes("authentication") ||
    message.includes("401") ||
    message.includes("403")
  );
}

function loadServersFromStorage(): MCPServerConnection[] {
  const raw = localStorage.getItem(STORAGE_SERVERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as MCPServerConnection[];
    return parsed.map((server) => ({
      ...server,
      connectionStatus: "disconnected",
      lastError: undefined,
      wasConnected:
        server.wasConnected === true || server.connectionStatus === "connected",
    }));
  } catch {
    return [];
  }
}

function loadActiveServerFromStorage(): string | null {
  return localStorage.getItem(STORAGE_ACTIVE_SERVER_KEY);
}

export function McpConnectionsProvider({ children }: { children: ReactNode }) {
  const managerRef = useRef<MCPClientManager | null>(null);
  const inFlightConnectionsRef = useRef<Map<string, Promise<void>>>(new Map());
  const reconnectRunRef = useRef(false);
  const serverConfigsRef = useRef<Map<string, ConnectServerInput>>(new Map());

  if (!managerRef.current) {
    managerRef.current = new MCPClientManager();
  }

  const [servers, setServers] = useState<MCPServerConnection[]>(() =>
    loadServersFromStorage(),
  );
  const [activeServerId, setActiveServerId] = useState<string | null>(() =>
    loadActiveServerFromStorage(),
  );

  const upsertServer = useCallback((server: MCPServerConnection) => {
    setServers((current) => {
      const index = current.findIndex((entry) => entry.id === server.id);
      if (index < 0) return [...current, server];
      const next = [...current];
      next[index] = server;
      return next;
    });
  }, []);

  const patchServer = useCallback(
    (serverId: string, patch: Partial<MCPServerConnection>) => {
      setServers((current) =>
        current.map((server) =>
          server.id === serverId ? { ...server, ...patch } : server,
        ),
      );
    },
    [],
  );

  const validateInput = useCallback((input: ConnectServerInput) => {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new Error("Invalid URL");
    }

    if (url.protocol !== "https:") {
      throw new Error("Only HTTPS MCP servers are allowed in the web app.");
    }

    if (isLocalAddress(url.hostname)) {
      throw new Error("Localhost/private network MCP servers are blocked.");
    }

    return url;
  }, []);

  const connectServer = useCallback(
    async (input: ConnectServerInput) => {
      const manager = managerRef.current;
      if (!manager) {
        throw new Error("MCP manager is not initialized.");
      }

      const url = validateInput(input);
      const id = input.id ?? createServerId(url.toString());

      const existing = servers.find((server) => server.id === id);
      const mergedInput: ConnectServerInput = {
        id,
        name: input.name,
        url: url.toString(),
        transport: input.transport ?? existing?.transport ?? "streamable-http",
        oauth: input.oauth ?? existing?.oauth,
        headers: normalizeHeaders(input.headers ?? existing?.headers),
        sessionId: input.sessionId ?? existing?.sessionId,
        accessToken: input.accessToken,
      };
      serverConfigsRef.current.set(id, mergedInput);

      const existingPromise = inFlightConnectionsRef.current.get(id);
      if (existingPromise) return existingPromise;

      const baseServer: MCPServerConnection = {
        id,
        name: mergedInput.name,
        url: mergedInput.url,
        transport: mergedInput.transport ?? "streamable-http",
        headers: mergedInput.headers,
        oauth: mergedInput.oauth,
        sessionId: mergedInput.sessionId,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        connectionStatus: "connecting",
        lastError: undefined,
        wasConnected: existing?.wasConnected ?? false,
        serverCapabilities: existing?.serverCapabilities,
        lastConnectedAt: existing?.lastConnectedAt,
      };
      upsertServer(baseServer);

      const doConnect = (async () => {
        try {
          await manager.disconnectServer(id);

          const headers = normalizeHeaders(mergedInput.headers) ?? {};
          if (mergedInput.accessToken && !headers.Authorization) {
            headers.Authorization = `Bearer ${mergedInput.accessToken}`;
          }

          const authTokens = getStoredOAuthTokens(id);
          if (
            mergedInput.oauth?.enabled &&
            authTokens &&
            typeof authTokens.access_token === "string" &&
            !headers.Authorization
          ) {
            headers.Authorization = `Bearer ${authTokens.access_token}`;
          }

          const config: HttpServerConfig = {
            url: mergedInput.url,
            preferSSE: mergedInput.transport === "sse",
            sessionId: mergedInput.sessionId,
            requestInit:
              Object.keys(headers).length > 0
                ? {
                    headers,
                  }
                : undefined,
          };

          if (mergedInput.oauth?.enabled) {
            const { createMcpOAuthProvider } = await import(
              "../lib/oauth/mcpOAuthProvider"
            );
            config.authProvider = createMcpOAuthProvider({
              serverId: id,
              serverName: mergedInput.name,
              serverUrl: mergedInput.url,
              oauth: mergedInput.oauth,
            });
          }

          await manager.connectToServer(id, config);
          await manager.listTools(id).catch(() => undefined);

          const capabilities = manager.getServerCapabilities(id);
          const sessionId = (() => {
            try {
              return manager.getSessionIdByServer(id);
            } catch {
              return undefined;
            }
          })();

          patchServer(id, {
            connectionStatus: "connected",
            lastError: undefined,
            serverCapabilities: capabilities,
            sessionId,
            wasConnected: true,
            lastConnectedAt: new Date().toISOString(),
          });
          setActiveServerId(id);
        } catch (error) {
          if (mergedInput.oauth?.enabled && isUnauthorizedError(error)) {
            setPendingOAuthServer(id);
            const oauthResult = await startOAuth(id, mergedInput);
            if (oauthResult === "REDIRECT") {
              patchServer(id, {
                connectionStatus: "oauth-pending",
                lastError: undefined,
              });
              return;
            }
          }

          patchServer(id, {
            connectionStatus: "error",
            lastError: toConnectionError(error),
          });
          throw error;
        } finally {
          inFlightConnectionsRef.current.delete(id);
        }
      })();

      inFlightConnectionsRef.current.set(id, doConnect);
      return doConnect;
    },
    [patchServer, servers, upsertServer, validateInput],
  );

  const disconnectServer = useCallback(async (serverId: string) => {
    const manager = managerRef.current;
    if (!manager) return;

    try {
      await manager.disconnectServer(serverId);
    } finally {
      patchServer(serverId, { connectionStatus: "disconnected" });
      setActiveServerId((current) => (current === serverId ? null : current));
    }
  }, [patchServer]);

  const reconnectServer = useCallback(
    async (serverId: string) => {
      const config = serverConfigsRef.current.get(serverId);
      const server = servers.find((entry) => entry.id === serverId);
      if (!config && !server) {
        throw new Error("Server config not found for reconnect");
      }

      await connectServer({
        id: serverId,
        name: config?.name ?? server?.name ?? serverId,
        url: config?.url ?? server?.url ?? "",
        headers: config?.headers ?? server?.headers,
        oauth: config?.oauth ?? server?.oauth,
        transport: config?.transport ?? server?.transport,
        sessionId: config?.sessionId ?? server?.sessionId,
      });
    },
    [connectServer, servers],
  );

  const removeServer = useCallback(
    async (serverId: string) => {
      await disconnectServer(serverId);
      serverConfigsRef.current.delete(serverId);
      setServers((current) => current.filter((server) => server.id !== serverId));
      setActiveServerId((current) => (current === serverId ? null : current));
    },
    [disconnectServer],
  );

  const refreshServerCapabilities = useCallback(
    async (serverId: string) => {
      const manager = managerRef.current;
      if (!manager) return;

      try {
        await manager.listTools(serverId);
        patchServer(serverId, {
          serverCapabilities: manager.getServerCapabilities(serverId),
          lastError: undefined,
        });
      } catch (error) {
        patchServer(serverId, {
          lastError: toConnectionError(error),
        });
      }
    },
    [patchServer],
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_SERVERS_KEY, JSON.stringify(servers));
  }, [servers]);

  useEffect(() => {
    if (activeServerId) {
      localStorage.setItem(STORAGE_ACTIVE_SERVER_KEY, activeServerId);
    } else {
      localStorage.removeItem(STORAGE_ACTIVE_SERVER_KEY);
    }
  }, [activeServerId]);

  useEffect(() => {
    for (const server of servers) {
      const existing = serverConfigsRef.current.get(server.id);
      if (existing) continue;
      serverConfigsRef.current.set(server.id, {
        id: server.id,
        name: server.name,
        url: server.url,
        transport: server.transport,
        headers: server.headers,
        oauth: server.oauth,
        sessionId: server.sessionId,
      });
    }
  }, [servers]);

  useEffect(() => {
    if (reconnectRunRef.current) return;
    reconnectRunRef.current = true;

    const reconnectTargets = servers.filter((server) => server.wasConnected);
    reconnectTargets.forEach((server) => {
      void reconnectServer(server.id).catch(() => undefined);
    });
  }, [reconnectServer, servers]);

  useEffect(() => {
    const manager = managerRef.current;
    return () => {
      if (!manager) return;
      void manager.disconnectAllServers();
    };
  }, []);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code");
    const error = new URLSearchParams(window.location.search).get("error");
    const pendingServerId = getPendingOAuthServer();

    if (!pendingServerId) return;
    if (!code && !error) return;

    const pendingConfig = serverConfigsRef.current.get(pendingServerId);
    if (!pendingConfig) return;

    const cleanUrl = `${window.location.origin}${window.location.pathname}`;
    const restoreHash = consumeOAuthReturnHash() ?? "#servers";

    const complete = async () => {
      try {
        if (error) {
          patchServer(pendingServerId, {
            connectionStatus: "error",
            lastError: {
              message: `OAuth authorization failed: ${error}`,
              retryable: true,
            },
          });
          return;
        }

        if (code) {
          await finishOAuthCallback(pendingServerId, pendingConfig, code);
          await reconnectServer(pendingServerId);
        }
      } catch (oauthError) {
        patchServer(pendingServerId, {
          connectionStatus: "error",
          lastError: toConnectionError(oauthError),
        });
      } finally {
        window.history.replaceState({}, document.title, `${cleanUrl}${restoreHash}`);
      }
    };

    void complete();
  }, [patchServer, reconnectServer]);

  const contextValue = useMemo<McpConnectionsContextValue>(
    () => ({
      servers,
      connectServer,
      disconnectServer,
      reconnectServer,
      removeServer,
      refreshServerCapabilities,
      activeServerId,
      setActiveServerId,
      getManager: () => managerRef.current,
    }),
    [
      servers,
      connectServer,
      disconnectServer,
      reconnectServer,
      removeServer,
      refreshServerCapabilities,
      activeServerId,
    ],
  );

  return (
    <McpConnectionsContext.Provider value={contextValue}>
      {children}
    </McpConnectionsContext.Provider>
  );
}
