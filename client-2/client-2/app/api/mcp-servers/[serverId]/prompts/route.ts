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
    // Get prompts from the MCP client
    const prompts = await mcpClients[serverId].prompts.list();
    
    // Return the prompts for this server
    return NextResponse.json(prompts[serverId] || []);
  } catch (error) {
    console.error("Failed to get prompts:", error);
    return NextResponse.json(
      { 
        error: "Failed to get prompts from MCP server",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}