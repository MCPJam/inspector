import { useCallback, useMemo, useState } from "react";
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

type OAuthDebuggerE2EEvent =
  | { type: "saved"; serverName: string; serverUrl: string }
  | { type: "imported"; serverName: string; serverUrl: string }
  | { type: "reconnected"; serverName: string; serverUrl: string };

declare global {
  interface Window {
    __oauthDebuggerE2EEvents?: OAuthDebuggerE2EEvent[];
  }
}

const PROJECT_ID = "oauth-debugger-e2e-project";
const SERVER_ID = "oauth-debugger-e2e-server";

function recordE2EEvent(event: OAuthDebuggerE2EEvent) {
  window.__oauthDebuggerE2EEvents = [
    ...(window.__oauthDebuggerE2EEvents ?? []),
    event,
  ];
}

function createServerFromProfile(
  formData: ServerFormData,
  oauthProfile?: OAuthTestProfile
): ServerWithName {
  return {
    name: formData.name,
    config: {
      url: formData.url ?? "",
    },
    oauthFlowProfile: oauthProfile,
    connectionStatus: "disconnected",
    enabled: true,
    retryCount: 0,
    useOAuth: true,
    lastConnectionTime: new Date(0),
  } as ServerWithName;
}

export function OAuthDebuggerE2EHarness() {
  const [serverConfigs, setServerConfigs] = useState<
    Record<string, ServerWithName>
  >({});
  const [selectedServerName, setSelectedServerName] = useState("none");
  const [status, setStatus] = useState("idle");

  const handleSaveServerConfig = useCallback(
    (
      formData: ServerFormData,
      options?: { oauthProfile?: OAuthTestProfile }
    ) => {
      const server = createServerFromProfile(formData, options?.oauthProfile);
      setServerConfigs((current) => ({
        ...current,
        [formData.name]: server,
      }));
      setSelectedServerName(formData.name);
      setStatus("saved");
      recordE2EEvent({
        type: "saved",
        serverName: formData.name,
        serverUrl: formData.url ?? "",
      });
    },
    []
  );

  const handleConnectWithTokens = useCallback(
    async (
      serverName: string,
      tokens: OAuthTokensFromFlow,
      serverUrl: string
    ) => {
      setStatus("importing");

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
        serverId: SERVER_ID,
        serverUrl,
        kind: "generic",
        clientInformation: {
          clientId: tokens.clientId,
          ...(tokens.clientSecret ? { clientSecret: tokens.clientSecret } : {}),
        },
        tokens: normalizedTokens,
      });

      setStatus("imported");
      recordE2EEvent({ type: "imported", serverName, serverUrl });

      const response = await fetch("/__e2e/oauth/reconnect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: PROJECT_ID,
          serverId: SERVER_ID,
          serverName,
          serverUrl,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `OAuth debugger e2e reconnect failed: ${response.status}`
        );
      }

      setServerConfigs((current) => {
        const server = current[serverName];
        if (!server) return current;
        return {
          ...current,
          [serverName]: {
            ...server,
            connectionStatus: "connected",
            lastConnectionTime: new Date(),
          },
        };
      });
      setStatus("connected");
      recordE2EEvent({ type: "reconnected", serverName, serverUrl });
    },
    []
  );

  const selectedServer = useMemo(
    () => serverConfigs[selectedServerName],
    [serverConfigs, selectedServerName]
  );

  return (
    <div className="h-screen w-screen bg-background text-foreground">
      <div
        data-testid="oauth-e2e-status"
        data-status={status}
        data-selected-server={selectedServer?.name ?? "none"}
        className="sr-only"
      >
        {status}
      </div>
      <OAuthFlowTab
        serverConfigs={serverConfigs}
        selectedServerName={selectedServerName}
        onSelectServer={setSelectedServerName}
        onSaveServerConfig={handleSaveServerConfig}
        onConnectWithTokens={handleConnectWithTokens}
      />
    </div>
  );
}

export default OAuthDebuggerE2EHarness;
