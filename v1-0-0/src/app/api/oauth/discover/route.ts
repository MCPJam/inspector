import { NextRequest, NextResponse } from "next/server";
import { discoverMCPOAuth } from "@/lib/oauth-discovery";
import { createErrorResponse } from "@/lib/mcp-utils";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { serverUrl, options = {} } = body;

    if (!serverUrl) {
      return NextResponse.json(
        { error: "serverUrl is required" },
        { status: 400 },
      );
    }

    // Validate URL format
    try {
      new URL(serverUrl);
    } catch (error) {
      return NextResponse.json(
        { error: `Invalid server URL format: ${error}` },
        { status: 400 },
      );
    }

    // Perform OAuth discovery
    const discoveryResult = await discoverMCPOAuth(serverUrl, {
      timeout: options.timeout || 10000,
      ...options,
    });
    if (discoveryResult.error) {
      return NextResponse.json(
        {
          success: false,
          error: discoveryResult.error.error,
          error_description: discoveryResult.error.error_description,
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      authorization_server_metadata:
        discoveryResult.authorization_server?.authorization_server_metadata,
      protected_resource_metadata:
        discoveryResult.protected_resource?.protected_resource_metadata,
      discovered_at: Date.now(),
    });
  } catch (error) {
    console.error("OAuth discovery error:", error);
    return createErrorResponse(
      "OAuth discovery failed",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
