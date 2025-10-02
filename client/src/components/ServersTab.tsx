import { useState } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Plus, FileText, Server } from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { ServerConnectionCard } from "./connection/ServerConnectionCard";
import { ServerModal } from "./connection/ServerModal";
import { JsonImportModal } from "./connection/JsonImportModal";
import { ServerFormData } from "@/shared/types.js";
import { MCPIcon } from "./ui/mcp-icon";

interface ServersTabProps {
  connectedServerConfigs: Record<string, ServerWithName>;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect: (serverName: string) => void;
  onReconnect: (serverName: string) => void;
  onUpdate: (originalServerName: string, formData: ServerFormData) => void;
  onRemove: (serverName: string) => void;
}

export function ServersTab({
  connectedServerConfigs,
  onConnect,
  onDisconnect,
  onReconnect,
  onUpdate,
  onRemove,
}: ServersTabProps) {
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [isImportingJson, setIsImportingJson] = useState(false);
  const [isEditingServer, setIsEditingServer] = useState(false);
  const [serverToEdit, setServerToEdit] = useState<ServerWithName | null>(null);

  // Removed automatic reconnection since centralized agent maintains persistent connections
  // useEffect(() => {
  //   Object.entries(connectedServerConfigs).forEach(([serverName, server]) => {
  //     if (server.enabled !== false) {
  //       onReconnect(serverName);
  //     }
  //   });
  // }, []);

  const connectedCount = Object.keys(connectedServerConfigs).length;
  const servers = Object.entries(connectedServerConfigs);

  // Calculate statistics
  const connectedServers = servers.filter(
    ([, server]) => server.connectionStatus === "connected",
  ).length;
  const failedServers = servers.filter(
    ([, server]) => server.connectionStatus === "failed",
  ).length;
  const connectingServers = servers.filter(
    ([, server]) =>
      server.connectionStatus === "connecting" ||
      server.connectionStatus === "oauth-flow",
  ).length;

  const handleEditServer = (server: ServerWithName) => {
    setServerToEdit(server);
    setIsEditingServer(true);
  };

  const handleCloseEditModal = () => {
    setIsEditingServer(false);
    setServerToEdit(null);
  };

  const handleJsonImport = (servers: ServerFormData[]) => {
    // Import each server by calling onConnect for each one
    servers.forEach((server) => {
      onConnect(server);
    });
  };

  return (
    <div className="bg-gradient-to-br from-background via-background to-muted/20">
      <div className="px-4 sm:px-6 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* Enhanced Header Section */}
        <div className="space-y-4 sm:space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Server className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
                    MCP Servers
                  </h1>
                  <p className="text-muted-foreground">
                    Manage your Model Context Protocol server connections
                  </p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              <Button
                onClick={() => setIsImportingJson(true)}
                variant="outline"
                className="cursor-pointer hover:bg-accent/50 transition-all duration-200"
              >
                <FileText className="h-4 w-4 mr-2" />
                Import JSON
              </Button>
              <Button
                onClick={() => setIsAddingServer(true)}
                className="cursor-pointer bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 transition-all duration-200 shadow-lg hover:shadow-xl"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Server
              </Button>
            </div>
          </div>

          {/* Statistics Dashboard */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <Badge variant="secondary" className="px-3 py-1">
                <Server className="h-3 w-3 mr-1" />
                {connectedCount} Total
              </Badge>
              <Badge variant="outline" className="px-3 py-1">
                {connectedServers} Connected
              </Badge>
              <Badge variant="outline" className="px-3 py-1">
                {connectingServers} Connecting
              </Badge>
              <Badge variant="outline" className="px-3 py-1">
                {failedServers} Failed
              </Badge>
            </div>
          </div>
        </div>

        {/* Enhanced Server Cards Grid */}
        {connectedCount > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-6">
            {servers.map(([name, server]) => (
              <ServerConnectionCard
                key={name}
                server={server}
                onDisconnect={onDisconnect}
                onReconnect={onReconnect}
                onEdit={handleEditServer}
                onRemove={onRemove}
              />
            ))}
          </div>
        ) : (
          <Card className="border-dashed border-2 border-border/50 bg-gradient-to-br from-card/50 to-card/30 backdrop-blur-sm">
            <div className="p-8 sm:p-12 md:p-16 text-center">
              <div className="mx-auto max-w-md space-y-6">
                <div className="mx-auto w-20 h-20 rounded-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
                  <MCPIcon className="h-10 w-10 text-primary/60" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-semibold">
                    No servers connected
                  </h3>
                  <p className="text-muted-foreground leading-relaxed">
                    Get started by connecting to your first MCP server. You can
                    add servers manually or import from JSON configuration.
                  </p>
                </div>
                <div className="flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
                  <Button
                    onClick={() => setIsAddingServer(true)}
                    className="cursor-pointer bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 transition-all duration-200 shadow-lg hover:shadow-xl"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Your First Server
                  </Button>
                  <Button
                    onClick={() => setIsImportingJson(true)}
                    variant="outline"
                    className="cursor-pointer hover:bg-accent/50 transition-all duration-200"
                  >
                    <FileText className="h-4 w-4 mr-2" />
                    Import JSON
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Modals */}
        <ServerModal
          mode="add"
          isOpen={isAddingServer}
          onClose={() => setIsAddingServer(false)}
          onSubmit={(formData) => onConnect(formData)}
        />

        {serverToEdit && (
          <ServerModal
            mode="edit"
            isOpen={isEditingServer}
            onClose={handleCloseEditModal}
            onSubmit={(formData, originalName) =>
              onUpdate(originalName!, formData)
            }
            server={serverToEdit}
          />
        )}

        <JsonImportModal
          isOpen={isImportingJson}
          onClose={() => setIsImportingJson(false)}
          onImport={handleJsonImport}
        />
      </div>
    </div>
  );
}
