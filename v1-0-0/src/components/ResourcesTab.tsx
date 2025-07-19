'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { FolderOpen, File, RefreshCw, Eye } from 'lucide-react';
import { MastraMCPServerDefinition, StdioServerDefinition, HttpServerDefinition } from '@/lib/types';

interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface ResourcesTabProps {
  serverConfig?: MastraMCPServerDefinition;
}

export function ResourcesTab({ serverConfig }: ResourcesTabProps) {
  const [resources, setResources] = useState<Record<string, Resource[]>>({});
  const [selectedResource, setSelectedResource] = useState<string>('');
  const [resourceContent, setResourceContent] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (serverConfig) {
      fetchResources();
    }
  }, [serverConfig]);

  const getServerConfig = (): MastraMCPServerDefinition | null => {
    if (!serverConfig) return null;
    return serverConfig;
  };

  const fetchResources = async () => {
    const config = getServerConfig();
    if (!config) return;
    
    try {
      const response = await fetch('/api/mcp/resources/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverConfig: config })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        setResources(data.resources || {});
      } else {
        setError(data.error || 'Failed to fetch resources');
      }
    } catch (err) {
      setError('Network error fetching resources');
    }
  };

  const readResource = async (uri: string) => {
    const config = getServerConfig();
    if (!config) return;
    
    setLoading(true);
    setError('');
    
    try {
      const response = await fetch('/api/mcp/resources/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          serverConfig: config,
          uri: uri 
        })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        setResourceContent(data.content);
      } else {
        setError(data.error || 'Failed to read resource');
      }
    } catch (err) {
      setError('Network error reading resource');
    } finally {
      setLoading(false);
    }
  };

  const allResources = Object.values(resources).flat();

  if (!serverConfig) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-gray-500">
            Please select a server to view resources
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5" />
            Resources
          </CardTitle>
          <CardDescription>
            Browse and read resources from your MCP server
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button onClick={fetchResources} variant="outline" size="sm">
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-gray-500 self-center">
                {allResources.length} resources available
              </span>
            </div>

            {allResources.length > 0 && (
              <div className="space-y-2">
                <label className="block text-sm font-medium">Available Resources</label>
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {allResources.map(resource => (
                    <div
                      key={resource.uri}
                      className={`p-3 border rounded cursor-pointer hover:bg-gray-50 ${
                        selectedResource === resource.uri ? 'border-blue-500 bg-blue-50' : ''
                      }`}
                      onClick={() => setSelectedResource(resource.uri)}
                    >
                      <div className="flex items-center gap-2">
                        <File className="h-4 w-4 text-gray-500" />
                        <div className="flex-1">
                          <p className="font-medium">{resource.name}</p>
                          {resource.description && (
                            <p className="text-sm text-gray-500">{resource.description}</p>
                          )}
                          <p className="text-xs text-gray-400">{resource.uri}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedResource && (
              <Button 
                onClick={() => readResource(selectedResource)}
                disabled={loading}
                className="w-full"
              >
                {loading ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Reading...
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4 mr-2" />
                    Read Resource
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Resource Content */}
      {(resourceContent || error) && (
        <Card>
          <CardHeader>
            <CardTitle>Resource Content</CardTitle>
            {selectedResource && (
              <CardDescription className="break-all">{selectedResource}</CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {error ? (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700">
                {error}
              </div>
            ) : (
              <div className="space-y-2">
                {resourceContent?.contents?.map((content: any, index: number) => (
                  <div key={index} className="border rounded">
                    <div className="p-2 bg-gray-50 border-b">
                      <span className="text-sm font-medium">Type: {content.type}</span>
                      {content.mimeType && (
                        <span className="text-sm text-gray-500 ml-2">({content.mimeType})</span>
                      )}
                    </div>
                    <div className="p-3">
                      {content.type === 'text' ? (
                        <pre className="text-sm whitespace-pre-wrap">{content.text}</pre>
                      ) : (
                        <pre className="text-sm bg-gray-50 p-2 rounded overflow-auto">
                          {JSON.stringify(content, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}