"use client";

import { useState } from "react";

import { ServersTab } from "@/components/ServersTab";
import { ToolsTab } from "@/components/ToolsTab";
import { ResourcesTab } from "@/components/ResourcesTab";
import { PromptsTab } from "@/components/PromptsTab";
import { ChatTab } from "@/components/ChatTab";
import { SettingsTab } from "@/components/SettingsTab";
import { TracingTab } from "@/components/TracingTab";
import { MCPSidebar } from "@/components/mcp-sidebar";
import { ActiveServerSelector } from "@/components/ActiveServerSelector";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThemeSwitcher } from "@/components/sidebar/theme-switcher";
// import { AccountSwitcher } from "@/components/sidebar/account-switcher";
import { useAppState } from "@/hooks/use-app-state";

// const users = [
//   {
//     id: "1",
//     name: "MCP Inspector",
//     email: "inspector@example.com",
//     avatar: "/avatars/shadcn.jpg",
//     role: "Inspector",
//   },
// ] as const;

export default function Home() {
  const [activeTab, setActiveTab] = useState("servers");

  const {
    appState,
    isLoading,
    connectedServerConfigs,
    selectedMCPConfig,
    handleConnect,
    handleDisconnect,
    handleReconnect,
    setSelectedServer,
    toggleServerSelection,
    selectedMCPConfigsMap,
    setSelectedMultipleServersToAllServers,
  } = useAppState();

  const handleNavigate = (section: string) => {
    setActiveTab(section);
    if (section === "chat") {
      setSelectedMultipleServersToAllServers();
    }
  };

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
    <SidebarProvider defaultOpen={true}>
      <MCPSidebar onNavigate={handleNavigate} activeTab={activeTab} />
      <SidebarInset className="flex flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear">
          <div className="flex w-full items-center justify-between px-4 lg:px-6">
            <div className="flex items-center gap-1 lg:gap-2">
              <SidebarTrigger className="-ml-1" />
            </div>
            <div className="flex items-center gap-2">
              <ThemeSwitcher />
              {/* <AccountSwitcher users={users} /> */}
            </div>
          </div>
        </header>

        <div className="flex-1">
          {/* Active Server Selector - Only show on Tools, Resources, and Prompts pages */}
          {(activeTab === "tools" ||
            activeTab === "resources" ||
            activeTab === "prompts" ||
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
            />
          )}

          {activeTab === "tools" && (
            <ToolsTab serverConfig={selectedMCPConfig} />
          )}

          {activeTab === "resources" && (
            <ResourcesTab serverConfig={selectedMCPConfig} />
          )}

          {activeTab === "prompts" && (
            <PromptsTab serverConfig={selectedMCPConfig} />
          )}

          {activeTab === "chat" && (
            <ChatTab serverConfigs={selectedMCPConfigsMap} />
          )}

          {activeTab === "tracing" && <TracingTab />}

          {activeTab === "settings" && <SettingsTab />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
