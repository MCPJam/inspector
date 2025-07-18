import { NextRequest, NextResponse } from "next/server";
import { validateServerConfig, createMCPClient, createErrorResponse } from "@/lib/mcp-utils";

export async function POST(request: NextRequest) {
  try {
    const { serverConfig } = await request.json();

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      return validation.error!;
    }

    const client = createMCPClient(validation.config!, `tools-list-${Date.now()}`);

    try {
      const tools = await client.getTools();
      
      // Cleanup
      await client.disconnect();

      return NextResponse.json({ tools });
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
    console.error("Error fetching tools:", error);
    return createErrorResponse(
      "Failed to fetch tools",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}
