import { NextRequest, NextResponse } from "next/server";
import {
  validateServerConfig,
  createMCPClient,
  createErrorResponse,
} from "@/lib/mcp-utils";

export async function POST(request: NextRequest) {
  try {
    const { serverConfig } = await request.json();

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      return validation.error!;
    }

    const client = createMCPClient(
      validation.config!,
      `prompts-list-${Date.now()}`,
    );

    try {
      const prompts = await client.prompts.list();

      // Cleanup
      await client.disconnect();

      return NextResponse.json({ prompts });
    } catch (error) {
      await client.disconnect();
      throw error;
    }
  } catch (error) {
    console.error("Error fetching prompts:", error);
    return createErrorResponse(
      "Failed to fetch prompts",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
