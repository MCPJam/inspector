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
      const tools = await client.getTools(); // TODO: Remove tool count

      // Cleanup
      await client.disconnect();

      return NextResponse.json({
        success: true,
        toolCount: Object.keys(tools).length,
      });
    } catch (error) {
      // Cleanup on error
      try {
        await client.disconnect();
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  } catch (error) {
    console.error("Connection test error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to connect to MCP server",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
