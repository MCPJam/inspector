import { useEffect, useState } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Plus, Database, FileText, Layers } from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { ServerConnectionCard } from "./connection/ServerConnectionCard";
import { AddServerModal } from "./connection/AddServerModal";
import { EditServerModal } from "./connection/EditServerModal";
import { JsonImportModal } from "./connection/JsonImportModal";
import { ServerFormData } from "@/shared/types.js";
import { MCPIcon } from "./ui/mcp-icon";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
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
  const posthog = usePostHog();
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [isImportingJson, setIsImportingJson] = useState(false);
  const [isEditingServer, setIsEditingServer] = useState(false);
  const [serverToEdit, setServerToEdit] = useState<ServerWithName | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<"all" | "stdio" | "http">("all");
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);

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

  useEffect(() => {
    posthog.capture("servers_tab_viewed", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      num_servers: Object.keys(connectedServerConfigs).length,
    });
  }, []);

  const connectedCount = Object.keys(connectedServerConfigs).length;

  const handleEditServer = (server: ServerWithName) => {
    setServerToEdit(server);
    setIsEditingServer(true);
  };

  const handleCloseEditModal = () => {
    setIsEditingServer(false);
    setServerToEdit(null);
  };

  const handleJsonImport = (servers: ServerFormData[]) => {
    servers.forEach((server) => {
      onConnect(server);
    });
  };

  const handleAddServerClick = () => {
    posthog.capture("add_server_button_clicked", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    setIsAddingServer(true);
    setIsActionMenuOpen(false);
  };

  const handleImportJsonClick = () => {
    posthog.capture("import_json_button_clicked", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    setIsImportingJson(true);
    setIsActionMenuOpen(false);
  };

  const handleAddFromRegistryClick = () => {
    posthog.capture("add_from_registry_button_clicked", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    window.location.hash = "registry";
    setIsActionMenuOpen(false);
  };

  return (
    <div className="space-y-6 p-8 h-full overflow-auto">
      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">MCP Servers</h2>
        </div>
        <div className="flex items-center gap-2">
          <HoverCard
            open={isActionMenuOpen}
            onOpenChange={setIsActionMenuOpen}
            openDelay={150}
            closeDelay={100}
          >
            <HoverCardTrigger asChild>
              <Button onClick={handleAddServerClick} className="cursor-pointer">
                <Plus className="h-4 w-4 mr-2" />
                Add Server
              </Button>
            </HoverCardTrigger>
            <HoverCardContent align="end" sideOffset={8} className="w-56 p-3">
              <div className="flex flex-col gap-2">
                <Button
                  variant="ghost"
                  className="justify-start"
                  onClick={handleAddServerClick}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add manually
                </Button>
                <Button
                  variant="ghost"
                  className="justify-start"
                  onClick={handleImportJsonClick}
                >
                  <FileText className="h-4 w-4 mr-2" />
                  Import JSON
                </Button>
                <Button
                  variant="ghost"
                  className="justify-start"
                  onClick={handleAddFromRegistryClick}
                >
                  <Layers className="h-4 w-4 mr-2" />
                  Add from Registry
                </Button>
              </div>
            </HoverCardContent>
          </HoverCard>
        </div>
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
              onEdit={handleEditServer}
              onRemove={onRemove}
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
        onClose={() => {
          setIsAddingServer(false);
        }}
        onSubmit={(formData) => {
          posthog.capture("connecting_server", {
            location: "servers_tab",
            platform: detectPlatform(),
            environment: detectEnvironment(),
          });
          onConnect(formData);
        }}
      />

      {/* Edit Server Modal */}
      {serverToEdit && (
        <EditServerModal
          isOpen={isEditingServer}
          onClose={handleCloseEditModal}
          onSubmit={(formData, originalName) =>
            onUpdate(originalName, formData)
          }
          server={serverToEdit}
        />
      )}

      {/* JSON Import Modal */}
      <JsonImportModal
        isOpen={isImportingJson}
        onClose={() => setIsImportingJson(false)}
        onImport={handleJsonImport}
      />
    </div>
  );
}
