import { NextRequest, NextResponse } from "next/server";
import { ServerConfig } from "@/app/types/mcp";

// This would normally be stored in a database
let serverConfigurations: Record<string, ServerConfig> = {};

export async function GET() {
  return NextResponse.json(serverConfigurations);
}

export async function POST(request: NextRequest) {
  const serverConfig: ServerConfig = await request.json();
  
  if (!serverConfig.name) {
    return NextResponse.json(
      { error: "Server name is required" },
      { status: 400 }
    );
  }

  const id = generateServerId(serverConfig.name);
  serverConfigurations[id] = serverConfig;

  return NextResponse.json({ id, ...serverConfig });
}

// Helper function to generate a server ID from a name
function generateServerId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .trim() + 
    '-' + 
    Date.now().toString().slice(-6);
}