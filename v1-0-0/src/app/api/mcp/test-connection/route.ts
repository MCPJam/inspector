import { NextRequest, NextResponse } from "next/server";
import { validateServerConfig, createMCPClient } from "@/lib/mcp-utils";

export async function POST(request: NextRequest) {
  try {
    const { serverConfig } = await request.json();

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      return validation.error!;
    }

    let client;
    try {
      client = createMCPClient(validation.config!, `test-${Date.now()}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return NextResponse.json(
        {
          success: false,
          error: `Failed to create MCP client: ${errorMessage}`,
          details: errorMessage,
        },
        { status: 500 },
      );
    }

    try {
      await client.getTools();
      await client.disconnect();
      return NextResponse.json({
        success: true,
      });
    } catch (error) {
      return NextResponse.json(
        {
          success: false,
          error: `Failed to connect to MCP server: ${error}`,
          details: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("Connection test error:", error);
    return NextResponse.json(
      {
        success: false,
        error: `Failed to connect to MCP server ${error}`,
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
