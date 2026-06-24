import { type FormEvent, useCallback, useMemo, useState } from "react";
import {
  OAuthFlowTab,
  type OAuthTokensFromFlow,
} from "@/components/OAuthFlowTab";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  importHostedOAuthTokens,
  normalizeImportHostedOAuthTokens,
} from "@/lib/apis/hosted-oauth-import-tokens-api";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
import type { ServerFormData } from "@/shared/types.js";

type E2EServerKind = "plain" | "oauth";
type E2EServerStatus = "disconnected" | "connecting" | "connected" | "failed";

interface PersistedE2EServer {
  name: string;
  url: string;
  kind: E2EServerKind;
  hasConnected: boolean;
  oauthProfile?: OAuthTestProfile;
}

interface E2EServer extends PersistedE2EServer {
  status: E2EServerStatus;
}

type OAuthDebuggerE2EEvent =
  | {
      type: "saved";
      serverName: string;
      serverUrl: string;
      kind: E2EServerKind;
    }
  | { type: "imported"; serverName: string; serverUrl: string }
  | {
      type: "connected";
      serverName: string;
      serverUrl: string;
      intent: string;
    };

declare global {
  interface Window {
    __oauthDebuggerE2EEvents?: OAuthDebuggerE2EEvent[];
  }
}

const PROJECT_ID = "oauth-debugger-e2e-project";
const SERVER_ID = "oauth-debugger-e2e-server";
const STORAGE_KEY = "oauth-debugger-e2e-servers-v1";

function serverIdForName(serverName: string): string {
  return serverName === "oauth-e2e-target" ? SERVER_ID : `server-${serverName}`;
}

function recordE2EEvent(event: OAuthDebuggerE2EEvent) {
  window.__oauthDebuggerE2EEvents = [
    ...(window.__oauthDebuggerE2EEvents ?? []),
    event,
  ];
}

function readPersistedServers(): E2EServer[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((server): server is PersistedE2EServer => {
        return (
          server &&
          typeof server === "object" &&
          typeof server.name === "string" &&
          typeof server.url === "string" &&
          (server.kind === "plain" || server.kind === "oauth")
        );
      })
      .map((server) => ({
        ...server,
        hasConnected: Boolean(server.hasConnected),
        status: "disconnected",
      }));
  } catch {
    return [];
  }
}

