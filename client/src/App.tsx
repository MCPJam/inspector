import { useEffect, useMemo, useState } from "react";
import { ServersTab } from "./components/ServersTab";
import { ToolsTab } from "./components/ToolsTab";
import { ResourcesTab } from "./components/ResourcesTab";
import { PromptsTab } from "./components/PromptsTab";
import { ChatTabV2 } from "./components/ChatTabV2";
import { EvalsTab } from "./components/EvalsTab";
import { SettingsTab } from "./components/SettingsTab";
import { TracingTab } from "./components/TracingTab";
import { InterceptorTab } from "./components/InterceptorTab";
import { AuthTab } from "./components/AuthTab";
import { OAuthFlowTab } from "./components/OAuthFlowTab";
import { RegistryTab } from "./components/RegistryTab";
import OAuthDebugCallback from "./components/oauth/OAuthDebugCallback";
import { MCPSidebar } from "./components/mcp-sidebar";
import { ActiveServerSelector } from "./components/ActiveServerSelector";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
import { useAppState } from "./hooks/use-app-state";
import { PreferencesStoreProvider } from "./stores/preferences/preferences-provider";
import { RegistryStoreProvider } from "./stores/registry/registry-provider";
import { Toaster } from "./components/ui/sonner";
import { useElectronOAuth } from "./hooks/useElectronOAuth";
import { useEnsureDbUser } from "./hooks/useEnsureDbUser";
import { usePostHog } from "posthog-js/react";
import { usePostHogIdentify } from "./hooks/usePostHogIdentify";

// Import global styles
import "./index.css";
import { AuthUpperArea } from "./components/auth/auth-upper-area";
import { detectEnvironment, detectPlatform } from "./logs/PosthogUtils";
import {
  getInitialThemeMode,
  updateThemeMode,
  getInitialThemePreset,
  updateThemePreset,
} from "./lib/theme-utils";
import CompletingSignInLoading from "./components/CompletingSignInLoading";
import LoadingScreen from "./components/LoadingScreen";
import LoginPage from "./components/LoginPage";
import { useLoginPage } from "./hooks/use-log-in-page";
import { Header } from "./components/Header";
import { ThemePreset } from "./types/preferences/theme";

export default function App() {
  const [activeTab, setActiveTab] = useState("servers");
  const [chatHasMessages, setChatHasMessages] = useState(false);
  const posthog = usePostHog();
  const { shouldShowLoginPage, isAuthenticated, isAuthLoading } =
    useLoginPage();

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
  const isOAuthCallbackComplete = useMemo(
    () => window.location.pathname.startsWith("/oauth/callback"),
    [],
  );

  const {
    appState,
    isLoading,
    connectedServerConfigs,
    selectedMCPConfig,
    handleConnect,
    handleDisconnect,
    handleReconnect,
    handleUpdate,
    handleRemoveServer,
    setSelectedServer,
    toggleServerSelection,
    selectedMCPConfigsMap,
    setSelectedMultipleServersToAllServers,
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    handleSwitchWorkspace,
    handleCreateWorkspace,
    handleUpdateWorkspace,
    handleDeleteWorkspace,
    saveServerConfigWithoutConnecting,
  } = useAppState();
  // Sync tab with hash on mount and when hash changes
  useEffect(() => {
    const applyHash = () => {
      const hash = (window.location.hash || "#servers").replace("#", "");
      setActiveTab(hash);
      if (hash === "chat" || hash === "chat-v2") {
        setSelectedMultipleServersToAllServers();
      }
      if (hash !== "chat-v2") {
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

  const appContent = (
    <SidebarProvider defaultOpen={true}>
      <MCPSidebar onNavigate={handleNavigate} activeTab={activeTab} />
      <SidebarInset className="flex flex-col min-h-0">
        <Header
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSwitchWorkspace={handleSwitchWorkspace}
          onCreateWorkspace={handleCreateWorkspace}
          onUpdateWorkspace={handleUpdateWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
        />
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden h-full">
          {/* Active Server Selector - Only show on Tools, Resources, Prompts, Auth, OAuth Flow, and Interceptor pages */}
          {(activeTab === "tools" ||
            activeTab === "resources" ||
            activeTab === "prompts" ||
            activeTab === "oauth-flow" ||
            activeTab === "chat" ||
            activeTab === "chat-v2" ||
            activeTab === "interceptor") && (
            <ActiveServerSelector
              serverConfigs={appState.servers}
              selectedServer={appState.selectedServer}
              onServerChange={setSelectedServer}
              onConnect={handleConnect}
              isMultiSelectEnabled={
                activeTab === "chat" || activeTab === "chat-v2"
              }
              onMultiServerToggle={toggleServerSelection}
              selectedMultipleServers={appState.selectedMultipleServers}
              showOnlyOAuthServers={activeTab === "oauth-flow"}
              hasMessages={activeTab === "chat-v2" ? chatHasMessages : false}
            />
          )}

          {/* Content Areas */}
          {activeTab === "servers" && (
            <ServersTab
              connectedServerConfigs={connectedServerConfigs}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onReconnect={handleReconnect}
              onUpdate={handleUpdate}
              onRemove={handleRemoveServer}
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              activeWorkspace={activeWorkspace}
              onSwitchWorkspace={handleSwitchWorkspace}
              onCreateWorkspace={handleCreateWorkspace}
              onUpdateWorkspace={handleUpdateWorkspace}
              onDeleteWorkspace={handleDeleteWorkspace}
            />
          )}

          {activeTab === "registry" && (
            <RegistryTab onConnect={handleConnect} />
          )}

          {activeTab === "tools" && (
            <div className="h-full overflow-hidden">
              <ToolsTab
                serverConfig={selectedMCPConfig}
                serverName={appState.selectedServer}
              />
            </div>
          )}
          {activeTab === "evals" && <EvalsTab />}
          {activeTab === "resources" && (
            <ResourcesTab
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

          {activeTab === "auth" && (
            <AuthTab
              serverConfig={selectedMCPConfig}
              serverEntry={appState.servers[appState.selectedServer]}
              serverName={appState.selectedServer}
            />
          )}

          {activeTab === "oauth-flow" && (
            <OAuthFlowTab
              serverConfigs={connectedServerConfigs}
              selectedServerName={appState.selectedServer}
              onSelectServer={setSelectedServer}
              onSaveServerConfig={saveServerConfigWithoutConnecting}
            />
          )}

          {activeTab === "chat-v2" && (
            <ChatTabV2
              connectedServerConfigs={connectedServerConfigs}
              selectedServerNames={appState.selectedMultipleServers}
              onHasMessagesChange={setChatHasMessages}
            />
          )}

          {activeTab === "interceptor" && (
            <InterceptorTab
              connectedServerConfigs={connectedServerConfigs}
              selectedServer={appState.selectedServer}
            />
          )}

          {activeTab === "tracing" && <TracingTab />}

          {activeTab === "settings" && <SettingsTab />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );

  return (
    <PreferencesStoreProvider
      themeMode={initialThemeMode}
      themePreset={initialThemePreset}
    >
      <RegistryStoreProvider>
        <Toaster />
        {shouldShowLoginPage && !isOAuthCallbackComplete ? (
          <LoginPage />
        ) : (
          appContent
        )}
      </RegistryStoreProvider>
    </PreferencesStoreProvider>
  );
}
