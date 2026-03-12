import { useConvexAuth } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { toast } from "sonner";
import { ServersTab } from "./components/ServersTab";
import { ToolsTab } from "./components/ToolsTab";
import { ResourcesTab } from "./components/ResourcesTab";
import { PromptsTab } from "./components/PromptsTab";
import { SkillsTab } from "./components/SkillsTab";
import { LearningTab } from "./components/LearningTab";
import { TasksTab } from "./components/TasksTab";
import { ChatTabV2 } from "./components/ChatTabV2";
import { EvalsTab } from "./components/EvalsTab";
import { CiEvalsTab } from "./components/CiEvalsTab";
import { ViewsTab } from "./components/ViewsTab";
import { SandboxesTab } from "./components/SandboxesTab";
import { SettingsTab } from "./components/SettingsTab";
import { TracingTab } from "./components/TracingTab";
import { AuthTab } from "./components/AuthTab";
import { OAuthFlowTab } from "./components/OAuthFlowTab";
import { AppBuilderTab } from "./components/ui-playground/AppBuilderTab";
import { ProfileTab } from "./components/ProfileTab";
import { OrganizationsTab } from "./components/OrganizationsTab";
import { SupportTab } from "./components/SupportTab";
import OAuthDebugCallback from "./components/oauth/OAuthDebugCallback";
import { MCPSidebar } from "./components/mcp-sidebar";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
import { useAppState } from "./hooks/use-app-state";
import { PreferencesStoreProvider } from "./stores/preferences/preferences-provider";
import { Toaster } from "./components/ui/sonner";
import { useElectronOAuth } from "./hooks/useElectronOAuth";
import { useEnsureDbUser } from "./hooks/useEnsureDbUser";
import { usePostHog, useFeatureFlagEnabled } from "posthog-js/react";
import { usePostHogIdentify } from "./hooks/usePostHogIdentify";
import { AppStateProvider } from "./state/app-state-context";

// Import global styles
import "./index.css";
import { detectEnvironment, detectPlatform } from "./lib/PosthogUtils";
import {
  getInitialThemeMode,
  updateThemeMode,
  getInitialThemePreset,
  updateThemePreset,
} from "./lib/theme-utils";
import CompletingSignInLoading from "./components/CompletingSignInLoading";
import LoadingScreen from "./components/LoadingScreen";
import { Header } from "./components/Header";
import { ThemePreset } from "./types/preferences/theme";
import type { ActiveServerSelectorProps } from "./components/ActiveServerSelector";
import { useViewQueries, useWorkspaceServers } from "./hooks/useViews";
import { HostedShellGate } from "./components/hosted/HostedShellGate";
import { resolveHostedShellGateState } from "./components/hosted/hosted-shell-gate-state";
import {
  SharedServerChatPage,
  getSharedPathTokenFromLocation,
} from "./components/hosted/SharedServerChatPage";
import {
  SandboxChatPage,
  getSandboxPathTokenFromLocation,
} from "./components/hosted/SandboxChatPage";
import { useHostedApiContext } from "./hooks/hosted/use-hosted-api-context";
import { HOSTED_MODE } from "./lib/config";
import { resolveHostedNavigation } from "./lib/hosted-navigation";
import { buildOAuthTokensByServerId } from "./lib/oauth/oauth-tokens";
import {
  clearHostedOAuthPendingState,
  getHostedOAuthCallbackContext,
  resolveHostedOAuthReturnHash,
} from "./lib/hosted-oauth-callback";
import {
  clearSandboxSignInReturnPath,
  readSandboxSession,
  readSandboxSignInReturnPath,
  writeSandboxSignInReturnPath,
} from "./lib/sandbox-session";
import {
  clearSharedSignInReturnPath,
  readSharedServerSession,
  readSharedSignInReturnPath,
  slugify,
  writeSharedSignInReturnPath,
  readPendingServerAdd,
  clearPendingServerAdd,
} from "./lib/shared-server-session";
import {
  sanitizeHostedOAuthErrorMessage,
  writeHostedOAuthResumeMarker,
} from "./lib/hosted-oauth-resume";
import { handleOAuthCallback } from "./lib/oauth/mcp-oauth";

