import { useEffect, useMemo, useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { ServersTab } from "./components/ServersTab";
import { ToolsTab } from "./components/ToolsTab";
import { ResourcesTab } from "./components/ResourcesTab";
import { PromptsTab } from "./components/PromptsTab";
import { ChatTab } from "./components/ChatTab";
import { TestsTab } from "./components/TestsTab";
import { SettingsTab } from "./components/SettingsTab";
import { TracingTab } from "./components/TracingTab";
import { AuthTab } from "./components/AuthTab";
import OAuthDebugCallback from "./components/OAuthDebugCallback";
import { MCPSidebar } from "./components/mcp-sidebar";
import { ActiveServerSelector } from "./components/ActiveServerSelector";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "./components/ui/sidebar";
import { ThemeSwitcher } from "./components/sidebar/theme-switcher";
import { useAppState } from "./hooks/use-app-state";
import { PreferencesStoreProvider } from "./stores/preferences/preferences-provider";
import { Toaster } from "./components/ui/sonner";
import { AuthButton } from "./components/AuthButton";
import { useElectronOAuth } from "./hooks/useElectronOAuth";

// Import global styles
import "./index.css";

export default function App() {
  const [activeTab, setActiveTab] = useState("servers");
  const { isAuthenticated } = useConvexAuth();
  const ensureUser = useMutation("users:ensureUser" as any);

  // Set up Electron OAuth callback handling
  useElectronOAuth();
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
  } = useAppState();

  // Ensure a user record exists in Convex when authenticated
  useEffect(() => {
    if (!isAuthenticated) return;
    ensureUser().catch((error) => {
      console.error("Failed to ensure user:", error);
    });
  }, [isAuthenticated, ensureUser]);

  const handleNavigate = (section: string) => {
    setActiveTab(section);
    if (section === "chat") {
      setSelectedMultipleServersToAllServers();
    }
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

    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Completing sign in...</p>
          <p className="mt-2 text-xs text-muted-foreground">
            If this takes too long, you'll be redirected automatically
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <SidebarProvider defaultOpen={true}>
        <MCPSidebar onNavigate={handleNavigate} activeTab={activeTab} />
        <SidebarInset className="flex flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear drag">
            <div className="flex w-full items-center justify-between px-4 lg:px-6">
              <div className="flex items-center gap-1 lg:gap-2">
                <SidebarTrigger className="-ml-1" />
              </div>
              <div className="flex items-center gap-2">
                <ThemeSwitcher />
                <AuthButton />
              </div>
            </div>
          </header>

          <div className="flex-1">
            {/* Active Server Selector - Only show on Tools, Resources, Prompts, and Auth pages */}
            {(activeTab === "tools" ||
              activeTab === "resources" ||
              activeTab === "prompts" ||
              activeTab === "auth" ||
              activeTab === "chat") && (
              <ActiveServerSelector
                connectedServerConfigs={connectedServerConfigs}
                selectedServer={appState.selectedServer}
                onServerChange={setSelectedServer}
                onConnect={handleConnect}
                isMultiSelectEnabled={activeTab === "chat"}
                onMultiServerToggle={toggleServerSelection}
                selectedMultipleServers={appState.selectedMultipleServers}
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
              />
            )}

            {activeTab === "tools" && (
              <ToolsTab
                serverConfig={selectedMCPConfig}
                serverName={appState.selectedServer}
              />
            )}
            {activeTab === "tests" && (
              <TestsTab
                serverConfig={selectedMCPConfig}
                serverConfigsMap={selectedMCPConfigsMap}
                allServerConfigsMap={Object.fromEntries(
                  Object.entries(connectedServerConfigs)
                    .filter(
                      ([, entry]) => entry.connectionStatus === "connected",
                    )
                    .map(([name, entry]) => [name, entry.config]),
                )}
              />
            )}

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

            {activeTab === "chat" && (
              <ChatTab serverConfigs={selectedMCPConfigsMap} />
            )}

            {activeTab === "tracing" && <TracingTab />}

            {activeTab === "settings" && <SettingsTab />}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
    </PreferencesStoreProvider>
  );
}
