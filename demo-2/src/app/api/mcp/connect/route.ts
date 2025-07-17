import { NextRequest, NextResponse } from "next/server";
import { MCPClient } from "@mastra/mcp";

// Store for active MCP clients
const clients = new Map<string, MCPClient>();

export async function POST(request: NextRequest) {
  try {
    const { serverName, config } = await request.json();

    if (!serverName || !config) {
      return NextResponse.json(
        { error: "Server name and config are required" },
        { status: 400 },
      );
    }

    // Validate and convert URL if provided
    if (config.url) {
      try {
        // Convert string URL to URL object if needed
        if (typeof config.url === "string") {
          config.url = new URL(config.url);
        } else if (typeof config.url === "object" && !config.url.href) {
          return NextResponse.json(
            { error: "Invalid URL configuration" },
            { status: 400 },
          );
        }
        
        // For SSE connections, add eventSourceInit if requestInit has custom headers
        if (config.requestInit?.headers) {
          config.eventSourceInit = {
            fetch(input: Request | URL | string, init?: RequestInit) {
              const headers = new Headers(init?.headers || {});
              
              // Copy headers from requestInit
              const requestHeaders = new Headers(config.requestInit.headers);
              requestHeaders.forEach((value, key) => {
                headers.set(key, value);
              });
              
              return fetch(input, {
                ...init,
                headers,
              });
            },
          };
        }
      } catch (error) {
        return NextResponse.json(
          { error: "Invalid URL format" },
          { status: 400 },
        );
      }
    }
    // Disconnect existing client if it exists
    const existingClient = clients.get(serverName);
    if (existingClient) {
      await existingClient.disconnect();
    }

    // Create new MCP client with unique ID to prevent memory leaks
    const client = new MCPClient({
      id: `${serverName}-${Date.now()}`,
      servers: {
        [serverName]: config,
      },
    });

    // Store the client
    clients.set(serverName, client);
    
    // Test connection by getting tools
    const tools = await client.getTools();
    return NextResponse.json({
      success: true,
      message: `Connected to ${serverName}`,
      serverName,
      toolCount: Object.keys(tools).length,
    });
  } catch (error) {
    console.error("MCP connection error:", error);
    return NextResponse.json(
      {
        error: "Failed to connect to MCP server",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const serverName = searchParams.get("server");

    if (!serverName) {
      return NextResponse.json(
        { error: "Server name is required" },
        { status: 400 },
      );
    }

    const client = clients.get(serverName);
    if (client) {
      await client.disconnect();
      clients.delete(serverName);
    }

    return NextResponse.json({
      success: true,
      message: `Disconnected from ${serverName}`,
    });
  } catch (error) {
    console.error("MCP disconnection error:", error);
    return NextResponse.json(
      { error: "Failed to disconnect from MCP server" },
      { status: 500 },
    );
  }
}

export async function GET() {
  const connectedServers = Array.from(clients.keys());
  return NextResponse.json({ servers: connectedServers });
}

// Export clients for use in other API routes
export { clients };