function getHostedOAuthCallbackErrorMessage(): string {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  const description = params.get("error_description");

  if (error === "access_denied" && !description) {
    return "Authorization was cancelled. Try again.";
  }

  return sanitizeHostedOAuthErrorMessage(
    description || error,
    "Authorization could not be completed. Try again.",
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("servers");
  const [activeOrganizationId, setActiveOrganizationId] = useState<
    string | undefined
  >(undefined);
  const [chatHasMessages, setChatHasMessages] = useState(false);
  const [callbackCompleted, setCallbackCompleted] = useState(false);
  const [callbackRecoveryExpired, setCallbackRecoveryExpired] = useState(false);
  const posthog = usePostHog();
  const ciEvalsEnabled = useFeatureFlagEnabled("ci-evals-enabled");
  const {
    getAccessToken,
    signIn,
    user: workOsUser,
    isLoading: isWorkOsLoading,
  } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const [hostedOAuthHandling, setHostedOAuthHandling] = useState(() =>
    HOSTED_MODE ? getHostedOAuthCallbackContext() !== null : false,
  );
  const [exitedSharedChat, setExitedSharedChat] = useState(false);
  const [exitedSandboxChat, setExitedSandboxChat] = useState(false);
  const sharedPathToken = HOSTED_MODE ? getSharedPathTokenFromLocation() : null;
  const sandboxPathToken = HOSTED_MODE
    ? getSandboxPathTokenFromLocation()
    : null;
  const sharedSession = HOSTED_MODE ? readSharedServerSession() : null;
  const sandboxSession = HOSTED_MODE ? readSandboxSession() : null;
  const currentHashSlug = window.location.hash
    .replace(/^#/, "")
    .replace(/^\/+/, "")
    .split("/")[0];
  const hostedRouteKind = useMemo(() => {
    if (!HOSTED_MODE) {
      return null;
    }

    if (sharedPathToken) {
      return "shared" as const;
    }
    if (sandboxPathToken) {
      return "sandbox" as const;
    }

    if (sharedSession && sandboxSession) {
      if (currentHashSlug === slugify(sharedSession.payload.serverName)) {
        return "shared" as const;
      }
      if (currentHashSlug === slugify(sandboxSession.payload.name)) {
        return "sandbox" as const;
      }
      return null;
    }

    if (sharedSession) {
      return "shared" as const;
    }
    if (sandboxSession) {
      return "sandbox" as const;
    }

    return null;
  }, [
    currentHashSlug,
    sandboxPathToken,
    sandboxSession,
    sharedPathToken,
    sharedSession,
  ]);
  const isSharedChatRoute =
    HOSTED_MODE && !exitedSharedChat && hostedRouteKind === "shared";
  const isSandboxChatRoute =
    HOSTED_MODE && !exitedSandboxChat && hostedRouteKind === "sandbox";
  const isHostedChatRoute = isSharedChatRoute || isSandboxChatRoute;

  // Handle hosted OAuth callback: claim the callback before any hosted page renders.
  useEffect(() => {
    const callbackContext = getHostedOAuthCallbackContext();
    if (!callbackContext) return;

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const error = urlParams.get("error");

    let cancelled = false;
    setHostedOAuthHandling(true);

    const finalizeHostedOAuth = (errorMessage?: string | null) => {
      if (cancelled) return;
      if (callbackContext.serverName) {
        writeHostedOAuthResumeMarker({
          surface: callbackContext.surface,
          serverName: callbackContext.serverName,
          serverUrl: callbackContext.serverUrl,
          errorMessage:
            errorMessage && errorMessage.trim() ? errorMessage : null,
        });
      }

      clearHostedOAuthPendingState();
      localStorage.removeItem("mcp-oauth-pending");
      localStorage.removeItem("mcp-oauth-return-hash");
      window.history.replaceState(
        {},
        "",
        `/${resolveHostedOAuthReturnHash(callbackContext)}`,
      );
    };

    if (error || !code) {
      finalizeHostedOAuth(getHostedOAuthCallbackErrorMessage());
      setHostedOAuthHandling(false);
      return;
    }

    handleOAuthCallback(code)
      .then((result) => {
        if (result.success) {
          finalizeHostedOAuth(null);
          return;
        }

        finalizeHostedOAuth(
          sanitizeHostedOAuthErrorMessage(
            result.error,
            "Authorization could not be completed. Try again.",
          ),
        );
      })
      .catch((callbackError) => {
        finalizeHostedOAuth(
          sanitizeHostedOAuthErrorMessage(
            callbackError,
            "Authorization could not be completed. Try again.",
          ),
        );
      })
      .finally(() => {
        if (!cancelled) setHostedOAuthHandling(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  usePostHogIdentify();

  useEffect(() => {
    if (isAuthLoading) return;
    posthog.capture("app_launched", {
      platform: detectPlatform(),
      environment: detectEnvironment(),
      user_agent: navigator.userAgent,
      version: __APP_VERSION__,
      is_authenticated: isAuthenticated,
    });
  }, [isAuthLoading, isAuthenticated]);

  // Set the initial theme mode and preset on page load
  const initialThemeMode = getInitialThemeMode();
  const initialThemePreset: ThemePreset = getInitialThemePreset();
  useEffect(() => {
    updateThemeMode(initialThemeMode);
    updateThemePreset(initialThemePreset);
  }, []);

  // Set up Electron OAuth callback handling
  useElectronOAuth();
  // Ensure a `users` row exists after Convex auth
  useEnsureDbUser();

  const isDebugCallback = window.location.pathname.startsWith(
    "/oauth/callback/debug",
  );
  const isOAuthCallback = window.location.pathname === "/callback";

  useEffect(() => {
    if (!isOAuthCallback) {
      setCallbackCompleted(false);
      setCallbackRecoveryExpired(false);
      return;
    }

    // Let AuthKit + Convex auth settle before leaving /callback.
    if (!isAuthLoading && isAuthenticated) {
      const sandboxReturnPath = readSandboxSignInReturnPath();
      const sharedReturnPath = readSharedSignInReturnPath();
      clearSandboxSignInReturnPath();
      clearSharedSignInReturnPath();
      window.history.replaceState(
        {},
        "",
        sandboxReturnPath ?? sharedReturnPath ?? "/",
      );
      setCallbackCompleted(true);
      setCallbackRecoveryExpired(false);
      return;
    }

    const timeout = setTimeout(() => {
      setCallbackRecoveryExpired(true);
    }, 15000);

    return () => clearTimeout(timeout);
  }, [isOAuthCallback, isAuthLoading, isAuthenticated]);

  const {
    appState,
    isLoading,
    isLoadingRemoteWorkspaces,
    workspaceServers,
    connectedOrConnectingServerConfigs,
    selectedMCPConfig,
    handleConnect,
    handleDisconnect,
    handleReconnect,
    handleUpdate,
    handleRemoveServer,
    setSelectedServer,
    toggleServerSelection,
    setSelectedMultipleServersToAllServers,
    workspaces,
    activeWorkspaceId,
    handleSwitchWorkspace,
    handleCreateWorkspace,
    handleUpdateWorkspace,
    handleDeleteWorkspace,
    handleLeaveWorkspace,
    handleWorkspaceShared,
    saveServerConfigWithoutConnecting,
    handleConnectWithTokensFromOAuthFlow,
    handleRefreshTokensFromOAuthFlow,
  } = useAppState();

  // Auto-add a shared server when returning from SharedServerChatPage via "Open MCPJam"
  useEffect(() => {
    if (isHostedChatRoute) return;
    if (isLoadingRemoteWorkspaces) return;
    if (isAuthLoading) return;

    const pending = readPendingServerAdd();
    if (!pending) return;
    clearPendingServerAdd();

    if (workspaceServers[pending.serverName] !== undefined) {
      return; // Server already exists
    }

    handleConnect({
      name: pending.serverName,
      type: "http",
      url: pending.serverUrl,
      useOAuth: pending.useOAuth,
      clientId: pending.clientId ?? undefined,
      oauthScopes: pending.oauthScopes ?? undefined,
    });
  }, [
    isHostedChatRoute,
    isLoadingRemoteWorkspaces,
    isAuthLoading,
    workspaceServers,
    handleConnect,
  ]);

  // Create effective app state that uses the correct workspaces (Convex when authenticated)
  const effectiveAppState = useMemo(
    () => ({
      ...appState,
      workspaces,
      activeWorkspaceId,
    }),
    [appState, workspaces, activeWorkspaceId],
  );

  // Get the Convex workspace ID from the active workspace
  const activeWorkspace = workspaces[activeWorkspaceId];
  const convexWorkspaceId = activeWorkspace?.sharedWorkspaceId ?? null;

  // Fetch views for the workspace to determine which servers have saved views
  const { viewsByServer } = useViewQueries({
    isAuthenticated,
    workspaceId: convexWorkspaceId,
  });

  // Fetch workspace servers to map server IDs to names
  const { serversById } = useWorkspaceServers({
    isAuthenticated,
    workspaceId: convexWorkspaceId,
  });
  const hostedServerIdsByName = useMemo(
    () =>
      Object.fromEntries(
        Array.from(serversById.entries()).map(([id, name]) => [name, id]),
      ),
    [serversById],
  );
  const oauthTokensByServerId = useMemo(
    () =>
      buildOAuthTokensByServerId(
        Object.keys(hostedServerIdsByName),
        (name) => hostedServerIdsByName[name],
        (name) => appState.servers[name]?.oauthTokens?.access_token,
      ),
    [hostedServerIdsByName, appState.servers],
  );
  // Extract MCPServerConfig objects for guest mode (keyed by server name)
  const guestServerConfigs = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(appState.servers).map(([name, s]) => [name, s.config]),
      ),
    [appState.servers],
  );
  const guestOauthTokensByServerName = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(appState.servers)
          .filter(([, server]) => !!server.oauthTokens?.access_token)
          .map(([name, server]) => [name, server.oauthTokens!.access_token]),
      ),
    [appState.servers],
  );
  useHostedApiContext({
    workspaceId: convexWorkspaceId,
    serverIdsByName: hostedServerIdsByName,
    getAccessToken,
    oauthTokensByServerId,
    guestOauthTokensByServerName,
    isAuthenticated,
    serverConfigs: guestServerConfigs,
    enabled: !isHostedChatRoute,
  });

  // Compute the set of server names that have saved views
  const serversWithViews = useMemo(() => {
    const serverNames = new Set<string>();
    for (const serverId of viewsByServer.keys()) {
      const serverName = serversById.get(serverId);
      if (serverName) {
        serverNames.add(serverName);
      }
    }
    return serverNames;
  }, [viewsByServer, serversById]);

  const applyNavigation = useCallback(
    (
      target: string,
      options?: { updateHash?: boolean; enforceCanonicalHash?: boolean },
    ) => {
      if (isSharedChatRoute) {
        const storedSession = readSharedServerSession();
        if (storedSession) {
          const expectedHash = slugify(storedSession.payload.serverName);
          if (window.location.hash !== `#${expectedHash}`) {
            window.location.hash = expectedHash;
          }
        }
        return;
      }

      if (isSandboxChatRoute) {
        const storedSession = readSandboxSession();
        if (storedSession) {
          const expectedHash = slugify(storedSession.payload.name);
          if (window.location.hash !== `#${expectedHash}`) {
            window.location.hash = expectedHash;
          }
        }
        return;
      }

      const resolved = resolveHostedNavigation(target, HOSTED_MODE);

      if (
        options?.enforceCanonicalHash &&
        resolved.rawSection !== resolved.normalizedSection
      ) {
        if (window.location.hash !== `#${resolved.normalizedSection}`) {
          window.location.hash = resolved.normalizedSection;
        }
        return;
      }

      if (resolved.isBlocked) {
        toast.error(
          `${resolved.normalizedTab} is not available in hosted mode.`,
        );
        setActiveOrganizationId(undefined);
        setActiveTab("servers");
        setChatHasMessages(false);
        if (window.location.hash !== "#servers") {
          window.location.hash = "servers";
        }
        return;
      }

      setActiveOrganizationId(resolved.organizationId);
      if (resolved.shouldSelectAllServers) {
        setSelectedMultipleServersToAllServers();
      }
      if (resolved.shouldClearChatMessages) {
        setChatHasMessages(false);
      }
      if (options?.updateHash) {
        window.location.hash = resolved.normalizedSection;
      }
      setActiveTab(resolved.normalizedTab);
    },
    [
      isSandboxChatRoute,
      isSharedChatRoute,
      setSelectedMultipleServersToAllServers,
    ],
  );

  // Sync tab with hash on mount and when hash changes
  useEffect(() => {
    if (isHostedChatRoute) {
      return;
    }

    const applyHash = () => {
      const currentHash = window.location.hash || "#servers";
      applyNavigation(currentHash, { enforceCanonicalHash: true });
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [applyNavigation, isHostedChatRoute]);

  // Redirect away from tabs hidden by the ci-evals feature flag.
  // Use strict equality to avoid redirecting while the flag is still loading (undefined).
  useEffect(() => {
    if (ciEvalsEnabled === true && activeTab === "evals") {
      applyNavigation("servers", { updateHash: true });
    } else if (ciEvalsEnabled === false && activeTab === "ci-evals") {
      applyNavigation("servers", { updateHash: true });
    }
  }, [ciEvalsEnabled, activeTab, applyNavigation]);

  const handleNavigate = (section: string) => {
    applyNavigation(section, { updateHash: true });
  };

  if (isDebugCallback) {
    return <OAuthDebugCallback />;
  }

  if (hostedOAuthHandling) {
    return <LoadingScreen />;
  }

  if (isOAuthCallback && !callbackCompleted) {
    if (callbackRecoveryExpired) {
      return (
        <div
          className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center"
          data-testid="callback-auth-timeout"
        >
          <p className="text-sm text-muted-foreground">
            Sign-in is taking longer than expected.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              onClick={() => signIn()}
            >
              Try sign in again
            </button>
            <button
              type="button"
              className="rounded border px-4 py-2 text-sm font-medium"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return <CompletingSignInLoading />;
  }

  if (isLoading && !isHostedChatRoute) {
    return <LoadingScreen />;
  }

  const hostedShellGateState = resolveHostedShellGateState({
    hostedMode: HOSTED_MODE,
    isConvexAuthLoading: isAuthLoading,
    isConvexAuthenticated: isAuthenticated,
    isWorkOsLoading,
    hasWorkOsUser: !!workOsUser,
    isLoadingRemoteWorkspaces,
  });
  const hostedChatShellGateState = resolveHostedShellGateState({
    hostedMode: HOSTED_MODE,
    isConvexAuthLoading: isAuthLoading,
    isConvexAuthenticated: isAuthenticated,
    isWorkOsLoading,
    hasWorkOsUser: !!workOsUser,
    isLoadingRemoteWorkspaces: false,
  });

  const shouldShowActiveServerSelector =
    activeTab === "tools" ||
    activeTab === "resources" ||
    activeTab === "prompts" ||
    activeTab === "tasks" ||
    activeTab === "oauth-flow" ||
    activeTab === "chat" ||
    activeTab === "chat-v2" ||
    activeTab === "app-builder" ||
    activeTab === "evals" ||
    activeTab === "views";

  const activeServerSelectorProps: ActiveServerSelectorProps | undefined =
    shouldShowActiveServerSelector
      ? {
          serverConfigs:
            activeTab === "oauth-flow"
              ? appState.servers
              : activeTab === "views"
                ? workspaceServers
                : connectedOrConnectingServerConfigs,
          selectedServer: appState.selectedServer,
          onServerChange: setSelectedServer,
          onConnect: handleConnect,
          onReconnect: handleReconnect,
          isMultiSelectEnabled: activeTab === "chat" || activeTab === "chat-v2",
          onMultiServerToggle: toggleServerSelection,
          selectedMultipleServers: appState.selectedMultipleServers,
          showOnlyOAuthServers: activeTab === "oauth-flow",
          showOnlyServersWithViews: activeTab === "views",
          serversWithViews: serversWithViews,
          hasMessages: activeTab === "chat-v2" ? chatHasMessages : false,
        }
      : undefined;

  const appContent = (
    <SidebarProvider defaultOpen={true}>
      <MCPSidebar
        onNavigate={handleNavigate}
        activeTab={activeTab}
        servers={workspaceServers}
      />
      <SidebarInset className="flex flex-col min-h-0">
        <Header activeServerSelectorProps={activeServerSelectorProps} />
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden h-full">
          {/* Content Areas */}
          {activeTab === "servers" && (
            <ServersTab
              connectedOrConnectingServerConfigs={workspaceServers}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onReconnect={handleReconnect}
              onUpdate={handleUpdate}
              onRemove={handleRemoveServer}
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              onSwitchWorkspace={handleSwitchWorkspace}
              onCreateWorkspace={handleCreateWorkspace}
              onUpdateWorkspace={handleUpdateWorkspace}
              onDeleteWorkspace={handleDeleteWorkspace}
              isLoadingWorkspaces={isLoadingRemoteWorkspaces}
              onWorkspaceShared={handleWorkspaceShared}
              onLeaveWorkspace={() => handleLeaveWorkspace(activeWorkspaceId)}
            />
          )}
          {activeTab === "tools" && (
            <div className="h-full overflow-hidden">
              <ToolsTab
                serverConfig={selectedMCPConfig}
                serverName={appState.selectedServer}
              />
            </div>
          )}
          {activeTab === "evals" && (
            <EvalsTab selectedServer={appState.selectedServer} />
          )}
          {activeTab === "ci-evals" && (
            <CiEvalsTab convexWorkspaceId={convexWorkspaceId} />
          )}
          {activeTab === "views" && (
            <ViewsTab
              selectedServer={appState.selectedServer}
              onWorkspaceShared={handleWorkspaceShared}
              onLeaveWorkspace={() => handleLeaveWorkspace(activeWorkspaceId)}
            />
          )}
          {activeTab === "sandboxes" && (
            <SandboxesTab workspaceId={convexWorkspaceId} />
          )}
          {activeTab === "resources" && (
            <div className="h-full overflow-hidden">
              <ResourcesTab
                serverConfig={selectedMCPConfig}
                serverName={appState.selectedServer}
              />
            </div>
          )}

          {activeTab === "prompts" && (
            <div className="h-full overflow-hidden">
              <PromptsTab
                serverConfig={selectedMCPConfig}
                serverName={appState.selectedServer}
              />
            </div>
          )}

          {activeTab === "skills" && <SkillsTab />}

          {activeTab === "learning" && <LearningTab />}

          <div
            className={
              activeTab === "tasks" ? "h-full overflow-hidden" : "hidden"
            }
          >
            <TasksTab
              serverConfig={selectedMCPConfig}
              serverName={appState.selectedServer}
              isActive={activeTab === "tasks"}
            />
          </div>

          {activeTab === "auth" && (
            <AuthTab
              serverConfig={selectedMCPConfig}
              serverEntry={appState.servers[appState.selectedServer]}
              serverName={appState.selectedServer}
            />
          )}

          {activeTab === "oauth-flow" && (
            <OAuthFlowTab
              serverConfigs={appState.servers}
              selectedServerName={appState.selectedServer}
              onSelectServer={setSelectedServer}
              onSaveServerConfig={saveServerConfigWithoutConnecting}
              onConnectWithTokens={handleConnectWithTokensFromOAuthFlow}
              onRefreshTokens={handleRefreshTokensFromOAuthFlow}
            />
          )}
          {activeTab === "chat-v2" && (
            <ChatTabV2
              connectedOrConnectingServerConfigs={
                connectedOrConnectingServerConfigs
              }
              selectedServerNames={appState.selectedMultipleServers}
              onHasMessagesChange={setChatHasMessages}
            />
          )}
          {activeTab === "tracing" && <TracingTab />}
          {activeTab === "app-builder" && (
            <AppBuilderTab
              serverConfig={selectedMCPConfig}
              serverName={appState.selectedServer}
            />
          )}
          {activeTab === "settings" && (
            <SettingsTab
              convexWorkspaceId={convexWorkspaceId}
              workspaceName={activeWorkspace?.name ?? null}
            />
          )}
          {activeTab === "support" && <SupportTab />}
          {activeTab === "profile" && <ProfileTab />}
          {activeTab === "organizations" && (
            <OrganizationsTab organizationId={activeOrganizationId} />
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );

  return (
    <PreferencesStoreProvider
      themeMode={initialThemeMode}
      themePreset={initialThemePreset}
    >
      <AppStateProvider appState={effectiveAppState}>
        <Toaster />
        <HostedShellGate
          state={
            isHostedChatRoute ? hostedChatShellGateState : hostedShellGateState
          }
          onSignIn={() => {
            if (sharedPathToken) {
              writeSharedSignInReturnPath(window.location.pathname);
            }
            if (sandboxPathToken) {
              writeSandboxSignInReturnPath(window.location.pathname);
            }
            signIn();
          }}
        >
          {isSharedChatRoute ? (
            <SharedServerChatPage
              pathToken={sharedPathToken}
              onExitSharedChat={() => setExitedSharedChat(true)}
            />
          ) : isSandboxChatRoute ? (
            <SandboxChatPage
              pathToken={sandboxPathToken}
              onExitSandboxChat={() => setExitedSandboxChat(true)}
            />
          ) : (
            appContent
          )}
        </HostedShellGate>
      </AppStateProvider>
    </PreferencesStoreProvider>
  );
}
