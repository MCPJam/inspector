import { NextRequest, NextResponse } from "next/server";
import { validateServerConfig, createMCPClient } from "@/lib/mcp-utils";

export async function POST(request: NextRequest) {
  try {
    const { serverConfig } = await request.json();

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      return validation.error!;
    }

    const client = createMCPClient(validation.config!, `test-${Date.now()}`);

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
          error: `Failed to connect to MCP server ${error}`,
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
