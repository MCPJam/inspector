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
import { Plus, Server, Database } from "lucide-react";
import { ServerWithName } from "@/hooks/useAppState";

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
  connectedServerConfigs: Record<string, ServerWithName>;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect: (serverName: string) => void;
  onReconnect: (serverName: string) => void;
}

// Import the new card component
import { ServerConnectionCard } from "./ServerConnectionCard";

export function ServerConnection({
  connectedServerConfigs,
  onConnect,
  onDisconnect,
  onReconnect,
}: ServerConnectionProps) {
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<"all" | "stdio" | "http">("all");
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

  // Filter and search servers
  const filteredServers = Object.entries(connectedServerConfigs).filter(
    ([name, server]) => {
      const matchesSearch = name
        .toLowerCase()
        .includes(searchTerm.toLowerCase());
      const matchesFilter =
        filterType === "all" ||
        (filterType === "stdio" && "command" in server.config) ||
        (filterType === "http" && "url" in server.config);
      return matchesSearch && matchesFilter;
    },
  );

  const connectedCount = Object.keys(connectedServerConfigs).length;

  return (
    <div className="space-y-6">
      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            Server Connections
          </h2>
          <p className="text-muted-foreground">
            Manage your MCP server connections and monitor their status
          </p>
        </div>
        <Button onClick={() => setIsAddingServer(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Server
        </Button>
      </div>
      {/* Server Cards Grid */}
      {connectedCount > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {filteredServers.map(([name, server]) => (
            <ServerConnectionCard
              key={name}
              server={server}
              onDisconnect={onDisconnect}
              onReconnect={onReconnect}
            />
          ))}
        </div>
      ) : (
        <Card className="p-12 text-center">
          <div className="mx-auto max-w-sm">
            <Server className="mx-auto h-12 w-12 text-muted-foreground" />
            <h3 className="mt-4 text-lg font-semibold">No servers connected</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Get started by connecting to your first MCP server
            </p>
            <Button onClick={() => setIsAddingServer(true)} className="mt-4">
              <Plus className="h-4 w-4 mr-2" />
              Add Your First Server
            </Button>
          </div>
        </Card>
      )}

      {filteredServers.length === 0 && connectedCount > 0 && (
        <Card className="p-8 text-center">
          <div className="mx-auto max-w-sm">
            <Database className="mx-auto h-8 w-8 text-muted-foreground" />
            <h3 className="mt-4 text-lg font-semibold">No servers found</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Try adjusting your search or filter criteria
            </p>
          </div>
        </Card>
      )}

      {/* Add Server Modal/Form */}
      {isAddingServer && (
        <Card className="border-2 border-dashed">
          <CardHeader>
            <CardTitle>Add New Server</CardTitle>
            <CardDescription>
              Configure a new MCP server connection
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
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
                  className="w-full p-2 border rounded-md bg-background"
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

                  <div className="space-y-3 p-4 border rounded-lg bg-muted/50">
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
                        <p className="text-xs text-muted-foreground mt-1">
                          Space-separated OAuth scopes. Use &apos;mcp:*&apos;
                          for full access.
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className="flex gap-2 pt-4">
                <Button type="submit">Connect Server</Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsAddingServer(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
