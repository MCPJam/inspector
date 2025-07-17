"use client";

import React, { useEffect, useState } from 'react';
import MainLayout from '@/app/components/ui/MainLayout';
import ActiveServerBar from '@/app/components/server-management/ActiveServerBar';
import Button from '@/app/components/ui/Button';
import Card from '@/app/components/ui/Card';
import Input from '@/app/components/ui/Input';
import { useServerSelection } from '@/app/hooks/useServerSelection';
import { useMcp } from '@/app/context/McpContext';
import { Tool } from '@/app/types/mcp';

export default function ToolsPage() {
  const activeServerId = useServerSelection();
  const { servers, tools, loadTools, executeTool, isLoading } = useMcp();
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [parameters, setParameters] = useState<Record<string, any>>({});
  const [result, setResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Get the tools for the active server
  const serverTools = activeServerId ? tools[activeServerId] || [] : [];
  
  // Load tools when the active server changes
  useEffect(() => {
    if (activeServerId && servers[activeServerId]?.isConnected) {
      loadTools(activeServerId).catch((error) => {
        console.error('Failed to load tools:', error);
        setError('Failed to load tools');
      });
    }
  }, [activeServerId, servers, loadTools]);
  
  const handleToolSelect = (tool: Tool) => {
    setSelectedTool(tool);
    setParameters({});
    setResult(null);
    setError(null);
  };
  
  const handleParameterChange = (key: string, value: any) => {
    setParameters((prev) => ({ ...prev, [key]: value }));
  };
  
  const handleExecute = async () => {
    if (!activeServerId || !selectedTool) return;
    
    setResult(null);
    setError(null);
    
    try {
      const toolResult = await executeTool(
        activeServerId, 
        selectedTool.name, 
        parameters
      );
      setResult(toolResult);
    } catch (error) {
      console.error('Failed to execute tool:', error);
      setError(`Failed to execute tool: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  
  // Helper function to render parameter inputs based on schema
  const renderParameterInputs = () => {
    if (!selectedTool?.inputSchema?.properties) {
      return null;
    }
    
    return Object.entries(selectedTool.inputSchema.properties).map(([key, schema]: [string, any]) => {
      const isRequired = selectedTool.inputSchema.required?.includes(key);
      const label = `${key}${isRequired ? ' *' : ''}`;
      
      switch (schema.type) {
        case 'string':
          return (
            <Input
              key={key}
              label={label}
              value={parameters[key] || ''}
              onChange={(e) => handleParameterChange(key, e.target.value)}
              required={isRequired}
              helperText={schema.description}
              fullWidth
            />
          );
        case 'number':
        case 'integer':
          return (
            <Input
              key={key}
              label={label}
              type="number"
              value={parameters[key] || ''}
              onChange={(e) => handleParameterChange(key, parseFloat(e.target.value))}
              required={isRequired}
              helperText={schema.description}
              fullWidth
            />
          );
        case 'boolean':
          return (
            <div key={key} className="flex items-center mb-4">
              <input
                id={key}
                type="checkbox"
                checked={!!parameters[key]}
                onChange={(e) => handleParameterChange(key, e.target.checked)}
                className="mr-2"
              />
              <label htmlFor={key} className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {label}
              </label>
              {schema.description && (
                <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                  ({schema.description})
                </span>
              )}
            </div>
          );
        case 'object':
          return (
            <div key={key} className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {label}
              </label>
              <textarea
                value={parameters[key] ? JSON.stringify(parameters[key], null, 2) : ''}
                onChange={(e) => {
                  try {
                    const value = e.target.value ? JSON.parse(e.target.value) : {};
                    handleParameterChange(key, value);
                  } catch (error) {
                    // If the JSON is invalid, don't update the state
                    console.error('Invalid JSON:', error);
                  }
                }}
                rows={5}
                className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md shadow-sm"
                placeholder="{ ... }"
              />
              {schema.description && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {schema.description}
                </p>
              )}
            </div>
          );
        default:
          return (
            <Input
              key={key}
              label={`${label} (${schema.type})`}
              value={parameters[key] || ''}
              onChange={(e) => handleParameterChange(key, e.target.value)}
              required={isRequired}
              helperText={schema.description}
              fullWidth
            />
          );
      }
    });
  };
  
  return (
    <MainLayout>
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">Tools</h1>
        
        <ActiveServerBar serverId={activeServerId} />
        
        {activeServerId && servers[activeServerId]?.isConnected ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-1">
              <Card title="Available Tools">
                {isLoading ? (
                  <div className="py-4 text-center">Loading tools...</div>
                ) : serverTools.length === 0 ? (
                  <div className="py-4 text-center">No tools available</div>
                ) : (
                  <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                    {serverTools.map((tool) => (
                      <li key={tool.name}>
                        <button
                          onClick={() => handleToolSelect(tool)}
                          className={`
                            w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition
                            ${selectedTool?.name === tool.name ? 'bg-blue-50 dark:bg-blue-900' : ''}
                          `}
                        >
                          <div className="font-medium">{tool.name}</div>
                          {tool.description && (
                            <div className="text-sm text-gray-500 dark:text-gray-400">
                              {tool.description}
                            </div>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                
                {!isLoading && (
                  <div className="mt-4">
                    <Button
                      onClick={() => activeServerId && loadTools(activeServerId)}
                      variant="secondary"
                      size="small"
                      fullWidth
                    >
                      Refresh Tools
                    </Button>
                  </div>
                )}
              </Card>
            </div>
            
            <div className="md:col-span-2">
              {selectedTool ? (
                <div className="space-y-6">
                  <Card title={`Tool: ${selectedTool.name}`}>
                    <div className="mb-4">
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        {selectedTool.description}
                      </p>
                    </div>
                    
                    <form 
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleExecute();
                      }}
                    >
                      <div className="space-y-4">
                        {renderParameterInputs()}
                        
                        <div className="pt-2">
                          <Button
                            type="submit"
                            isLoading={isLoading}
                          >
                            Execute Tool
                          </Button>
                        </div>
                      </div>
                    </form>
                  </Card>
                  
                  <Card title="Result">
                    {error ? (
                      <div className="py-4 px-3 bg-red-50 dark:bg-red-900 text-red-800 dark:text-red-200 rounded">
                        {error}
                      </div>
                    ) : isLoading ? (
                      <div className="py-4 text-center">Executing tool...</div>
                    ) : result ? (
                      <pre className="bg-gray-50 dark:bg-gray-900 p-4 rounded-md overflow-auto whitespace-pre-wrap">
                        {JSON.stringify(result, null, 2)}
                      </pre>
                    ) : (
                      <div className="py-8 text-center text-gray-500 dark:text-gray-400">
                        Execute the tool to see results
                      </div>
                    )}
                  </Card>
                </div>
              ) : (
                <Card>
                  <div className="py-8 text-center text-gray-500 dark:text-gray-400">
                    Select a tool from the list to get started
                  </div>
                </Card>
              )}
            </div>
          </div>
        ) : (
          <Card>
            <div className="py-8 text-center">
              <p className="text-xl mb-4">Connect to a server to access tools</p>
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