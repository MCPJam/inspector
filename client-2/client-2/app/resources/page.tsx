"use client";

import React, { useEffect, useState } from 'react';
import MainLayout from '@/app/components/ui/MainLayout';
import ActiveServerBar from '@/app/components/server-management/ActiveServerBar';
import Button from '@/app/components/ui/Button';
import Card from '@/app/components/ui/Card';
import { useServerSelection } from '@/app/hooks/useServerSelection';
import { useMcp } from '@/app/context/McpContext';
import { Resource } from '@/app/types/mcp';

export default function ResourcesPage() {
  const activeServerId = useServerSelection();
  const { servers, resources, loadResources, readResource, isLoading } = useMcp();
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [resourceContent, setResourceContent] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Get the resources for the active server
  const serverResources = activeServerId ? resources[activeServerId] || [] : [];
  
  // Load resources when the active server changes
  useEffect(() => {
    if (activeServerId && servers[activeServerId]?.isConnected) {
      loadResources(activeServerId).catch((error) => {
        console.error('Failed to load resources:', error);
        setError('Failed to load resources');
      });
    }
  }, [activeServerId, servers, loadResources]);
  
  // Read a resource when selected
  const handleResourceSelect = async (resource: Resource) => {
    setSelectedResource(resource.uri);
    setResourceContent(null);
    setError(null);
    
    if (!activeServerId) return;
    
    try {
      const content = await readResource(activeServerId, resource.uri);
      setResourceContent(content);
    } catch (error) {
      console.error('Failed to read resource:', error);
      setError(`Failed to read resource: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  
  return (
    <MainLayout>
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Resources</h1>
        
        <ActiveServerBar serverId={activeServerId} />
        
        {activeServerId && servers[activeServerId]?.isConnected ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-1">
              <Card title="Available Resources">
                {isLoading ? (
                  <div className="py-4 text-center">Loading resources...</div>
                ) : serverResources.length === 0 ? (
                  <div className="py-4 text-center">No resources available</div>
                ) : (
                  <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                    {serverResources.map((resource) => (
                      <li key={resource.uri}>
                        <button
                          onClick={() => handleResourceSelect(resource)}
                          className={`
                            w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition
                            ${selectedResource === resource.uri ? 'bg-blue-50 dark:bg-blue-900' : ''}
                          `}
                        >
                          <div className="font-medium">{resource.name}</div>
                          {resource.description && (
                            <div className="text-sm text-gray-500 dark:text-gray-400">
                              {resource.description}
                            </div>
                          )}
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                            {resource.uri}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                
                {!isLoading && (
                  <div className="mt-4">
                    <Button
                      onClick={() => activeServerId && loadResources(activeServerId)}
                      variant="secondary"
                      size="small"
                      fullWidth
                    >
                      Refresh Resources
                    </Button>
                  </div>
                )}
              </Card>
            </div>
            
            <div className="md:col-span-2">
              <Card title="Resource Content">
                {error ? (
                  <div className="py-4 px-3 bg-red-50 dark:bg-red-900 text-red-800 dark:text-red-200 rounded">
                    {error}
                  </div>
                ) : isLoading && selectedResource ? (
                  <div className="py-4 text-center">Loading resource content...</div>
                ) : resourceContent ? (
                  <pre className="bg-gray-50 dark:bg-gray-900 p-4 rounded-md overflow-auto whitespace-pre-wrap">
                    {JSON.stringify(resourceContent, null, 2)}
                  </pre>
                ) : (
                  <div className="py-8 text-center text-gray-500 dark:text-gray-400">
                    Select a resource to view its content
                  </div>
                )}
              </Card>
            </div>
          </div>
        ) : (
          <Card>
            <div className="py-8 text-center">
              <p className="text-xl mb-4">Connect to a server to view resources</p>
              <Button onClick={() => window.location.href = '/connect'}>
                Go to Connect
              </Button>
            </div>
          </Card>
        )}
      </div>
    </MainLayout>
  );
}