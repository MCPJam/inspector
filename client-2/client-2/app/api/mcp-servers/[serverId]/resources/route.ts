import { NextRequest, NextResponse } from "next/server";
import { MCPClient } from "@mastra/mcp";

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
    // Get resources from the MCP client
    const resources = await mcpClients[serverId].resources.list();
    
    // Return the resources for this server
    return NextResponse.json(resources[serverId] || []);
  } catch (error) {
    console.error("Failed to get resources:", error);
    return NextResponse.json(
      { 
        error: "Failed to get resources from MCP server",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}