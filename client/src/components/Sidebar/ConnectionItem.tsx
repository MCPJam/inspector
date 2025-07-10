import React from "react";
import { Button } from "@/components/ui/button";
import { Edit2, Trash2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ServerConnectionInfo } from "@/lib/utils/mcp/mcpjamAgent";
import {
  getConnectionStatusIcon,
  getConnectionStatusColor,
  getConnectionDisplayText,
} from "./connectionHelpers";

interface ConnectionItemProps {
  connection: ServerConnectionInfo;
  selectedServerName: string;
  onServerSelect: (serverName: string) => void;
  onEditClient: (serverName: string) => void;
  onRemoveServer: (serverName: string) => Promise<void>;
  onConnectServer: (serverName: string) => Promise<void>;
  onDisconnectServer: (serverName: string) => Promise<void>;
  shouldDisableConnection: () => boolean;
  getConnectTooltipMessage: () => string;
}

const ConnectionItem: React.FC<ConnectionItemProps> = ({
  connection,
  selectedServerName,
  onServerSelect,
  onEditClient,
  onRemoveServer,
  onConnectServer,
  onDisconnectServer,
  shouldDisableConnection,
  getConnectTooltipMessage,
}) => {
  const renderConnectionActions = () => (
    <div className="flex space-x-1">
      <Button
        onClick={(e) => {
          e.stopPropagation();
          onEditClient(connection.name);
        }}
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0"
      >
        <Edit2 className="w-3 h-3" />
      </Button>
      <Button
        onClick={(e) => {
          e.stopPropagation();
          onRemoveServer(connection.name);
        }}
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
      >
        <Trash2 className="w-3 h-3" />
      </Button>
    </div>
  );

  const renderConnectionButton = () => {
    if (connection.connectionStatus === "connected") {
      return (
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onDisconnectServer(connection.name);
          }}
          size="sm"
          variant="outline"
          className="h-6 text-xs px-2"
        >
          Disconnect
        </Button>
      );
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-block">
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onConnectServer(connection.name);
                onServerSelect(connection.name);
              }}
              size="sm"
              className="h-6 text-xs px-2"
              disabled={shouldDisableConnection()}
            >
              Connect
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{getConnectTooltipMessage()}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div
      className={`p-3 rounded-lg border cursor-pointer transition-all hover:bg-muted/50 ${
        selectedServerName === connection.name
          ? "border-primary bg-primary/10"
          : "border-border"
      }`}
      onClick={() => onServerSelect(connection.name)}
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            {getConnectionStatusIcon(connection.connectionStatus)}
            <div>
              <div className="font-medium text-sm">{connection.name}</div>
              <div className="text-xs text-muted-foreground">
                {getConnectionDisplayText(connection)}
              </div>
            </div>
          </div>
          {renderConnectionActions()}
        </div>

        <div className="flex items-center justify-between">
          <span
            className={`text-xs capitalize ${getConnectionStatusColor(connection.connectionStatus)}`}
          >
            {connection.connectionStatus}
          </span>
          <div className="flex space-x-1">
            {renderConnectionButton()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConnectionItem;