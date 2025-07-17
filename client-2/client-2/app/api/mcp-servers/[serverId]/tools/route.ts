import { NextRequest, NextResponse } from "next/server";
import { MCPClient } from "@mastra/mcp";
import { ServerConfig } from "@/app/types/mcp";

// This would normally be stored in a database
let serverConfigurations: Record<string, ServerConfig> = {};

// Store MCP client instances
const mcpClients: Record<string, MCPClient> = {};

export async function GET(
  request: NextRequest,
  { params }: { params: { serverId: string } }
) {
  const serverId = params.serverId;
  
  if (!mcpClients[serverId]) {
    return NextResponse.json(
      { error: "Not connected to server" },
      { status: 404 }
    );
  }
  
  try {
    // Get tools from the MCP client
    const tools = await mcpClients[serverId].getTools();
    
    // Format tools for response
    const formattedTools = Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
    
    return NextResponse.json(formattedTools);
  } catch (error) {
    console.error("Failed to get tools:", error);
    return NextResponse.json(
      { 
        error: "Failed to get tools from MCP server",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}