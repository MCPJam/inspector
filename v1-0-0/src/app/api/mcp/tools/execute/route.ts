import { NextRequest, NextResponse } from "next/server";
import { validateServerConfig, createMCPClient } from "@/lib/mcp-utils";

export async function POST(request: NextRequest) {
  try {
    const { serverConfig, toolName, parameters } = await request.json();

    const validation = validateServerConfig(serverConfig);
    if (!validation.success) {
      return validation.error!;
    }

    if (!toolName) {
      return NextResponse.json(
        { error: "Tool name is required" },
        { status: 400 },
      );
    }

    const client = createMCPClient(validation.config!, `tools-${Date.now()}`);

    try {
      const tools = await client.getTools();
      const tool = tools[toolName];

      if (!tool) {
        return NextResponse.json({ error: "Tool not found" }, { status: 404 });
      }

      const toolArgs =
        parameters && typeof parameters === "object" ? parameters : {};
      const result = await tool.execute({
        context: toolArgs,
      });

      // Cleanup
      await client.disconnect();

      return NextResponse.json({ result });
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
    console.error("Error executing tool:", error);
    return NextResponse.json(
      {
        error: `Failed to execute tool: ${error}`,
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
