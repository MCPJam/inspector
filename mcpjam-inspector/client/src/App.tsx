import { useConvexAuth } from "convex/react";
import { useEffect, useMemo, useState } from "react";
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
import { UIPlaygroundTab } from "./components/ui-playground/UIPlaygroundTab";
import { ProfileTab } from "./components/ProfileTab";
import { OrganizationsTab } from "./components/OrganizationsTab";
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
import { listTools } from "./lib/apis/mcp-tools-api";
import {
  isMCPApp,
  isOpenAIApp,
  isOpenAIAppAndMCPApp,
} from "./lib/mcp-ui/mcp-apps-utils";
import type { ActiveServerSelectorProps } from "./components/ActiveServerSelector";
import { useViewQueries, useWorkspaceServers } from "./hooks/useViews";

export default function App() {
  const [activeTab, setActiveTab] = useState("servers");
  const [activeOrganizationId, setActiveOrganizationId] = useState<
    string | undefined
  >(undefined);
  const [chatHasMessages, setChatHasMessages] = useState(false);
  const [openAiAppOrMcpAppsServers, setOpenAiAppOrMcpAppsServers] = useState<
    Set<string>
  >(new Set());
  const posthog = usePostHog();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();

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

  // Create a stable key that only tracks fully "connected" servers (not "connecting")
  // so the effect re-fires when servers finish connecting (e.g., after reconnect)
  const connectedServerNamesKey = useMemo(
    () =>
      Object.entries(connectedOrConnectingServerConfigs)
        .filter(([, server]) => server.connectionStatus === "connected")
        .map(([name]) => name)
        .sort()
        .join(","),
    [connectedOrConnectingServerConfigs],
  );

  // Check which connected servers have OpenAI apps tools
  useEffect(() => {
    const checkOpenAiAppOrMcpAppsServers = async () => {
      const connectedServerNames = Object.entries(
        connectedOrConnectingServerConfigs,
      )
        .filter(([, server]) => server.connectionStatus === "connected")
        .map(([name]) => name);
      const serversWithOpenAiAppOrMcpApps = new Set<string>();

      await Promise.all(
        connectedServerNames.map(async (serverName) => {
          try {
            const toolsData = await listTools({ serverId: serverName });
            if (
              isOpenAIApp(toolsData) ||
              isMCPApp(toolsData) ||
              isOpenAIAppAndMCPApp(toolsData)
            ) {
              serversWithOpenAiAppOrMcpApps.add(serverName);
            }
          } catch (error) {
            console.debug(
              `Failed to check OpenAI apps for server ${serverName}:`,
              error,
            );
          }
        }),
      );

      setOpenAiAppOrMcpAppsServers(serversWithOpenAiAppOrMcpApps);
    };

    checkOpenAiAppOrMcpAppsServers(); // eslint-disable-line react-hooks/exhaustive-deps
  }, [connectedServerNamesKey]);

  // Sync tab with hash on mount and when hash changes
  useEffect(() => {
    const applyHash = () => {
      const hash = (window.location.hash || "#servers").replace("#", "");

      // Remove leading slash before splitting to avoid empty first element
      const trimmedHash = hash.startsWith("/") ? hash.slice(1) : hash;
      const hashParts = trimmedHash.split("/");

      // Extract the top-level tab (e.g., "evals/suite/123" -> "evals")
      const topLevelTab = hashParts[0];

      // Handle organizations/:orgId route
      if (hashParts[0] === "organizations" && hashParts[1]) {
        setActiveOrganizationId(hashParts[1]);
      } else {
        setActiveOrganizationId(undefined);
      }

      const normalizedTab =
        topLevelTab === "registry" ? "servers" : topLevelTab;

      setActiveTab(normalizedTab);
      if (normalizedTab === "chat" || normalizedTab === "chat-v2") {
        setSelectedMultipleServersToAllServers();
      }
      if (normalizedTab !== "chat-v2") {
        setChatHasMessages(false);
      }
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [setSelectedMultipleServersToAllServers]);

  const handleNavigate = (section: string) => {
    if (section === "chat" || section === "chat-v2") {
      setSelectedMultipleServersToAllServers();
    }
    if (section !== "chat-v2") {
      setChatHasMessages(false);
    }
    window.location.hash = section;
    setActiveTab(section);
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
          showOnlyOpenAIAppsServers: activeTab === "app-builder",
          openAiAppOrMcpAppsServers: openAiAppOrMcpAppsServers,
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
        <Header
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSwitchWorkspace={handleSwitchWorkspace}
          onCreateWorkspace={handleCreateWorkspace}
          onUpdateWorkspace={handleUpdateWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
          onLeaveWorkspace={handleLeaveWorkspace}
          onWorkspaceShared={handleWorkspaceShared}
          activeServerSelectorProps={activeServerSelectorProps}
          isLoadingWorkspaces={isLoadingRemoteWorkspaces}
        />
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
              isLoadingWorkspaces={isLoadingRemoteWorkspaces}
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
            <ViewsTab selectedServer={appState.selectedServer} />
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
            <UIPlaygroundTab
              serverConfig={selectedMCPConfig}
              serverName={appState.selectedServer}
            />
          )}
          {activeTab === "settings" && <SettingsTab />}
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
        {appContent}
      </AppStateProvider>
    </PreferencesStoreProvider>
  );
}
