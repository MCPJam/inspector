"use client";

import { useState, useEffect } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Plus, Database } from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { ServerConnectionCard } from "./connection/ServerConnectionCard";
import { AddServerModal } from "./connection/AddServerModal";
import { ServerFormData } from "@/lib/types";
import { MCPIcon } from "./ui/mcp-icon";

interface ServersTabProps {
  connectedServerConfigs: Record<string, ServerWithName>;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect: (serverName: string) => void;
  onReconnect: (serverName: string) => void;
}

export function ServersTab({
  connectedServerConfigs,
  onConnect,
  onDisconnect,
  onReconnect,
}: ServersTabProps) {
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<"all" | "stdio" | "http">("all");

  useEffect(() => {
    Object.keys(connectedServerConfigs).forEach((serverName) => {
      onReconnect(serverName);
    });
  }, []);

  // Filter and search servers
  // TODO: Search and filter is not implemented yet
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
    <div className="space-y-6 p-8">
      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">MCP Servers</h2>
        </div>
        <Button
          onClick={() => setIsAddingServer(true)}
          className="cursor-pointer"
        >
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
            <MCPIcon className="mx-auto h-12 w-12 text-muted-foreground" />
            <h3 className="mt-4 text-lg font-semibold">No servers connected</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Get started by connecting to your first MCP server
            </p>
            <Button
              onClick={() => setIsAddingServer(true)}
              className="mt-4 cursor-pointer"
            >
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

      {/* Add Server Modal */}
      <AddServerModal
        isOpen={isAddingServer}
        onClose={() => setIsAddingServer(false)}
        onConnect={onConnect}
      />
    </div>
  );
}
