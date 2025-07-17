import { NextRequest, NextResponse } from "next/server";
import { MCPClient } from "@mastra/mcp";

// Store MCP client instances
const mcpClients: Record<string, MCPClient> = {};

export async function POST(
  request: NextRequest,
  { params }: { params: { serverId: string } }
) {
  const serverId = params.serverId;
  const { toolName, parameters } = await request.json();
  
  if (!mcpClients[serverId]) {
    return NextResponse.json(
      { error: "Not connected to server" },
      { status: 404 }
    );
  }
  
  if (!toolName) {
    return NextResponse.json(
      { error: "Tool name is required" },
      { status: 400 }
    );
  }
  
  try {
    // Get tools from the MCP client
    const tools = await mcpClients[serverId].getTools();
    
    // Find the requested tool
    const tool = tools[toolName];
    
    if (!tool) {
      return NextResponse.json(
        { error: `Tool '${toolName}' not found` },
        { status: 404 }
      );
    }
    
    // Execute the tool with the provided parameters
    const result = await tool.execute(parameters || {});
    
    return NextResponse.json({
      toolName,
      result
    });
  } catch (error) {
    console.error(`Failed to execute tool ${toolName}:`, error);
    return NextResponse.json(
      { 
        error: `Failed to execute tool ${toolName}`,
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}