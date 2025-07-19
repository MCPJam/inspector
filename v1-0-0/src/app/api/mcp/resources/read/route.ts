import { NextRequest, NextResponse } from "next/server";
import { validateServerConfig, createMCPClient, createErrorResponse } from "@/lib/mcp-utils";

export async function POST(request: NextRequest) {
  try {
    const { serverConfig, uri } = await request.json();

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      return validation.error!;
    }

    if (!uri) {
      return NextResponse.json(
        { error: "Resource URI is required" },
        { status: 400 }
      );
    }

    const client = createMCPClient(validation.config!, `resources-read-${Date.now()}`);

    try {
      const content = await client.resources.read("server", uri);
      
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
    console.error("Error reading resource:", error);
    return createErrorResponse(
      "Failed to read resource",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}
