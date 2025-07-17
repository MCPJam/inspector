"use client";

import React, { useState } from 'react';
import { ServerConfig } from '@/app/types/mcp';
import ServerCard from './ServerCard';
import Button from '@/app/components/ui/Button';
import ServerForm from './ServerForm';
import { useMcp } from '@/app/context/McpContext';

interface ServerListProps {
  onServerSelect?: (id: string) => void;
}

const ServerList: React.FC<ServerListProps> = ({ onServerSelect }) => {
  const { 
    servers, 
    loadServers, 
    addServer, 
    updateServer, 
    deleteServer, 
    connectToServer, 
    disconnectFromServer, 
    setActiveServer,
    isLoading 
  } = useMcp();
  
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  
  const handleAddServer = async (config: ServerConfig) => {
    try {
      await addServer(config);
      setIsAddingServer(false);
    } catch (error) {
      console.error('Failed to add server:', error);
    }
  };
  
  const handleUpdateServer = async (id: string, config: ServerConfig) => {
    try {
      await updateServer(id, config);
      setEditingServerId(null);
    } catch (error) {
      console.error(`Failed to update server ${id}:`, error);
    }
  };
  
  const handleDeleteServer = async (id: string) => {
    if (confirm('Are you sure you want to delete this server?')) {
      try {
        await deleteServer(id);
      } catch (error) {
        console.error(`Failed to delete server ${id}:`, error);
      }
    }
  };
  
  const handleConnectServer = async (id: string) => {
    try {
      await connectToServer(id);
    } catch (error) {
      console.error(`Failed to connect to server ${id}:`, error);
    }
  };
  
  const handleDisconnectServer = async (id: string) => {
    try {
      await disconnectFromServer(id);
    } catch (error) {
      console.error(`Failed to disconnect from server ${id}:`, error);
    }
  };
  
  const handleServerSelect = (id: string) => {
    setActiveServer(id);
    if (onServerSelect) {
      onServerSelect(id);
    }
  };
  
  // Get servers array from the servers object
  const serversList = Object.entries(servers).map(([id, server]) => ({
    id,
    ...server
  }));
  
  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          MCP Servers
        </h2>
        
        <Button 
          onClick={() => setIsAddingServer(true)}
          disabled={isAddingServer}
        >
          Add New Server
        </Button>
      </div>
      
      {isAddingServer && (
        <div className="mb-6">
          <ServerForm
            onSubmit={handleAddServer}
            onCancel={() => setIsAddingServer(false)}
            isSubmitting={isLoading}
          />
        </div>
      )}
      
      {serversList.length === 0 && !isAddingServer ? (
        <div className="text-center py-12 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
            No servers configured
          </h3>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            Add a new server to get started with the MCP Inspector
          </p>
          <Button onClick={() => setIsAddingServer(true)}>
            Add Your First Server
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {serversList.map((server) => (
            editingServerId === server.id ? (
              <ServerForm
                key={server.id}
                initialValues={server}
                onSubmit={(config) => handleUpdateServer(server.id, config)}
                onCancel={() => setEditingServerId(null)}
                isSubmitting={isLoading}
              />
            ) : (
              <ServerCard
                key={server.id}
                id={server.id}
                config={server}
                isConnected={server.isConnected}
                onConnect={() => handleConnectServer(server.id)}
                onDisconnect={() => handleDisconnectServer(server.id)}
                onEdit={() => setEditingServerId(server.id)}
                onDelete={() => handleDeleteServer(server.id)}
                onSelect={() => handleServerSelect(server.id)}
                isLoading={isLoading}
              />
            )
          ))}
        </div>
      )}
    </div>
  );
};

export default ServerList;