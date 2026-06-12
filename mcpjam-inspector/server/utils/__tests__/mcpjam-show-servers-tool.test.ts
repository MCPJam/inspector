import { describe, it, expect } from "vitest";
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import {
  buildShowServersWidgetTool,
  SHOW_SERVERS_TOOL_NAME,
} from "../built-in-tools/mcpjam-show-servers";
import { isMcpjamToolId } from "../built-in-tools/mcpjam";
import {
  MCPJAM_PLATFORM_SERVER_ID,
  SHOW_SERVERS_RESOURCE_URI,
} from "../../../shared/mcpjam-agent-widgets";
import {
  PLATFORM_WIDGET_RESOURCE_URIS,
  tagPlatformWidgetPayload,
} from "../../../../mcp/src/shared/platform-widgets";

// Same harness as mcpjam-built-in-tools.test.ts: a real PlatformApiClient
// over a stubbed fetch, exercised exactly as the AI SDK would call the tool.

const BASE_URL = "http://self.test/api/v1";

type RecordedCall = { method: string; path: string };
type RouteHandler = () => { status?: number; json: unknown };

function makeClient(routes: Record<string, RouteHandler>) {
  const calls: RecordedCall[] = [];
  const stubFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname });
    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) {
      throw new Error(`unexpected request ${request.method} ${url.pathname}`);
    }
    const { status = 200, json } = handler();
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new PlatformApiClient({
    baseUrl: BASE_URL,
    getAuth: () => "user-token",
    fetch: stubFetch,
  });
  return { client, calls };
}

// proj_2 is the most recently updated — the catalog default for context-free
// callers. The chat's ambient project is proj_1, so proj_1 being used on an
// omitted `project` proves the in-app default overrode "most recent".
const PROJECTS_PAGE = {
  items: [
    {
      id: "proj_1",
      name: "Chat Project",
      description: null,
      icon: null,
      organizationId: "org_1",
      visibility: "private",
      createdAt: 1,
      updatedAt: 100,
    },
    {
      id: "proj_2",
      name: "Other Project",
      description: null,
      icon: null,
      organizationId: "org_1",
      visibility: "private",
      createdAt: 2,
      updatedAt: 200,
    },
  ],
};

const SERVERS_PAGE = {
  items: [
    {
      id: "srv_1",
      projectId: "proj_1",
      name: "Linear",
      enabled: true,
      transportType: "http",
      url: "https://mcp.linear.app/mcp",
      useOAuth: true,
      hasClientSecret: false,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "srv_2",
      projectId: "proj_1",
      name: "Local stdio",
      enabled: true,
      transportType: "stdio",
      url: null,
      useOAuth: false,
      hasClientSecret: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

function execTool(
  builtTool: ReturnType<typeof buildShowServersWidgetTool>,
  input: Record<string, unknown>
) {
  return (builtTool as any).execute(input, {
    toolCallId: "call_1",
    messages: [],
  });
}

describe("show_servers widget built-in", () => {
  it("stays in lockstep with the platform widget bundle contract", () => {
    expect(SHOW_SERVERS_TOOL_NAME).toBe("show_servers");
    expect(SHOW_SERVERS_RESOURCE_URI).toBe(
      PLATFORM_WIDGET_RESOURCE_URIS.servers
    );
    expect(tagPlatformWidgetPayload("servers", {})).toEqual({
      widget: "servers",
    });
    // The widget tool must NOT also be a plain workspace catalog id — the
    // registry would otherwise build it twice.
    expect(isMcpjamToolId(SHOW_SERVERS_TOOL_NAME)).toBe(false);
  });

  it("returns a CallToolResult-shaped output with MCP Apps render metadata", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/projects": () => ({ json: PROJECTS_PAGE }),
      "GET /api/v1/projects/proj_1/servers": () => ({ json: SERVERS_PAGE }),
      "POST /api/v1/projects/proj_1/servers/srv_1/doctor": () => ({
        json: { status: "oauth_required" },
      }),
    });
    const builtTool = buildShowServersWidgetTool({
      client,
      projectId: "proj_1",
    });

    const result = await execTool(builtTool, {});

    // Ambient project default: omitted `project` resolves to the chat's
    // project, not the most-recently-updated catalog default (proj_2).
    expect(calls.map((c) => c.path)).toContain(
      "/api/v1/projects/proj_1/servers"
    );

    // Render metadata the client detects from the streamed result alone:
    // modern + legacy resourceUri meta keys, and the synthetic server id
    // that routes the HTML fetch to the agent's companion endpoint.
    expect(result._meta).toEqual({
      ui: { resourceUri: SHOW_SERVERS_RESOURCE_URI },
      "ui/resourceUri": SHOW_SERVERS_RESOURCE_URI,
    });
    expect(result._serverId).toBe(MCPJAM_PLATFORM_SERVER_ID);

    // The payload the widget renders, tagged with the bundle's view
    // discriminator.
    expect(result.structuredContent.widget).toBe("servers");
    expect(result.structuredContent.project).toMatchObject({
      id: "proj_1",
      name: "Chat Project",
    });
    expect(result.structuredContent.servers).toHaveLength(2);
    const statuses = Object.fromEntries(
      result.structuredContent.servers.map(
        (server: { id: string; status: string }) => [server.id, server.status]
      )
    );
    expect(statuses).toEqual({ srv_1: "reachable", srv_2: "skipped" });

    // Text summary for model context.
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("2 servers") },
    ]);
    expect(result.content[0].text).toContain("Chat Project");
  });

  it("respects an explicit project selector", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/projects": () => ({ json: PROJECTS_PAGE }),
      "GET /api/v1/projects/proj_2/servers": () => ({ json: { items: [] } }),
    });
    const builtTool = buildShowServersWidgetTool({
      client,
      projectId: "proj_1",
    });

    const result = await execTool(builtTool, { project: "Other Project" });

    expect(calls.map((c) => c.path)).toContain(
      "/api/v1/projects/proj_2/servers"
    );
    expect(result.structuredContent.project.id).toBe("proj_2");
    expect(result.structuredContent.servers).toEqual([]);
  });

  it("degrades to the { error } envelope so the model can relay failures", async () => {
    const { client } = makeClient({
      "GET /api/v1/projects": () => ({
        status: 500,
        json: { error: { message: "platform exploded" } },
      }),
    });
    const builtTool = buildShowServersWidgetTool({
      client,
      projectId: "proj_1",
    });

    const result = await execTool(builtTool, {});

    expect(result.error).toBeTruthy();
    // No render metadata on errors — the part falls back to the plain row.
    expect(result._meta).toBeUndefined();
    expect(result._serverId).toBeUndefined();
  });
});
