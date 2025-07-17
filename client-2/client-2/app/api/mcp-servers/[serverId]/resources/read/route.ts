import { NextRequest, NextResponse } from "next/server";
import { MCPClient } from "@mastra/mcp";

// Store MCP client instances
const mcpClients: Record<string, MCPClient> = {};

export async function POST(
  request: NextRequest,
  { params }: { params: { serverId: string } }
) {
  const serverId = params.serverId;
  const { uri } = await request.json();
  
  if (!mcpClients[serverId]) {
    return NextResponse.json(
      { error: "Not connected to server" },
      { status: 404 }
    );
  }
  
  if (!uri) {
    return NextResponse.json(
      { error: "Resource URI is required" },
      { status: 400 }
    );
  }
  
  try {
    // Read the resource content
    const resourceContent = await mcpClients[serverId].resources.read(uri);
    
    return NextResponse.json({
      uri,
      content: resourceContent
    });
  } catch (error) {
    console.error(`Failed to read resource ${uri}:`, error);
    return NextResponse.json(
      { 
        error: `Failed to read resource ${uri}`,
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}