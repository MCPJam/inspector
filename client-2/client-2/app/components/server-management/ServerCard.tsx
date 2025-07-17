"use client";

import React from 'react';
import { ServerConfig } from '@/app/types/mcp';
import Card from '@/app/components/ui/Card';
import Button from '@/app/components/ui/Button';

interface ServerCardProps {
  id: string;
  config: ServerConfig;
  isConnected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSelect: () => void;
  isLoading?: boolean;
}

const ServerCard: React.FC<ServerCardProps> = ({
  id,
  config,
  isConnected,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  onSelect,
  isLoading = false,
}) => {
  return (
    <Card className="h-full flex flex-col">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {config.name}
          </h3>
          
          {config.description && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {config.description}
            </p>
          )}
          
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {config.type === 'stdio' ? (
              <div className="flex flex-col">
                <span>STDIO Server</span>
                <span>Command: {config.command} {config.args?.join(' ')}</span>
              </div>
            ) : (
              <div className="flex flex-col">
                <span>HTTP Server</span>
                <span className="truncate">URL: {config.url}</span>
              </div>
            )}
          </div>
        </div>
        
        <div className="flex-shrink-0">
          <span 
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
              ${isConnected 
                ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' 
                : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
              }`}
          >
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>
      
      <div className="mt-4 grid grid-cols-2 gap-2">
        {isConnected ? (
          <Button 
            variant="secondary" 
            size="small" 
            onClick={onDisconnect}
            isLoading={isLoading}
          >
            Disconnect
          </Button>
        ) : (
          <Button 
            variant="primary" 
            size="small" 
            onClick={onConnect}
            isLoading={isLoading}
          >
            Connect
          </Button>
        )}
        
        <Button 
          variant="primary" 
          size="small" 
          onClick={onSelect}
          disabled={!isConnected}
        >
          Select
        </Button>
        
        <Button 
          variant="secondary" 
          size="small" 
          onClick={onEdit}
        >
          Edit
        </Button>
        
        <Button 
          variant="danger" 
          size="small" 
          onClick={onDelete}
          disabled={isConnected}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
};

export default ServerCard;