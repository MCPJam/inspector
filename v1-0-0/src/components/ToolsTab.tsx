"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";
import { Wrench, Play, RefreshCw } from "lucide-react";
import type { MCPToolType } from "@mastra/core/mcp";
import { ZodType, ZodTypeDef } from "zod";
import { MastraMCPServerDefinition, StdioServerDefinition, HttpServerDefinition } from "@/lib/types";

interface Tool {
  name: string;
  description?: string;
  inputSchema: ZodType<any, ZodTypeDef, any>;
  outputSchema?: Record<string, unknown>;
  toolType?: MCPToolType;
}

interface ToolsTabProps {
  serverConfig?: MastraMCPServerDefinition;
}

export function ToolsTab({ serverConfig }: ToolsTabProps) {
  const [tools, setTools] = useState<Record<string, Tool>>({});
  const [selectedTool, setSelectedTool] = useState<string>("");
  const [toolParams, setToolParams] = useState<string>("{}");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  
  useEffect(() => {
    if (serverConfig) {
      fetchTools();
    }
  }, [serverConfig]);

  const getServerConfig = (): MastraMCPServerDefinition | null => {
    if (!serverConfig) return null;
    return serverConfig;
  };

  const fetchTools = async () => {
    const config = getServerConfig();
    if (!config) return;
    
    try {
      const response = await fetch('/api/mcp/tools/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverConfig: config })
      });
      
      const data = await response.json();

      if (response.ok) {
        setTools(data.tools || {});
      } else {
        setError(data.error || "Failed to fetch tools");
      }
    } catch (err) {
      setError("Network error fetching tools");
    }
  };

  const executeTool = async () => {
    if (!selectedTool) return;

    const config = getServerConfig();
    if (!config) return;

    setLoading(true);
    setError("");

    try {
      const params = JSON.parse(toolParams);
      const response = await fetch("/api/mcp/tools/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          serverConfig: config,
          toolName: selectedTool,
          parameters: params,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setResult(data.result);
      } else {
        setError(data.error || "Failed to execute tool");
      }
    } catch (err) {
      setError("Invalid JSON parameters or network error");
    } finally {
      setLoading(false);
    }
  };

  const toolNames = Object.keys(tools);

  if (!serverConfig) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-gray-500">
            Please select a server to view tools
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
            <Wrench className="h-5 w-5" />
            Tools
          </CardTitle>
          <CardDescription>Execute tools from your MCP server</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button onClick={fetchTools} variant="outline" size="sm">
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-gray-500 self-center">
                {toolNames.length} tools available
              </span>
            </div>

            {toolNames.length > 0 && (
              <div>
                <label className="block text-sm font-medium mb-2">
                  Select Tool
                </label>
                <select
                  value={selectedTool}
                  onChange={(e) => setSelectedTool(e.target.value)}
                  className="w-full p-2 border rounded"
                >
                  <option value="">Choose a tool...</option>
                  {toolNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selectedTool && (
              <div className="space-y-4">
                <div>
                  <h4 className="font-medium mb-2">Tool Details</h4>
                  <div className="p-3 bg-gray-50 rounded">
                    <p className="text-sm">
                      <strong>Name:</strong> {tools[selectedTool]?.name}
                    </p>
                    <p className="text-sm">
                      <strong>Description:</strong>{" "}
                      {tools[selectedTool]?.description}
                    </p>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm font-medium">
                        Input Schema
                      </summary>
                      <pre className="mt-1 text-xs bg-white p-2 rounded border overflow-auto">
                        {JSON.stringify(tools[selectedTool]?.inputSchema)}
                      </pre>
                    </details>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">
                    Parameters (JSON)
                  </label>
                  <textarea
                    value={toolParams}
                    onChange={(e) => setToolParams(e.target.value)}
                    className="w-full p-2 border rounded font-mono text-sm"
                    rows={4}
                    placeholder='{"key": "value"}'
                  />
                </div>

                <Button
                  onClick={executeTool}
                  disabled={loading}
                  className="w-full"
                >
                  {loading ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Executing...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 mr-2" />
                      Execute Tool
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {(result || error) && (
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardContent>
            {error ? (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700">
                {error}
              </div>
            ) : (
              <pre className="bg-gray-50 p-3 rounded border text-sm overflow-auto">
                {JSON.stringify(result, null, 2)}
              </pre>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
