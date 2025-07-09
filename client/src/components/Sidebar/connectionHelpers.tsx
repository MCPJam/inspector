import { Wifi, WifiOff, AlertCircle } from "lucide-react";
import { ServerConnectionInfo } from "@/lib/utils/mcp/mcpjamAgent";
import StringUtil from "@/utils/stringUtil";

const truncate = (s: string, maxLen: number = 35): string => {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
};

export const getConnectionStatusIcon = (status: string) => {
  switch (status) {
    case "connected":
      return <Wifi className="w-4 h-4 text-green-500" />;
    case "disconnected":
      return <WifiOff className="w-4 h-4 text-gray-400" />;
    case "error":
    case "error-connecting-to-proxy":
      return <AlertCircle className="w-4 h-4 text-red-500" />;
    default:
      return <WifiOff className="w-4 h-4 text-gray-400" />;
  }
};

export const getConnectionStatusColor = (status: string) => {
  switch (status) {
    case "connected":
      return "text-green-600 dark:text-green-400";
    case "disconnected":
      return "text-gray-500 dark:text-gray-400";
    case "error":
    case "error-connecting-to-proxy":
      return "text-red-600 dark:text-red-400";
    default:
      return "text-gray-500 dark:text-gray-400";
  }
};

export const getConnectionDisplayText = (connection: ServerConnectionInfo) => {
  // 1) stdio
  if (
    connection.config.transportType === "stdio" &&
    "command" in connection.config
  ) {
    const cmdString = `${connection.config.command} ${
      connection.config.args?.join(" ") || ""
    }`;
    return truncate(cmdString, 35);
  }

  // 2) URL
  if ("url" in connection.config && connection.config.url) {
    return StringUtil.shorten(connection.config.url.toString());
  }

  // 3) fallback
  return "Unknown configuration";
};