function writePersistedServers(servers: E2EServer[]) {
  const persisted = servers.map(
    ({ name, url, kind, hasConnected, oauthProfile }) =>
      ({
        name,
        url,
        kind,
        hasConnected,
        ...(oauthProfile ? { oauthProfile } : {}),
      } satisfies PersistedE2EServer)
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
}

function toOAuthServerWithName(server: E2EServer): ServerWithName {
  return {
    name: server.name,
    config: {
      url: server.url,
    },
    oauthFlowProfile: server.oauthProfile,
    connectionStatus: server.status,
    enabled: true,
    retryCount: 0,
    useOAuth: true,
    lastConnectionTime: new Date(0),
  } as ServerWithName;
}

export function OAuthDebuggerE2EHarness() {
  const [servers, setServers] = useState<E2EServer[]>(() =>
    readPersistedServers()
  );
  const [plainName, setPlainName] = useState("plain-e2e-target");
  const [plainUrl, setPlainUrl] = useState("");
  const [selectedOAuthServerName, setSelectedOAuthServerName] =
    useState("none");
  const [showOAuthDebugger, setShowOAuthDebugger] = useState(false);
  const [openProfileModalSignal, setOpenProfileModalSignal] = useState(0);
  const [status, setStatus] = useState("idle");

  const updateServers = useCallback(
    (updater: (servers: E2EServer[]) => E2EServer[]) => {
      setServers((current) => {
        const next = updater(current);
        writePersistedServers(next);
        return next;
      });
    },
    []
  );

  const upsertServer = useCallback(
    (server: E2EServer) => {
      updateServers((current) => {
        const withoutServer = current.filter(
          (item) => item.name !== server.name
        );
        return [...withoutServer, server];
      });
      recordE2EEvent({
        type: "saved",
        serverName: server.name,
        serverUrl: server.url,
        kind: server.kind,
      });
    },
    [updateServers]
  );

  const setServerStatus = useCallback(
    (serverName: string, status: E2EServerStatus, hasConnected?: boolean) => {
      updateServers((current) =>
        current.map((server) =>
          server.name === serverName
            ? {
                ...server,
                status,
                hasConnected: hasConnected ?? server.hasConnected,
              }
            : server
        )
      );
    },
    [updateServers]
  );

  const connectServer = useCallback(
    async (
      serverName: string,
      intent: "connect" | "reconnect" | "oauth-debugger"
    ) => {
      const server = servers.find((item) => item.name === serverName);
      if (!server) return;

      setStatus(`${serverName}:connecting`);
      setServerStatus(serverName, "connecting");

      const response = await fetch("/__e2e/servers/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: PROJECT_ID,
          serverId: serverIdForName(serverName),
          serverName,
          serverUrl: server.url,
          kind: server.kind,
          intent,
        }),
      });

      if (!response.ok) {
        setStatus(`${serverName}:failed`);
        setServerStatus(serverName, "failed");
        throw new Error(
          `OAuth debugger e2e connect failed: ${response.status}`
        );
      }

      setStatus(`${serverName}:connected`);
      setServerStatus(serverName, "connected", true);
      recordE2EEvent({
        type: "connected",
        serverName,
        serverUrl: server.url,
        intent,
      });
    },
    [servers, setServerStatus]
  );

  const handleAddPlainServer = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const server: E2EServer = {
        name: plainName.trim(),
        url: plainUrl.trim(),
        kind: "plain",
        status: "disconnected",
        hasConnected: false,
      };
      if (!server.name || !server.url) return;
      upsertServer(server);
      setStatus(`${server.name}:saved`);
    },
    [plainName, plainUrl, upsertServer]
  );

  const handleSaveOAuthServerConfig = useCallback(
    (
      formData: ServerFormData,
      options?: { oauthProfile?: OAuthTestProfile }
    ) => {
      const server: E2EServer = {
        name: formData.name,
        url: formData.url ?? "",
        kind: "oauth",
        status: "disconnected",
        hasConnected: false,
        oauthProfile: options?.oauthProfile,
      };
      upsertServer(server);
      setSelectedOAuthServerName(formData.name);
      setStatus(`${formData.name}:saved`);
    },
    [upsertServer]
  );

  const handleConnectWithTokens = useCallback(
    async (
      serverName: string,
      tokens: OAuthTokensFromFlow,
      serverUrl: string
    ) => {
      setStatus(`${serverName}:importing`);

      const normalizedTokens = normalizeImportHostedOAuthTokens({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: tokens.tokenType ?? "Bearer",
        expires_in: tokens.expiresIn,
      });

      if (!normalizedTokens) {
        throw new Error(
          "OAuth debugger e2e flow did not receive an access token"
        );
      }
      if (!tokens.clientId) {
        throw new Error("OAuth debugger e2e flow did not receive a client id");
      }

      await importHostedOAuthTokens({
        projectId: PROJECT_ID,
        serverId: serverIdForName(serverName),
        serverUrl,
        kind: "generic",
        clientInformation: {
          clientId: tokens.clientId,
          ...(tokens.clientSecret ? { clientSecret: tokens.clientSecret } : {}),
        },
        tokens: normalizedTokens,
      });

      setStatus(`${serverName}:imported`);
      recordE2EEvent({ type: "imported", serverName, serverUrl });
      await connectServer(serverName, "oauth-debugger");
    },
    [connectServer]
  );

  const oauthServerConfigs = useMemo(
    () =>
      Object.fromEntries(
        servers
          .filter((server) => server.kind === "oauth")
          .map((server) => [server.name, toOAuthServerWithName(server)])
      ),
    [servers]
  );

  const handleOpenOAuthDebugger = () => {
    setShowOAuthDebugger(true);
    setOpenProfileModalSignal((signal) => signal + 1);
  };

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col">
      <div
        data-testid="oauth-e2e-status"
        data-status={status}
        className="sr-only"
      >
        {status}
      </div>

      <div className="border-b border-border p-4 space-y-4">
        <form
          aria-label="Add plain HTTP server"
          className="flex flex-wrap items-end gap-3"
          onSubmit={handleAddPlainServer}
        >
          <label className="grid gap-1 text-sm">
            Plain server name
            <input
              className="h-9 rounded-md border border-border bg-background px-3"
              value={plainName}
              onChange={(event) => setPlainName(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm min-w-[280px]">
            Plain server URL
            <input
              className="h-9 rounded-md border border-border bg-background px-3"
              value={plainUrl}
              onChange={(event) => setPlainUrl(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="h-9 rounded-md border border-border px-3 text-sm"
          >
            Add plain HTTP server
          </button>
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-sm"
            onClick={handleOpenOAuthDebugger}
          >
            Add OAuth server through debugger
          </button>
        </form>

        <div aria-label="Saved servers" className="grid gap-2">
          {servers.map((server) => (
            <div
              key={server.name}
              data-testid={`server-row-${server.name}`}
              data-kind={server.kind}
              data-status={server.status}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="font-medium">{server.name}</span>
              <span>{server.kind}</span>
              <span>{server.url}</span>
              <span data-testid={`server-status-${server.name}`}>
                {server.status}
              </span>
              <button
                type="button"
                className="h-8 rounded-md border border-border px-3"
                onClick={() =>
                  connectServer(
                    server.name,
                    server.hasConnected ? "reconnect" : "connect"
                  )
                }
                disabled={server.status === "connecting"}
              >
                {server.hasConnected ? "Reconnect" : "Connect"} {server.name}
              </button>
            </div>
          ))}
        </div>
      </div>

      {showOAuthDebugger ? (
        <div className="min-h-0 flex-1">
          <OAuthFlowTab
            serverConfigs={oauthServerConfigs}
            selectedServerName={selectedOAuthServerName}
            onSelectServer={setSelectedOAuthServerName}
            onSaveServerConfig={handleSaveOAuthServerConfig}
            onConnectWithTokens={handleConnectWithTokens}
            openProfileModalSignal={openProfileModalSignal}
          />
        </div>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}

export default OAuthDebuggerE2EHarness;
