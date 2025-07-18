"use client";

import { useState, useEffect } from "react";
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
import {
  MastraMCPServerDefinition,
  StdioServerDefinition,
  HttpServerDefinition,
} from "@/lib/types";
import { createOAuthFlow, OAuthFlowManager } from "@/lib/oauth-flow";

interface ServerWithName {
  name: string;
  config: MastraMCPServerDefinition;
  oauthFlow?: OAuthFlowManager;
}

interface AppState {
  servers: Record<string, ServerWithName>;
  selectedServer: string;
  oauthFlows: Record<string, OAuthFlowManager>;
}

// UI form interface - only used for the form input
interface ServerFormData {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  useOAuth?: boolean;
  oauthScopes?: string[];
}

export default function Home() {
  const [activeTab, setActiveTab] = useState("servers");
  const [appState, setAppState] = useState<AppState>({
    servers: {},
    selectedServer: "none",
    oauthFlows: {},
  });

  // Load state from localStorage on mount
  useEffect(() => {
    const savedState = localStorage.getItem("mcp-inspector-state");
    if (savedState) {
      try {
        const parsed = JSON.parse(savedState);
        setAppState(parsed);
      } catch (error) {
        console.error("Failed to parse saved state:", error);
      }
    }
  }, []);

  // Save state to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem("mcp-inspector-state", JSON.stringify(appState));
  }, [appState]);

  const connectedServers = Object.keys(appState.servers);
  const selectedServerEntry = appState.servers[appState.selectedServer];
  const selectedMCPConfig = selectedServerEntry?.config;

  // Convert form data to MastraMCPServerDefinition
  const convertFormToMCPConfig = (
    formData: ServerFormData,
  ): MastraMCPServerDefinition => {
    if (formData.type === "stdio") {
      return {
        command: formData.command!,
        args: formData.args,
        env: formData.env,
      } as StdioServerDefinition;
    } else {
      return {
        url: new URL(formData.url!),
        requestInit: { headers: formData.headers || {} },
      } as HttpServerDefinition;
    }
  };

  const handleConnect = async (formData: ServerFormData) => {
    try {
      // Validate form data first
      if (formData.type === "stdio") {
        if (!formData.command || formData.command.trim() === "") {
          alert("Command is required for STDIO connections");
          return;
        }
      } else {
        if (!formData.url || formData.url.trim() === "") {
          alert("URL is required for HTTP connections");
          return;
        }

        try {
          new URL(formData.url);
        } catch (urlError) {
          alert(`Invalid URL format: ${formData.url}`);
          return;
        }
      }

      // Convert form data to MCP config
      const mcpConfig = convertFormToMCPConfig(formData);

      // Handle OAuth flow for HTTP servers
      if (formData.type === "http" && formData.useOAuth && formData.url) {
        const oauthFlow = createOAuthFlow(formData.url, {
          client_name: `MCP Inspector - ${formData.name}`,
          requested_scopes: formData.oauthScopes || ["mcp:*"],
          redirect_uri: `${window.location.origin}/oauth/callback`,
        });

        const oauthResult = await oauthFlow.initiate();

        if (oauthResult.success && oauthResult.authorization_url) {
          // Store OAuth flow for later use
          setAppState((prev) => ({
            ...prev,
            oauthFlows: {
              ...prev.oauthFlows,
              [formData.name]: oauthFlow,
            },
          }));

          // Redirect user to authorization URL
          alert(
            `OAuth flow initiated. You will be redirected to authorize access.`,
          );
          window.location.href = oauthResult.authorization_url;
          return;
        } else {
          alert(
            `OAuth initialization failed: ${oauthResult.error?.error_description || "Unknown error"}`,
          );
          return;
        }
      }

      // For non-OAuth connections, test connection using the stateless endpoint
      const response = await fetch("/api/mcp/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverConfig: mcpConfig,
        }),
      });

      const result = await response.json();

      if (result.success) {
        // Add server to state with both name and config
        setAppState((prev) => ({
          ...prev,
          servers: {
            ...prev.servers,
            [formData.name]: {
              name: formData.name,
              config: mcpConfig,
            },
          },
          selectedServer: formData.name,
        }));

        alert(`Connected successfully! Found ${result.toolCount} tools.`);
      } else {
        alert(`Failed to connect: ${result.error}`);
      }
    } catch (error) {
      alert(`Network error: ${error}`);
    }
  };

  const handleDisconnect = async (serverName: string) => {
    // Remove server from state (no API call needed for stateless architecture)
    setAppState((prev: AppState) => {
      const newServers = { ...prev.servers };
      delete newServers[serverName];

      return {
        servers: newServers,
        selectedServer:
          prev.selectedServer === serverName ? "none" : prev.selectedServer,
        oauthFlows: prev.oauthFlows,
      };
    });
  };

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
                onChange={(e) =>
                  setAppState((prev) => ({
                    ...prev,
                    selectedServer: e.target.value,
                  }))
                }
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
