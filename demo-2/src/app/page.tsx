'use client';

import { useState, useEffect } from 'react';
import { ServerConnection } from '@/components/ServerConnection';
import { ToolsTab } from '@/components/ToolsTab';
import { ResourcesTab } from '@/components/ResourcesTab';
import { PromptsTab } from '@/components/PromptsTab';
import { ChatTab } from '@/components/ChatTab';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Wrench, FolderOpen, MessageSquare, MessageCircle, Server } from 'lucide-react';

interface ServerConfig {
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface AppState {
  servers: Record<string, ServerConfig>;
  selectedServer: string;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState('servers');
  const [appState, setAppState] = useState<AppState>({
    servers: {},
    selectedServer: 'none',
  });

  // Load state from localStorage on mount
  useEffect(() => {
    const savedState = localStorage.getItem('mcp-inspector-state');
    if (savedState) {
      try {
        const parsed = JSON.parse(savedState);
        setAppState(parsed);
      } catch (error) {
        console.error('Failed to parse saved state:', error);
      }
    }
  }, []);

  // Save state to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('mcp-inspector-state', JSON.stringify(appState));
  }, [appState]);

  const connectedServers = Object.keys(appState.servers);
  const selectedServerConfig = appState.servers[appState.selectedServer];

  const handleConnect = async (config: ServerConfig) => {
    try {
      let serverConfig;
      
      if (config.type === 'stdio') {
        serverConfig = { command: config.command, args: config.args, env: config.env };
      } else {
        // Validate URL for HTTP connections
        if (!config.url || config.url.trim() === '') {
          alert('URL is required for HTTP connections');
          return;
        }
        
        try {
          const urlObj = new URL(config.url);
          serverConfig = { url: urlObj, requestInit: { headers: config.headers } };
        } catch (urlError) {
          alert(`Invalid URL format: ${config.url}`);
          return;
        }
      }

      // Test connection using the new stateless endpoint
      const response = await fetch('/api/mcp/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverConfig
        })
      });

      const result = await response.json();
      
      if (result.success) {
        // Add server to state
        setAppState(prev => ({
          ...prev,
          servers: {
            ...prev.servers,
            [config.name]: config
          },
          selectedServer: config.name
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
    setAppState(prev => {
      const newServers = { ...prev.servers };
      delete newServers[serverName];
      
      return {
        servers: newServers,
        selectedServer: prev.selectedServer === serverName ? 'none' : prev.selectedServer
      };
    });
  };

  const tabs = [
    { id: 'servers', label: 'Servers', icon: Server },
    { id: 'tools', label: 'Tools', icon: Wrench },
    { id: 'resources', label: 'Resources', icon: FolderOpen },
    { id: 'prompts', label: 'Prompts', icon: MessageSquare },
    { id: 'chat', label: 'Chat', icon: MessageCircle },
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
                onChange={(e) => setAppState(prev => ({
                  ...prev,
                  selectedServer: e.target.value
                }))}
                className="w-full p-2 border rounded"
              >
                <option value="none">Select a server...</option>
                {connectedServers.map(server => (
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
            {tabs.map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 font-medium text-sm rounded-t-lg transition-colors ${
                    activeTab === tab.id
                      ? 'bg-white text-blue-600 border-b-2 border-blue-600'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
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
          {activeTab === 'servers' && (
            <div className="p-6">
              <ServerConnection
                connectedServers={connectedServers}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
              />
            </div>
          )}

          {activeTab === 'tools' && (
            <div className="p-6">
              <ToolsTab serverConfig={selectedServerConfig} />
            </div>
          )}

          {activeTab === 'resources' && (
            <div className="p-6">
              <ResourcesTab serverConfig={selectedServerConfig} />
            </div>
          )}

          {activeTab === 'prompts' && (
            <div className="p-6">
              <PromptsTab serverConfig={selectedServerConfig} />
            </div>
          )}

          {activeTab === 'chat' && (
            <div className="p-6">
              <ChatTab serverConfig={selectedServerConfig} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}