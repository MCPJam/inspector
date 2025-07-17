import { NextRequest, NextResponse } from "next/server";
import { MCPClient } from "@mastra/mcp";

// Store MCP client instances
const mcpClients: Record<string, MCPClient> = {};

export async function POST(
  request: NextRequest,
  { params }: { params: { serverId: string } }
) {
  const serverId = params.serverId;
  const { name, args } = await request.json();
  
  if (!mcpClients[serverId]) {
    return NextResponse.json(
      { error: "Not connected to server" },
      { status: 404 }
    );
  }
  
  if (!name) {
    return NextResponse.json(
      { error: "Prompt name is required" },
      { status: 400 }
    );
  }
  
  try {
    // Get the prompt content
    const promptContent = await mcpClients[serverId].prompts.get(name, args || {});
    
    return NextResponse.json({
      name,
      content: promptContent
    });
  } catch (error) {
    console.error(`Failed to get prompt ${name}:`, error);
    return NextResponse.json(
      { 
        error: `Failed to get prompt ${name}`,
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}