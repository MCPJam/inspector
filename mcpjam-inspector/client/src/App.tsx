import { useConvexAuth } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { ServersTab } from "./components/ServersTab";
import { ToolsTab } from "./components/ToolsTab";
import { ResourcesTab } from "./components/ResourcesTab";
import { ResourceTemplatesTab } from "./components/ResourceTemplatesTab";
import { PromptsTab } from "./components/PromptsTab";
import { TasksTab } from "./components/TasksTab";
import { ChatTabV2 } from "./components/ChatTabV2";
import { EvalsTab } from "./components/EvalsTab";
import { SettingsTab } from "./components/SettingsTab";
import { TracingTab } from "./components/TracingTab";
import { AuthTab } from "./components/AuthTab";
import { OAuthFlowTab } from "./components/OAuthFlowTab";
import { UIPlaygroundTab } from "./components/ui-playground/UIPlaygroundTab";
import { ProfileTab } from "./components/ProfileTab";
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

export default function App() {
  const [activeTab, setActiveTab] = useState("servers");
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
    connectedServerConfigs,
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
  // Create a stable key for connected servers to avoid infinite loops
  // (connectedServerConfigs is a new object reference on every render)
  const connectedServerNamesKey = useMemo(
    () => Object.keys(connectedServerConfigs).sort().join(","),
    [connectedServerConfigs],
  );

  // Check which connected servers have OpenAI apps tools
  useEffect(() => {
    const checkOpenAiAppOrMcpAppsServers = async () => {
      const connectedServerNames = Object.keys(connectedServerConfigs);
      const serversWithOpenAiAppOrMcpApps = new Set<string>();

      await Promise.all(
        connectedServerNames.map(async (serverName) => {
          try {
            const toolsData = await listTools(serverName);
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

      // Extract the top-level tab from subroutes (e.g., "/evals/suite/123" -> "evals")
      const topLevelTab = hash.startsWith("/") ? hash.split("/")[1] : hash;
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
    activeTab === "resource-templates" ||
    activeTab === "prompts" ||
    activeTab === "tasks" ||
    activeTab === "oauth-flow" ||
    activeTab === "chat" ||
    activeTab === "chat-v2" ||
    activeTab === "app-builder" ||
    activeTab === "evals";

  const activeServerSelectorProps: ActiveServerSelectorProps | undefined =
    shouldShowActiveServerSelector
      ? {
          serverConfigs:
            activeTab === "oauth-flow"
              ? appState.servers
              : connectedServerConfigs,
          selectedServer: appState.selectedServer,
          onServerChange: setSelectedServer,
          onConnect: handleConnect,
          isMultiSelectEnabled: activeTab === "chat" || activeTab === "chat-v2",
          onMultiServerToggle: toggleServerSelection,
          selectedMultipleServers: appState.selectedMultipleServers,
          showOnlyOAuthServers: activeTab === "oauth-flow",
          showOnlyOpenAIAppsServers: activeTab === "app-builder",
          openAiAppOrMcpAppsServers: openAiAppOrMcpAppsServers,
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
              connectedServerConfigs={workspaceServers}
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
          {activeTab === "resources" && (
            <ResourcesTab
              serverConfig={selectedMCPConfig}
              serverName={appState.selectedServer}
            />
          )}

          {activeTab === "resource-templates" && (
            <ResourceTemplatesTab
              serverConfig={selectedMCPConfig}
              serverName={appState.selectedServer}
            />
          )}

          {activeTab === "prompts" && (
            <PromptsTab
              serverConfig={selectedMCPConfig}
              serverName={appState.selectedServer}
            />
          )}

          <div className={activeTab === "tasks" ? "h-full" : "hidden"}>
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
              connectedServerConfigs={connectedServerConfigs}
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
        </div>
      </SidebarInset>
    </SidebarProvider>
  );

  return (
    <PreferencesStoreProvider
      themeMode={initialThemeMode}
      themePreset={initialThemePreset}
    >
      <AppStateProvider appState={appState}>
        <Toaster />
        {appContent}
      </AppStateProvider>
    </PreferencesStoreProvider>
  );
}
