import { NextRequest, NextResponse } from "next/server";
import { MCPClient } from "@mastra/mcp";
import { ServerConfig } from "@/app/types/mcp";

// This would normally be stored in a database
let serverConfigurations: Record<string, ServerConfig> = {};

// Store MCP client instances
const mcpClients: Record<string, MCPClient> = {};

export async function POST(
  request: NextRequest,
  { params }: { params: { serverId: string } }
) {
  const serverId = params.serverId;
  
  if (!serverConfigurations[serverId]) {
    return NextResponse.json(
      { error: "Server not found" },
      { status: 404 }
    );
  }
  
  try {
    // If already connected, disconnect first
    if (mcpClients[serverId]) {
      await mcpClients[serverId].disconnect();
    }
    
    // Create a new MCP client based on server configuration
    const serverConfig = serverConfigurations[serverId];
    
    // Create server configuration for Mastra MCP client
    const mcpServerConfig: any = {};
    
    if (serverConfig.type === 'stdio') {
      mcpServerConfig[serverId] = {
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: serverConfig.env || {}
      };
    } else if (serverConfig.type === 'http') {
      mcpServerConfig[serverId] = {
        url: new URL(serverConfig.url),
        requestInit: serverConfig.headers ? {
          headers: serverConfig.headers
        } : undefined
      };
    }
    
    // Create and connect the MCP client
    const client = new MCPClient({
      servers: mcpServerConfig
    });
    
    // await client.connect();
    mcpClients[serverId] = client;
    
    return NextResponse.json({
      id: serverId,
      connected: true,
      message: `Successfully connected to ${serverConfig.name}`
    });
  } catch (error) {
    console.error("Failed to connect:", error);
    return NextResponse.json(
      { 
        error: "Failed to connect to MCP server",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
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
    await mcpClients[serverId].disconnect();
    delete mcpClients[serverId];
    
    return NextResponse.json({
      id: serverId,
      connected: false,
      message: "Successfully disconnected"
    });
  } catch (error) {
    console.error("Failed to disconnect:", error);
    return NextResponse.json(
      { 
        error: "Failed to disconnect from MCP server",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}