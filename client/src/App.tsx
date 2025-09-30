import { useEffect, useMemo, useState } from "react";
import { ServersTab } from "./components/ServersTab";
import { ToolsTab } from "./components/ToolsTab";
import { ResourcesTab } from "./components/ResourcesTab";
import { PromptsTab } from "./components/PromptsTab";
import { ChatTab } from "./components/ChatTab";
import { EvalsTab } from "./components/EvalsTab";
import { SettingsTab } from "./components/SettingsTab";
import { TracingTab } from "./components/TracingTab";
import { InterceptorTab } from "./components/InterceptorTab";
import { AuthTab } from "./components/AuthTab";
import OAuthDebugCallback from "./components/OAuthDebugCallback";
import { MCPSidebar } from "./components/mcp-sidebar";
import { ActiveServerSelector } from "./components/ActiveServerSelector";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "./components/ui/sidebar";
import { useAppState } from "./hooks/use-app-state";
import { PreferencesStoreProvider } from "./stores/preferences/preferences-provider";
import { Toaster } from "./components/ui/sonner";
import { useElectronOAuth } from "./hooks/useElectronOAuth";
import { useEnsureDbUser } from "./hooks/useEnsureDbUser";
import { usePostHog } from "posthog-js/react";
import { usePostHogIdentify } from "./hooks/usePostHogIdentify";

// Import global styles
import "./index.css";
import { AuthUpperArea } from "./components/auth/auth-upper-area";

function detectPlatform() {
  // Check if running in Docker
  const isDocker =
    import.meta.env.VITE_DOCKER === "true" ||
    import.meta.env.VITE_RUNTIME === "docker";

  if (isDocker) {
    return "docker";
  }

  // Check if Electron
  const isElectron = (window as any)?.isElectron;

  if (isElectron) {
    // Detect OS within Electron using userAgent
    const userAgent = navigator.userAgent.toLowerCase();

    if (userAgent.includes("mac") || userAgent.includes("darwin")) {
      return "mac";
    } else if (userAgent.includes("win")) {
      return "win";
    }
    return "electron"; // fallback
  }

  // npm package running in browser
  return "npm";
}

export default function App() {
  const [activeTab, setActiveTab] = useState("servers");
  const posthog = usePostHog();

  // Automatically identify users in PostHog when they log in/out
  usePostHogIdentify();

  // Capture app launch event once on mount
  useEffect(() => {
    const platform = detectPlatform();
    posthog.capture("app_launched", {
      platform,
      user_agent: navigator.userAgent,
    });
  }, [posthog]);

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

  // Sync tab with hash on mount and when hash changes
  useEffect(() => {
    const applyHash = () => {
      const hash = (window.location.hash || "#servers").replace("#", "");
      setActiveTab(hash);
      if (hash === "chat") setSelectedMultipleServersToAllServers();
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [setSelectedMultipleServersToAllServers]);

  const handleNavigate = (section: string) => {
    if (section === "chat") {
      setSelectedMultipleServersToAllServers();
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
                <AuthUpperArea />
              </div>
            </div>
          </header>

          <div className="flex-1">
            {/* Active Server Selector - Only show on Tools, Resources, Prompts, Auth, and Interceptor pages */}
            {(activeTab === "tools" ||
              activeTab === "resources" ||
              activeTab === "prompts" ||
              activeTab === "auth" ||
              activeTab === "chat" ||
              activeTab === "interceptor") && (
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

            {activeTab === "chat" && (
              <ChatTab
                serverConfigs={selectedMCPConfigsMap}
                connectedServerConfigs={connectedServerConfigs}
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
      <Toaster />
    </PreferencesStoreProvider>
  );
}
