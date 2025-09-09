import React, { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Plus, Trash2, TestTube } from 'lucide-react';

interface DynamicToolDefinition {
  id: string;
  name: string;
  description: string;
  executionType: 'http' | 'javascript';
  implementation: {
    url?: string;
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    code?: string;
  };
}

interface DynamicToolsManagerProps {
  onToolCreated?: (tool: DynamicToolDefinition) => void;
}

export function DynamicToolsManager({ onToolCreated }: DynamicToolsManagerProps) {
  const [tools, setTools] = useState<DynamicToolDefinition[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [newTool, setNewTool] = useState<Partial<DynamicToolDefinition>>({
    executionType: 'http',
    implementation: {
      method: 'POST',
      headers: {}
    }
  });

  // Load existing tools
  React.useEffect(() => {
    loadTools();
  }, []);

  const loadTools = async () => {
    try {
      const response = await fetch('/api/mcp/dynamic-tools/list');
      if (response.ok) {
        const data = await response.json();
        setTools(data.tools || []);
      }
    } catch (error) {
      console.error('Failed to load dynamic tools:', error);
    }
  };

  const createTool = async () => {
    if (!newTool.id || !newTool.name || !newTool.description) {
      alert('Please fill in all required fields');
      return;
    }

    try {
      const response = await fetch('/api/mcp/dynamic-tools/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTool)
      });

      if (response.ok) {
        const result = await response.json();
        console.log('Tool created:', result);
        setIsCreating(false);
        setNewTool({
          executionType: 'http',
          implementation: { method: 'POST', headers: {} }
        });
        loadTools();
        onToolCreated?.(newTool as DynamicToolDefinition);
      } else {
        const error = await response.json();
        alert(`Failed to create tool: ${error.error}`);
      }
    } catch (error) {
      console.error('Failed to create tool:', error);
      alert('Failed to create tool');
    }
  };

  const deleteTool = async (id: string) => {
    if (!confirm('Are you sure you want to delete this tool?')) return;

    try {
      const response = await fetch(`/api/mcp/dynamic-tools/${id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        loadTools();
      } else {
        const error = await response.json();
        alert(`Failed to delete tool: ${error.error}`);
      }
    } catch (error) {
      console.error('Failed to delete tool:', error);
      alert('Failed to delete tool');
    }
  };

  const testTool = async (id: string) => {
    try {
      const response = await fetch(`/api/mcp/dynamic-tools/test/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: {} })
      });

      if (response.ok) {
        const result = await response.json();
        alert(`Tool test result: ${result.message}`);
      } else {
        const error = await response.json();
        alert(`Tool test failed: ${error.error}`);
      }
    } catch (error) {
      console.error('Failed to test tool:', error);
      alert('Failed to test tool');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Dynamic Tools</h2>
        <Button onClick={() => setIsCreating(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Create Tool
        </Button>
      </div>

      {/* Create Tool Form */}
      {isCreating && (
        <Card>
          <CardHeader>
            <CardTitle>Create Dynamic Tool</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Tool ID*</label>
                <Input
                  value={newTool.id || ''}
                  onChange={(e) => setNewTool({ ...newTool, id: e.target.value })}
                  placeholder="unique-tool-id"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Tool Name*</label>
                <Input
                  value={newTool.name || ''}
                  onChange={(e) => setNewTool({ ...newTool, name: e.target.value })}
                  placeholder="My Dynamic Tool"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Description*</label>
              <Textarea
                value={newTool.description || ''}
                onChange={(e) => setNewTool({ ...newTool, description: e.target.value })}
                placeholder="What does this tool do?"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Execution Type</label>
              <Select
                value={newTool.executionType || 'http'}
                onValueChange={(value: 'http' | 'javascript') => 
                  setNewTool({ ...newTool, executionType: value })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP API Call</SelectItem>
                  <SelectItem value="javascript" disabled>JavaScript (Coming Soon)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {newTool.executionType === 'http' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">API URL*</label>
                  <Input
                    value={newTool.implementation?.url || ''}
                    onChange={(e) => setNewTool({
                      ...newTool,
                      implementation: { ...newTool.implementation, url: e.target.value }
                    })}
                    placeholder="https://api.example.com/endpoint"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">HTTP Method</label>
                  <Select
                    value={newTool.implementation?.method || 'POST'}
                    onValueChange={(value: 'GET' | 'POST') => 
                      setNewTool({
                        ...newTool,
                        implementation: { ...newTool.implementation, method: value }
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="GET">GET</SelectItem>
                      <SelectItem value="POST">POST</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={createTool}>Create Tool</Button>
              <Button variant="outline" onClick={() => setIsCreating(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tools List */}
      <div className="grid gap-4">
        {tools.map((tool) => (
          <Card key={tool.id}>
            <CardContent className="pt-6">
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <h3 className="font-semibold">{tool.name}</h3>
                  <p className="text-sm text-gray-600 mt-1">{tool.description}</p>
                  <div className="mt-2 text-xs space-y-1">
                    <div><strong>ID:</strong> {tool.id}</div>
                    <div><strong>Type:</strong> {tool.executionType}</div>
                    {tool.implementation.url && (
                      <div><strong>URL:</strong> {tool.implementation.url}</div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => testTool(tool.id)}
                  >
                    <TestTube className="w-4 h-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => deleteTool(tool.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {tools.length === 0 && !isCreating && (
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-gray-500">No dynamic tools created yet.</p>
            <Button className="mt-2" onClick={() => setIsCreating(true)}>
              Create your first dynamic tool
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
