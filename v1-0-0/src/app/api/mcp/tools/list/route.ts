import { NextRequest, NextResponse } from "next/server";
import {
  validateServerConfig,
  createMCPClient,
  createErrorResponse,
} from "@/lib/mcp-utils";
import type { Tool } from "@mastra/core/tools";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export async function POST(request: NextRequest) {
  try {
    const { serverConfig } = await request.json();

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      return validation.error!;
    }

    const client = createMCPClient(
      validation.config!,
      `tools-list-${Date.now()}`,
    );

    try {
      const tools: Record<string, Tool> = await client.getTools();

      // Convert from Zod to JSON Schema
      const toolsWithJsonSchema: Record<string, any> = Object.fromEntries(
        Object.entries(tools).map(([toolName, tool]) => [
          toolName,
          {
            ...tool,
            inputSchema: zodToJsonSchema(tool.inputSchema as unknown as z.ZodType<any>),
          },
        ])
      );

      // Cleanup
      await client.disconnect();

      return NextResponse.json({ tools: toolsWithJsonSchema });
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
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
