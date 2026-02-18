import { useConvexAuth, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { toast } from "sonner";
import { ServersTab } from "./components/ServersTab";
import { ToolsTab } from "./components/ToolsTab";
import { ResourcesTab } from "./components/ResourcesTab";
import { PromptsTab } from "./components/PromptsTab";
import { SkillsTab } from "./components/SkillsTab";
import { TasksTab } from "./components/TasksTab";
import { ChatTabV2 } from "./components/ChatTabV2";
import { EvalsTab } from "./components/EvalsTab";
import { ViewsTab } from "./components/ViewsTab";
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
import { usePostHog } from "posthog-js/react";
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
import { useOrganizationQueries } from "./hooks/useOrganizations";
import { CreateOrganizationDialog } from "./components/organization/CreateOrganizationDialog";
import {
  HostedShellGate,
  type HostedShellGateState,
} from "./components/hosted/HostedShellGate";
import { useHostedApiContext } from "./hooks/hosted/use-hosted-api-context";
import { HOSTED_MODE } from "./lib/config";
import { resolveHostedNavigation } from "./lib/hosted-navigation";
import { buildOAuthTokensByServerId } from "./lib/oauth/oauth-tokens";

export default function App() {
  const [activeTab, setActiveTab] = useState("servers");
  const [activeOrganizationId, setActiveOrganizationId] = useState<
    string | undefined
  >(undefined);
  const [chatHasMessages, setChatHasMessages] = useState(false);
  const posthog = usePostHog();
  const { getAccessToken, signIn } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const convexUser = useQuery(
    "users:getCurrentUser" as any,
    isAuthenticated ? ({} as any) : "skip",
  );
  const { sortedOrganizations, isLoading: isOrganizationsLoading } =
    useOrganizationQueries({ isAuthenticated });

  const shouldRequireOrganization =
    isAuthenticated &&
    !isAuthLoading &&
    convexUser !== undefined &&
    convexUser !== null &&
    !isOrganizationsLoading &&
    sortedOrganizations.length === 0;

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

  const isDebugCallback = useMemo(
    () => window.location.pathname.startsWith("/oauth/callback/debug"),
    [],
  );
  const isOAuthCallback = useMemo(
    () => window.location.pathname === "/callback",
    [],
  );

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
  useHostedApiContext({
    workspaceId: convexWorkspaceId,
    serverIdsByName: hostedServerIdsByName,
    getAccessToken,
    oauthTokensByServerId,
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
        toast.error(`${resolved.normalizedTab} is not available in hosted mode.`);
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
    [setSelectedMultipleServersToAllServers],
  );

  // Sync tab with hash on mount and when hash changes
  useEffect(() => {
    const applyHash = () => {
      const currentHash = window.location.hash || "#servers";
      applyNavigation(currentHash, { enforceCanonicalHash: true });
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [applyNavigation]);

  const handleNavigate = (section: string) => {
    applyNavigation(section, { updateHash: true });
  };

  if (isDebugCallback) {
    return <OAuthDebugCallback />;
  }

  if (isOAuthCallback) {
    // Handle the actual OAuth callback - AuthKit will process this automatically
    // Show a loading screen while the OAuth flow completes
    useEffect(() => {
      // Fallback: redirect to home after 5 seconds if still stuck
      const timeout = setTimeout(() => {
        window.location.href = "/";
      }, 5000);

      return () => clearTimeout(timeout);
    }, []);

    return <CompletingSignInLoading />;
  }

  if (isLoading) {
    return <LoadingScreen />;
  }

  const hostedShellGateState: HostedShellGateState = !HOSTED_MODE
    ? "ready"
    : isAuthLoading
      ? "auth-loading"
      : !isAuthenticated
        ? "logged-out"
        : isLoadingRemoteWorkspaces
          ? "workspace-loading"
          : "ready";

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
          {activeTab === "views" && (
            <ViewsTab
              selectedServer={appState.selectedServer}
              onWorkspaceShared={handleWorkspaceShared}
              onLeaveWorkspace={() => handleLeaveWorkspace(activeWorkspaceId)}
            />
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
          {activeTab === "settings" && <SettingsTab />}
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
        <CreateOrganizationDialog
          open={shouldRequireOrganization}
          onOpenChange={(open) => {
            void open;
          }}
          required
        />
        <HostedShellGate
          state={hostedShellGateState}
          onSignIn={() => {
            signIn();
          }}
        >
          {appContent}
        </HostedShellGate>
      </AppStateProvider>
    </PreferencesStoreProvider>
  );
}
