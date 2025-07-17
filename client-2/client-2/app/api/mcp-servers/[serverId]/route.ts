import { NextRequest, NextResponse } from "next/server";
import { ServerConfig } from "@/app/types/mcp";

// This would normally be stored in a database
let serverConfigurations: Record<string, ServerConfig> = {};

// Mock function to simulate active connection status
const activeConnections: Record<string, boolean> = {};

export async function GET(
  request: NextRequest,
  { params }: { params: { serverId: string } }
) {
  const serverId = params.serverId;
  
  if (!serverConfigurations[serverId]) {
    return NextResponse.json(
      { error: "Server not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    id: serverId,
    ...serverConfigurations[serverId],
    isConnected: !!activeConnections[serverId]
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { serverId: string } }
) {
  const serverId = params.serverId;
  const updatedConfig: ServerConfig = await request.json();
  
  if (!serverConfigurations[serverId]) {
    return NextResponse.json(
      { error: "Server not found" },
      { status: 404 }
    );
  }

  serverConfigurations[serverId] = {
    ...updatedConfig,
    name: updatedConfig.name || serverConfigurations[serverId].name
  };

  return NextResponse.json({
    id: serverId,
    ...serverConfigurations[serverId]
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { serverId: string } }
) {
  const serverId = params.serverId;
  
  if (!serverConfigurations[serverId]) {
    return NextResponse.json(
      { error: "Server not found" },
      { status: 404 }
    );
  }

  // If connected, disconnect first
  if (activeConnections[serverId]) {
    delete activeConnections[serverId];
  }

  const deletedConfig = serverConfigurations[serverId];
  delete serverConfigurations[serverId];

  return NextResponse.json({
    id: serverId,
    ...deletedConfig,
    deleted: true
  });
}