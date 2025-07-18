'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { MessageSquare, Play, RefreshCw } from 'lucide-react';
import { MastraMCPServerDefinition, StdioServerDefinition, HttpServerDefinition } from '@/lib/types';

interface Prompt {
  name: string;
  description?: string;
  arguments?: {
    name: string;
    description?: string;
    required?: boolean;
  }[];
}

interface PromptsTabProps {
  serverConfig?: MastraMCPServerDefinition;
}

export function PromptsTab({ serverConfig }: PromptsTabProps) {
  const [prompts, setPrompts] = useState<Record<string, Prompt[]>>({});
  const [selectedPrompt, setSelectedPrompt] = useState<string>('');
  const [promptArgs, setPromptArgs] = useState<Record<string, string>>({});
  const [promptContent, setPromptContent] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (serverConfig) {
      fetchPrompts();
    }
  }, [serverConfig]);

  const getServerConfig = (): MastraMCPServerDefinition | null => {
    if (!serverConfig) return null;
    return serverConfig;
  };

  const fetchPrompts = async () => {
    const config = getServerConfig();
    if (!config) return;
    
    try {
      const response = await fetch('/api/mcp/prompts/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverConfig: config })
      });
      const data = await response.json();
      
      if (response.ok) {
        setPrompts(data.prompts || {});
      } else {
        setError(data.error || 'Failed to fetch prompts');
      }
    } catch (err) {
      setError('Network error fetching prompts');
    }
  };

  const getPrompt = async () => {
    if (!selectedPrompt) return;
    
    const config = getServerConfig();
    if (!config) return;
    
    setLoading(true);
    setError('');
    
    try {
      const response = await fetch('/api/mcp/prompts/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          serverConfig: config,
          name: selectedPrompt,
          args: promptArgs
        })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        setPromptContent(data.content);
      } else {
        setError(data.error || 'Failed to get prompt');
      }
    } catch (err) {
      setError('Network error getting prompt');
    } finally {
      setLoading(false);
    }
  };

  const allPrompts = Object.values(prompts).flat();
  const currentPrompt = allPrompts.find(p => p.name === selectedPrompt);

  if (!serverConfig) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-gray-500">
            Please select a server to view prompts
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
            <MessageSquare className="h-5 w-5" />
            Prompts
          </CardTitle>
          <CardDescription>
            Use prompts from your MCP server
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button onClick={fetchPrompts} variant="outline" size="sm">
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-gray-500 self-center">
                {allPrompts.length} prompts available
              </span>
            </div>

            {allPrompts.length > 0 && (
              <div>
                <label className="block text-sm font-medium mb-2">Select Prompt</label>
                <select
                  value={selectedPrompt}
                  onChange={(e) => {
                    setSelectedPrompt(e.target.value);
                    setPromptArgs({});
                  }}
                  className="w-full p-2 border rounded"
                >
                  <option value="">Choose a prompt...</option>
                  {allPrompts.map(prompt => (
                    <option key={prompt.name} value={prompt.name}>
                      {prompt.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {currentPrompt && (
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium mb-2">Prompt Details</h4>
                  <div className="p-3 bg-gray-50 rounded">
                    <p className="text-sm"><strong>Name:</strong> {currentPrompt.name}</p>
                    {currentPrompt.description && (
                      <p className="text-sm"><strong>Description:</strong> {currentPrompt.description}</p>
                    )}
                  </div>
                </div>

                {currentPrompt.arguments && currentPrompt.arguments.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="font-medium">Arguments</h4>
                    {currentPrompt.arguments.map(arg => (
                      <div key={arg.name}>
                        <label className="block text-sm font-medium mb-1">
                          {arg.name}
                          {arg.required && <span className="text-red-500 ml-1">*</span>}
                        </label>
                        {arg.description && (
                          <p className="text-sm text-gray-500 mb-1">{arg.description}</p>
                        )}
                        <Input
                          value={promptArgs[arg.name] || ''}
                          onChange={(e) => setPromptArgs(prev => ({
                            ...prev,
                            [arg.name]: e.target.value
                          }))}
                          placeholder={`Enter ${arg.name}`}
                          required={arg.required}
                        />
                      </div>
                    ))}
                  </div>
                )}

                <Button 
                  onClick={getPrompt} 
                  disabled={loading}
                  className="w-full"
                >
                  {loading ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Getting Prompt...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 mr-2" />
                      Get Prompt
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Prompt Content */}
      {(promptContent || error) && (
        <Card>
          <CardHeader>
            <CardTitle>Prompt Content</CardTitle>
          </CardHeader>
          <CardContent>
            {error ? (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700">
                {error}
              </div>
            ) : (
              <div className="space-y-2">
                {promptContent?.messages?.map((message: any, index: number) => (
                  <div key={index} className="border rounded">
                    <div className="p-2 bg-gray-50 border-b">
                      <span className="text-sm font-medium">Role: {message.role}</span>
                    </div>
                    <div className="p-3">
                      {message.content?.type === 'text' ? (
                        <pre className="text-sm whitespace-pre-wrap">{message.content.text}</pre>
                      ) : (
                        <pre className="text-sm bg-gray-50 p-2 rounded overflow-auto">
                          {JSON.stringify(message.content, null, 2)}
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