import { useState } from "react";
import { ServerWithName } from "@/hooks/useAppState";
import { cn } from "@/lib/utils";
import { AddServerModal } from "./connection/AddServerModal";
import { ServerFormData } from "@/lib/types";

interface ActiveServerSelectorProps {
  connectedServerConfigs: Record<string, ServerWithName>;
  selectedServer: string;
  onServerChange: (server: string) => void;
  onConnect: (formData: ServerFormData) => void;
}

function getStatusColor(status: string): string {
  switch (status) {
    case "connected":
      return "bg-green-500 dark:bg-green-400";
    case "connecting":
      return "bg-yellow-500 dark:bg-yellow-400 animate-pulse";
    case "failed":
      return "bg-red-500 dark:bg-red-400";
    case "disconnected":
      return "bg-muted-foreground";
    default:
      return "bg-muted-foreground";
  }
}

function getStatusText(status: string): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting...";
    case "failed":
      return "Failed";
    case "disconnected":
      return "Disconnected";
    default:
      return "Unknown";
  }
}

export function ActiveServerSelector({
  connectedServerConfigs,
  selectedServer,
  onServerChange,
  onConnect,
}: ActiveServerSelectorProps) {
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const servers = Object.entries(connectedServerConfigs);

  if (servers.length === 0) {
    return (
      <div className="mb-6 p-4 border rounded-lg bg-muted/30 text-center text-sm text-muted-foreground">
        No servers connected. Add a server to get started.
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap">
        {servers.map(([name, serverConfig]) => (
          <button
            key={name}
            onClick={() => onServerChange(name)}
            className={cn(
              "group relative flex items-center gap-3 px-4 py-3 border-r border-b border-border transition-all duration-200 cursor-pointer",
              "hover:bg-accent hover:text-accent-foreground",
              selectedServer === name
                ? "bg-muted text-foreground"
                : "bg-background text-foreground",
            )}
          >
            <div
              className={cn(
                "w-2 h-2 rounded-full",
                getStatusColor(serverConfig.connectionStatus),
              )}
              title={getStatusText(serverConfig.connectionStatus)}
            />
            <span className="text-sm font-medium truncate max-w-36">
              {name}
            </span>
            <div className="text-xs opacity-70">
              {serverConfig.config.command ? "STDIO" : "HTTP"}
            </div>
          </button>
        ))}

        {/* Add Server Button */}
        <button
          onClick={() => setIsAddModalOpen(true)}
          className={cn(
            "group relative flex items-center gap-3 px-4 py-3 border-r border-b border-border transition-all duration-200 cursor-pointer",
            "hover:bg-accent hover:text-accent-foreground",
            "bg-background text-muted-foreground border-dashed",
          )}
        >
          <span className="text-sm font-medium">Add Server</span>
          <div className="text-xs opacity-70">+</div>
        </button>
      </div>

      <AddServerModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onConnect={onConnect}
      />
    </div>
  );
}
