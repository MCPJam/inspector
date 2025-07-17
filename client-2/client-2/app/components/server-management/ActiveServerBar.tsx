"use client";

import React from 'react';
import Link from 'next/link';
import { useMcp } from '@/app/context/McpContext';
import Button from '@/app/components/ui/Button';

interface ActiveServerBarProps {
  serverId: string | null;
}

const ActiveServerBar: React.FC<ActiveServerBarProps> = ({ serverId }) => {
  const { servers, disconnectFromServer, setActiveServer } = useMcp();
  
  if (!serverId || !servers[serverId]) {
    return (
      <div className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-6 flex justify-between items-center">
        <div>
          <p className="text-gray-600 dark:text-gray-400">
            No server selected. Please connect to a server first.
          </p>
        </div>
        
        <Link href="/connect">
          <Button>Connect to Server</Button>
        </Link>
      </div>
    );
  }
  
  const server = servers[serverId];
  
  return (
    <div className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg mb-6 flex justify-between items-center">
      <div>
        <div className="flex items-center">
          <h2 className="text-lg font-medium mr-3">{server.name}</h2>
          <span 
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
              ${server.isConnected 
                ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' 
                : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
              }`}
          >
            {server.isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        
        {server.description && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {server.description}
          </p>
        )}
      </div>
      
      <div className="flex space-x-3">
        {server.isConnected && (
          <Button 
            variant="secondary" 
            size="small" 
            onClick={() => disconnectFromServer(serverId)}
          >
            Disconnect
          </Button>
        )}
        
        <Link href="/connect">
          <Button 
            variant="secondary" 
            size="small"
          >
            Change Server
          </Button>
        </Link>
      </div>
    </div>
  );
};

export default ActiveServerBar;