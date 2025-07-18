"use client";

/**
 * MCP Inspector - OAuth Flow Solution
 *
 * This implementation solves the OAuth state persistence problem by:
 *
 * 1. **Storing Serializable State**: Instead of storing the entire OAuthFlowManager
 *    (which contains complex objects and methods), we store only the essential
 *    serializable data needed to complete the OAuth flow.
 *
 * 2. **State Management**: The `pendingOAuthCallbacks` object stores OAuth state
 *    data keyed by the `state` parameter, which serves as a unique identifier
 *    for each OAuth flow.
 *
 * 3. **Callback Handling**: When the OAuth callback occurs, the callback page
 *    redirects back to the main page with the callback parameters. The main page
 *    then:
 *    - Checks for callback parameters in the URL
 *    - Looks up the stored OAuth state using the `state` parameter
 *    - Recreates the OAuth flow manager for discovery
 *    - Manually exchanges the authorization code for tokens
 *    - Updates the server configuration with the new tokens
 *
 * 4. **Token Management**: The solution includes:
 *    - Automatic token refresh when tokens are about to expire
 *    - Persistent storage of tokens in localStorage
 *    - Proper cleanup of pending callbacks after successful completion
 *
 * Key Benefits:
 * - No state loss during OAuth redirects
 * - Proper PKCE implementation for security
 * - Automatic token refresh handling
 * - Clean separation of concerns
 */

import { useState } from "react";
import { ServerConnection } from "@/components/ServerConnection";
import { ToolsTab } from "@/components/ToolsTab";
import { ResourcesTab } from "@/components/ResourcesTab";
import { PromptsTab } from "@/components/PromptsTab";
import { ChatTab } from "@/components/ChatTab";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Wrench,
  FolderOpen,
  MessageSquare,
  MessageCircle,
  Server,
} from "lucide-react";
import { useAppState } from "@/hooks/useAppState";

export default function Home() {
  const [activeTab, setActiveTab] = useState("servers");

  const {
    appState,
    isLoading,
    connectedServers,
    selectedMCPConfig,
    handleConnect,
    handleDisconnect,
    setSelectedServer,
  } = useAppState();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  const tabs = [
    { id: "servers", label: "Servers", icon: Server },
    { id: "tools", label: "Tools", icon: Wrench },
    { id: "resources", label: "Resources", icon: FolderOpen },
    { id: "prompts", label: "Prompts", icon: MessageSquare },
    { id: "chat", label: "Chat", icon: MessageCircle },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto p-6">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">MCP Inspector</h1>
          <p className="text-gray-600 mt-2">
            A Next.js clone of MCPJam built with Mastra MCP
          </p>
        </div>

        {/* Server Selection */}
        {connectedServers.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Active Server</CardTitle>
            </CardHeader>
            <CardContent>
              <select
                value={appState.selectedServer}
                onChange={(e) => setSelectedServer(e.target.value)}
                className="w-full p-2 border rounded"
              >
                <option value="none">Select a server...</option>
                {connectedServers.map((server) => (
                  <option key={server} value={server}>
                    {server}
                  </option>
                ))}
              </select>
            </CardContent>
          </Card>
        )}

        {/* Tabs */}
        <div className="mb-6">
          <div className="flex space-x-1 border-b">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 font-medium text-sm rounded-t-lg transition-colors ${
                    activeTab === tab.id
                      ? "bg-white text-blue-600 border-b-2 border-blue-600"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab Content */}
        <div className="bg-white rounded-lg shadow-sm">
          {activeTab === "servers" && (
            <div className="p-6">
              <ServerConnection
                connectedServers={connectedServers}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
              />
            </div>
          )}

          {activeTab === "tools" && (
            <div className="p-6">
              <ToolsTab serverConfig={selectedMCPConfig} />
            </div>
          )}

          {activeTab === "resources" && (
            <div className="p-6">
              <ResourcesTab serverConfig={selectedMCPConfig} />
            </div>
          )}

          {activeTab === "prompts" && (
            <div className="p-6">
              <PromptsTab serverConfig={selectedMCPConfig} />
            </div>
          )}

          {activeTab === "chat" && (
            <div className="p-6">
              <ChatTab serverConfig={selectedMCPConfig} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
