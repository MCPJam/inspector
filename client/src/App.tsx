import { useEffect, useMemo, useState } from "react";
import { ServersTab } from "./components/ServersTab";
import { ToolsTab } from "./components/ToolsTab";
import { ResourcesTab } from "./components/ResourcesTab";
import { PromptsTab } from "./components/PromptsTab";
import { ChatTab } from "./components/ChatTab";
import { ChatTabV2 } from "./components/ChatTabV2";
import { EvalsResultsTab } from "./components/EvalsResultsTab";
import { EvalsRunTab } from "./components/EvalsRunTab";
import { SettingsTab } from "./components/SettingsTab";
import { TracingTab } from "./components/TracingTab";
import { InterceptorTab } from "./components/InterceptorTab";
import { AuthTab } from "./components/AuthTab";
import { OAuthFlowTab } from "./components/OAuthFlowTab";
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
import { detectEnvironment, detectPlatform } from "./logs/PosthogUtils";
import CompletingSignInLoading from "./components/CompletingSignInLoading";
import LoadingScreen from "./components/LoadingScreen";
import LoginPage from "./components/LoginPage";
import { useLoginPage } from "./hooks/use-log-in-page";
import { Header } from "./components/Header";

export default function App() {
  const [activeTab, setActiveTab] = useState("servers");
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
      is_authenticated: isAuthenticated,
    });
  }, [isAuthLoading, isAuthenticated]);

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

  // Also check if we're on a regular callback with MCP OAuth params (safety check)
  const isMcpCallbackOnWrongPath = useMemo(() => {
    if (!window.location.pathname.startsWith("/callback")) return false;
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get("code");
    const mcpPending = localStorage.getItem("mcp-oauth-pending");
    // If we have a code and an MCP OAuth pending, this is likely an MCP callback on the wrong path
    return !!(code && mcpPending);
  }, []);

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
      if (hash === "chat" || hash === "chat-v2") {
        setSelectedMultipleServersToAllServers();
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
    window.location.hash = section;
    setActiveTab(section);
  };

  if (isDebugCallback) {
    return <OAuthDebugCallback />;
  }

  // Handle MCP OAuth callback on wrong path - redirect to correct path
  if (isMcpCallbackOnWrongPath) {
    useEffect(() => {
      console.warn("MCP OAuth callback detected on /callback instead of /oauth/callback");
      console.log("Redirecting to correct path...");
      // Redirect to the correct MCP OAuth callback path
      window.location.pathname = "/oauth/callback";
    }, []);

    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center space-y-4 p-8">
          <div className="text-6xl">⚠️</div>
          <h1 className="text-2xl font-semibold">Redirecting OAuth Callback</h1>
          <p className="text-muted-foreground">
            Redirecting to the correct OAuth callback path...
          </p>
        </div>
      </div>
    );
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

  // Handle MCP OAuth callback in external browser
  if (isOAuthCallbackComplete && !window.isElectron) {
    // Automatically redirect to custom protocol so Electron app receives the callback
    useEffect(() => {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get("code");
      const state = urlParams.get("state");
      const error = urlParams.get("error");

      if (code || error) {
        // Build the custom protocol URL
        const protocolUrl = new URL("mcpjam://oauth/callback");
        if (code) protocolUrl.searchParams.set("code", code);
        if (state) protocolUrl.searchParams.set("state", state);
        if (error) protocolUrl.searchParams.set("error", error);

        // Redirect to custom protocol - this will open the Electron app
        window.location.href = protocolUrl.toString();
      }
    }, []);

    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center space-y-4 p-8">
          <div className="text-6xl">✓</div>
          <h1 className="text-2xl font-semibold">Authentication Complete</h1>
          <p className="text-muted-foreground">
            Redirecting to MCPJam Inspector...
          </p>
          <p className="text-sm text-muted-foreground">
            If the app doesn't open automatically, please return to it manually.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return <LoadingScreen />;
  }

  const appContent = (
    <SidebarProvider defaultOpen={true}>
      <MCPSidebar onNavigate={handleNavigate} activeTab={activeTab} />
      <SidebarInset className="flex flex-col min-h-0">
        <Header />
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden h-full">
          {/* Active Server Selector - Only show on Tools, Resources, Prompts, Auth, OAuth Flow, and Interceptor pages */}
          {(activeTab === "tools" ||
            activeTab === "resources" ||
            activeTab === "prompts" ||
            activeTab === "auth" ||
            activeTab === "oauth-flow" ||
            activeTab === "chat" ||
            activeTab === "chat-v2" ||
            activeTab === "interceptor") && (
            <ActiveServerSelector
              connectedServerConfigs={connectedServerConfigs}
              selectedServer={appState.selectedServer}
              onServerChange={setSelectedServer}
              onConnect={handleConnect}
              isMultiSelectEnabled={
                activeTab === "chat" || activeTab === "chat-v2"
              }
              onMultiServerToggle={toggleServerSelection}
              selectedMultipleServers={appState.selectedMultipleServers}
              showOnlyOAuthServers={activeTab === "oauth-flow"}
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
          {activeTab === "evals" && <EvalsRunTab />}
          {activeTab === "eval-results" && <EvalsResultsTab />}
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
              serverConfig={selectedMCPConfig}
              serverEntry={appState.servers[appState.selectedServer]}
              serverName={appState.selectedServer}
              onUpdate={handleUpdate}
            />
          )}

          {activeTab === "chat" && (
            <ChatTab
              serverConfigs={selectedMCPConfigsMap}
              connectedServerConfigs={connectedServerConfigs}
            />
          )}

          {activeTab === "chat-v2" && <ChatTabV2 />}

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
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <Toaster />
      {shouldShowLoginPage && !isOAuthCallbackComplete ? (
        <LoginPage />
      ) : (
        appContent
      )}
    </PreferencesStoreProvider>
  );
}
