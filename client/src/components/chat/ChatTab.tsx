import React from "react";
import { MCPJamAgent } from "@/lib/utils/mcp/mcpjamAgent";
import { createChatConfig } from "@/lib/utils/request/utils";
import Chat from "./Chat";

interface ChatTabProps {
  mcpAgent: MCPJamAgent | null;
  updateTrigger?: number;
}

const ChatTab: React.FC<ChatTabProps> = ({ mcpAgent, updateTrigger }) => {
  const config = createChatConfig({
    subtitle: "LLM Playground with access to tools from all connected servers",
    additionalSuggestions: ["What tools do you have access to?"],
  });

  const getServersCount = (): number => {
    if (!mcpAgent) return 0;
    try {
      const connectionInfo = mcpAgent.getAllConnectionInfo();
      return connectionInfo.filter(
        (conn) => conn.connectionStatus === "connected",
      ).length;
    } catch {
      return 0;
    }
  };

  if (!mcpAgent) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">No MCP Agent Available</h2>
          <p className="text-muted-foreground">
            Please connect to a server to use chat.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Chat
      provider={mcpAgent}
      config={config}
      getServersCount={getServersCount}
      updateTrigger={updateTrigger}
    />
  );
};

export default ChatTab;
