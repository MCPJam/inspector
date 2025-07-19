"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Plus, Link, Link2Off } from "lucide-react";

interface ServerFormData {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  useOAuth?: boolean;
  oauthScopes?: string[];
}

interface ServerConnectionProps {
  connectedServers: string[];
  onConnect: (formData: ServerFormData) => void;
  onDisconnect: (serverName: string) => void;
}

export function ServerConnection({
  connectedServers,
  onConnect,
  onDisconnect,
}: ServerConnectionProps) {
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [serverFormData, setServerFormData] = useState<ServerFormData>({
    name: "",
    type: "stdio",
    command: "",
    args: [],
    url: "",
    headers: {},
    env: {},
    useOAuth: true,
    oauthScopes: ["mcp:*"],
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (serverFormData.name) {
      onConnect(serverFormData);
      setServerFormData({
        name: "",
        type: "stdio",
        command: "",
        args: [],
        url: "",
        headers: {},
        env: {},
        useOAuth: false,
        oauthScopes: ["mcp:*"],
      });
      setIsAddingServer(false);
    }
  };

  const handleArgsChange = (value: string) => {
    setServerFormData((prev) => ({
      ...prev,
      args: value.split(" ").filter((arg) => arg.trim()),
    }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link className="h-5 w-5" />
          Server Connections
        </CardTitle>
        <CardDescription>Manage your MCP server connections</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Connected Servers */}
          {connectedServers.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium">Connected Servers:</h4>
              {connectedServers.map((server) => (
                <div
                  key={server}
                  className="flex items-center justify-between p-2 bg-green-50 rounded border"
                >
                  <span className="font-medium">{server}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onDisconnect(server)}
                    className="text-red-600 hover:text-red-700"
                  >
                    <Link2Off className="h-4 w-4 mr-1" />
                    Disconnect
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Add Server Form */}
          {!isAddingServer ? (
            <Button onClick={() => setIsAddingServer(true)} className="w-full">
              <Plus className="h-4 w-4 mr-2" />
              Add Server
            </Button>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="space-y-4 p-4 border rounded"
            >
              <div>
                <label className="block text-sm font-medium mb-1">
                  Server Name
                </label>
                <Input
                  value={serverFormData.name}
                  onChange={(e) =>
                    setServerFormData((prev) => ({
                      ...prev,
                      name: e.target.value,
                    }))
                  }
                  placeholder="my-mcp-server"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Type</label>
                <select
                  value={serverFormData.type}
                  onChange={(e) =>
                    setServerFormData((prev) => ({
                      ...prev,
                      type: e.target.value as "stdio" | "http",
                    }))
                  }
                  className="w-full p-2 border rounded"
                >
                  <option value="stdio">STDIO</option>
                  <option value="http">HTTP</option>
                </select>
              </div>

              {serverFormData.type === "stdio" ? (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Command
                    </label>
                    <Input
                      value={serverFormData.command}
                      onChange={(e) =>
                        setServerFormData((prev) => ({
                          ...prev,
                          command: e.target.value,
                        }))
                      }
                      placeholder="npx"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      Arguments
                    </label>
                    <Input
                      value={serverFormData.args?.join(" ") || ""}
                      onChange={(e) => handleArgsChange(e.target.value)}
                      placeholder="-y @modelcontextprotocol/server-filesystem /path/to/directory"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      URL
                    </label>
                    <Input
                      value={serverFormData.url}
                      onChange={(e) =>
                        setServerFormData((prev) => ({
                          ...prev,
                          url: e.target.value,
                        }))
                      }
                      placeholder="http://localhost:8080/mcp"
                      required
                    />
                  </div>

                  {/* OAuth Configuration */}
                  <div className="space-y-3 p-3 border rounded bg-gray-50">
                    <div className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        id="useOAuth"
                        checked={serverFormData.useOAuth}
                        onChange={(e) =>
                          setServerFormData((prev) => ({
                            ...prev,
                            useOAuth: e.target.checked,
                          }))
                        }
                        className="w-4 h-4"
                      />
                      <label htmlFor="useOAuth" className="text-sm font-medium">
                        Use OAuth 2.1 Authentication
                      </label>
                    </div>

                    {serverFormData.useOAuth && (
                      <div>
                        <label className="block text-sm font-medium mb-1">
                          OAuth Scopes
                        </label>
                        <Input
                          value={serverFormData.oauthScopes?.join(" ") || ""}
                          onChange={(e) =>
                            setServerFormData((prev) => ({
                              ...prev,
                              oauthScopes: e.target.value
                                .split(" ")
                                .filter((s) => s.trim()),
                            }))
                          }
                          placeholder="mcp:* mcp:tools mcp:resources"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Space-separated OAuth scopes. Use &apos;mcp:*&apos;
                          for full access.
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className="flex gap-2">
                <Button type="submit">Connect</Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsAddingServer(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
