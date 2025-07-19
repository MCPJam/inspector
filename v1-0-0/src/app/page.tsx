"use client";

import { useState } from "react";

import { ServerConnection } from "@/components/ServerConnection";
import { ToolsTab } from "@/components/ToolsTab";
import { ResourcesTab } from "@/components/ResourcesTab";
import { PromptsTab } from "@/components/PromptsTab";
import { ChatTab } from "@/components/ChatTab";
import { MCPSidebar } from "@/components/mcp-sidebar";
import { ActiveServerSelector } from "@/components/ActiveServerSelector";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { SearchDialog } from "@/components/sidebar/search-dialog";
import { ThemeSwitcher } from "@/components/sidebar/theme-switcher";
import { AccountSwitcher } from "@/components/sidebar/account-switcher";
import { useAppState } from "@/hooks/useAppState";

const users = [
  {
    id: "1",
    name: "MCP Inspector",
    email: "inspector@example.com",
    avatar: "/avatars/shadcn.jpg",
    role: "Inspector",
  },
] as const;

export default function Home() {
  const [activeTab, setActiveTab] = useState("servers");

  const {
    appState,
    isLoading,
    connectedServers,
    connectedServerConfigs,
    selectedMCPConfig,
    handleConnect,
    handleDisconnect,
    setSelectedServer,
  } = useAppState();

  const handleNavigate = (section: string) => {
    setActiveTab(section);
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
      <MCPSidebar onNavigate={handleNavigate} />
      <SidebarInset className="flex flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear">
          <div className="flex w-full items-center justify-between px-4 lg:px-6">
            <div className="flex items-center gap-1 lg:gap-2">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mx-2 data-[orientation=vertical]:h-4"
              />
              <SearchDialog />
            </div>
            <div className="flex items-center gap-2">
              <ThemeSwitcher />
              <AccountSwitcher users={users} />
            </div>
          </div>
        </header>

        <div className="flex-1 p-4 md:p-6">
          {/* Active Server Selector - Only show on Tools, Resources, and Prompts pages */}
          {(activeTab === "tools" ||
            activeTab === "resources" ||
            activeTab === "prompts") && (
            <ActiveServerSelector
              connectedServers={connectedServers}
              selectedServer={appState.selectedServer}
              onServerChange={setSelectedServer}
            />
          )}

          {/* Content Areas */}
          {activeTab === "servers" && (
            <ServerConnection
              connectedServerConfigs={connectedServerConfigs}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
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

          {activeTab === "chat" && <ChatTab serverConfig={selectedMCPConfig} />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
