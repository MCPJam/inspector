import { NextRequest, NextResponse } from "next/server";
import { clients } from "../connect/route";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const serverName = searchParams.get("server");

    if (!serverName) {
      return NextResponse.json(
        { error: "Server name is required" },
        { status: 400 },
      );
    }
    console.log("clients", clients);
    const client = clients.get(serverName);
    if (!client) {
      return NextResponse.json(
        { error: "Server not connected" },
        { status: 404 },
      );
    }
    const tools = await client.getTools();
    return NextResponse.json({ tools });
  } catch (error) {
    console.error("Error fetching tools:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch tools",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { serverName, toolName, parameters } = await request.json();

    if (!serverName || !toolName) {
      return NextResponse.json(
        { error: "Server name and tool name are required" },
        { status: 400 },
      );
    }

    const client = clients.get(serverName);
    if (!client) {
      return NextResponse.json(
        { error: "Server not connected" },
        { status: 404 },
      );
    }

    const tools = await client.getTools();
    const tool = tools[toolName];

    if (!tool) {
      return NextResponse.json({ error: "Tool not found" }, { status: 404 });
    }

    const result = await tool.execute(parameters || {});
    return NextResponse.json({ result });
  } catch (error) {
    console.error("Error executing tool:", error);
    return NextResponse.json(
      {
        error: "Failed to execute tool",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
