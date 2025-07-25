import { NextRequest, NextResponse } from "next/server";
import { validateServerConfig, createMCPClient } from "@/lib/mcp-utils";

export async function POST(request: NextRequest) {
  const { serverConfig } = await request.json();

  const validation = validateServerConfig(serverConfig);
  if (!validation.success) {
    return validation.error!;
  }

  let client;
  try {
    client = createMCPClient(validation.config!, `test-${Date.now()}`);
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: `Failed to create a MCP client. Please double check your server configuration: ${JSON.stringify(serverConfig)}`,
        details: error instanceof Error ? error.message : "Unknown error",
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
        error: `Failed to create a MCP client. Please double check your server configuration: ${JSON.stringify(serverConfig)}`,
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
