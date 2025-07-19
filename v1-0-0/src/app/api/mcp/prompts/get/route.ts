import { NextRequest, NextResponse } from "next/server";
import { validateServerConfig, createMCPClient, createErrorResponse } from "@/lib/mcp-utils";

export async function POST(request: NextRequest) {
  try {
    const { serverConfig, name, args } = await request.json();

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      return validation.error!;
    }

    if (!name) {
      return NextResponse.json(
        { error: "Prompt name is required" },
        { status: 400 }
      );
    }

    const client = createMCPClient(validation.config!, `prompts-get-${Date.now()}`);

    try {
      const content = await client.prompts.get({
        serverName: "server",
        name,
        args: args || {},
      });
      
      // Cleanup
      await client.disconnect();

      return NextResponse.json({ content });
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
    console.error("Error getting prompt:", error);
    return createErrorResponse(
      "Failed to get prompt",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}
