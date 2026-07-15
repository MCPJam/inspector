import { describe, it, expect, vi } from "vitest";
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import {
  buildMcpjamTool,
  isMcpjamToolId,
  MCPJAM_TOOL_IDS,
} from "../built-in-tools/mcpjam";

// The workspace tools ARE the shared platform operations, executed against a
// PlatformApiClient. Build a real client over a stubbed fetch and exercise
// the tools exactly as the AI SDK would call them — resolution flows
// (project default, server by name) included.

const BASE_URL = "http://self.test/api/v1";

type RecordedCall = {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
};

type RouteHandler = (call: RecordedCall) => { status?: number; json: unknown };

function makeClient(routes: Record<string, RouteHandler>) {
  const calls: RecordedCall[] = [];
  const stubFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const call: RecordedCall = {
      method: request.method,
      path: url.pathname + url.search,
      auth: request.headers.get("authorization"),
      body: request.method === "POST" ? await request.json() : undefined,
    };
    calls.push(call);
    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) {
      throw new Error(`unexpected request ${request.method} ${url.pathname}`);
    }
    const { status = 200, json } = handler(call);
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
// callers. The chat's ambient project is proj_1, so any test that sees
// proj_1 used on an omitted `project` proves the in-app default overrode the
// catalog's "most recent" default.
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

const toolOpts = { projectId: "proj_1" };

function execTool(
  builtTool: NonNullable<ReturnType<typeof buildMcpjamTool>>,
  input: Record<string, unknown>,
  abortSignal?: AbortSignal
) {
  return (builtTool as any).execute(input, {
    toolCallId: "call_1",
    abortSignal,
    messages: [],
  });
}

describe("workspace tool catalog", () => {
  it("pins the operation names the backend catalog rows must mirror", () => {
    expect([...MCPJAM_TOOL_IDS]).toEqual([
      "list_projects",
      "list_project_servers",
      "diagnose_server",
      "list_server_tools",
      "call_server_tool",
      "list_server_prompts",
      "get_server_prompt",
      "list_server_resources",
      "read_server_resource",
      "list_eval_suites",
      "list_eval_suite_runs",
      "run_eval_case",
      "run_eval_suite",
      "get_eval_run",
      "list_eval_run_iterations",
      "get_eval_iteration_trace",
      "get_eval_run_steps",
      "cancel_eval_run",
      "list_chatboxes",
      "get_chatbox",
      "list_chat_sessions",
    ]);
    for (const id of MCPJAM_TOOL_IDS) expect(isMcpjamToolId(id)).toBe(true);
    expect(isMcpjamToolId("web_search")).toBe(false);
    expect(isMcpjamToolId("show_servers")).toBe(false);
  });

  it("returns null for ids outside the workspace set", () => {
    const { client } = makeClient({});
    expect(buildMcpjamTool("web_search", { ...toolOpts, client })).toBeNull();
  });
});

describe("ambient project scoping", () => {
  it("defaults an omitted project to the chat's project, not the most recent", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/projects": () => ({ json: PROJECTS_PAGE }),
      "GET /api/v1/projects/proj_1/servers": () => ({ json: SERVERS_PAGE }),
    });
    const builtTool = buildMcpjamTool("list_project_servers", {
      ...toolOpts,
      client,
    })!;

    const result = (await execTool(builtTool, {})) as {
      project: { id: string };
    };

    expect(result.project.id).toBe("proj_1");
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/projects",
      "/api/v1/projects/proj_1/servers",
    ]);
    expect(calls[0]!.auth).toBe("Bearer user-token");
  });

  it("lets an explicit project selector roam to another project", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/projects": () => ({ json: PROJECTS_PAGE }),
      "GET /api/v1/projects/proj_2/servers": () => ({ json: { items: [] } }),
    });
    const builtTool = buildMcpjamTool("list_project_servers", {
      ...toolOpts,
      client,
    })!;

    const result = (await execTool(builtTool, {
      project: "Other Project",
    })) as { project: { id: string } };

    expect(result.project.id).toBe("proj_2");
    expect(calls[1]!.path).toBe("/api/v1/projects/proj_2/servers");
  });
});

describe("live server operations", () => {
  it("call_server_tool resolves the server by name and posts the call body", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/projects": () => ({ json: PROJECTS_PAGE }),
      "GET /api/v1/projects/proj_1/servers": () => ({ json: SERVERS_PAGE }),
      "POST /api/v1/projects/proj_1/servers/srv_1/tools/call": () => ({
        json: { content: [{ type: "text", text: "created" }] },
      }),
    });
    const builtTool = buildMcpjamTool("call_server_tool", {
      ...toolOpts,
      client,
    })!;

    const result = (await execTool(builtTool, {
      server: "linear",
      toolName: "create_issue",
      parameters: { title: "Bug" },
    })) as { server: { id: string }; result: unknown };

    expect(result.server.id).toBe("srv_1");
    expect(result.result).toEqual({
      content: [{ type: "text", text: "created" }],
    });
    const callRequest = calls.find((call) => call.method === "POST")!;
    expect(callRequest.body).toEqual({
      toolName: "create_issue",
      parameters: { title: "Bug" },
    });
  });

  it("fails deterministically for stdio servers instead of a connect error", async () => {
    const { client, calls } = makeClient({
      "GET /api/v1/projects": () => ({ json: PROJECTS_PAGE }),
      "GET /api/v1/projects/proj_1/servers": () => ({ json: SERVERS_PAGE }),
    });
    const builtTool = buildMcpjamTool("diagnose_server", {
      ...toolOpts,
      client,
    })!;

    const result = (await execTool(builtTool, {
      server: "Local stdio",
    })) as { error: string };

    expect(result.error).toMatch(/stdio servers are not supported/);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("maps platform error envelopes to { error: message }", async () => {
    const { client } = makeClient({
      "GET /api/v1/projects": () => ({
        status: 403,
        json: {
          code: "FORBIDDEN",
          message: "API key is not scoped to this organization",
        },
      }),
    });
    const builtTool = buildMcpjamTool("list_server_tools", {
      ...toolOpts,
      client,
    })!;

    expect(await execTool(builtTool, { server: "Linear" })).toEqual({
      error: "API key is not scoped to this organization",
    });
  });

  it("pre-checks abort and never dispatches", async () => {
    const fetchSpy = vi.fn();
    const client = new PlatformApiClient({
      baseUrl: BASE_URL,
      getAuth: () => "user-token",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const builtTool = buildMcpjamTool("call_server_tool", {
      ...toolOpts,
      client,
    })!;
    const controller = new AbortController();
    controller.abort();

    const result = await execTool(
      builtTool,
      { server: "Linear", toolName: "ping" },
      controller.signal
    );

    expect(result).toEqual({
      error: "Call MCPJam server tool was cancelled.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("caps oversized results to a truncated preview", async () => {
    const { client } = makeClient({
      "GET /api/v1/projects": () => ({ json: PROJECTS_PAGE }),
      "GET /api/v1/projects/proj_1/servers": () => ({ json: SERVERS_PAGE }),
      "POST /api/v1/projects/proj_1/servers/srv_1/resources/read": () => ({
        json: { contents: ["x".repeat(50_000)] },
      }),
    });
    const builtTool = buildMcpjamTool("read_server_resource", {
      ...toolOpts,
      client,
    })!;

    const result = (await execTool(builtTool, {
      server: "Linear",
      uri: "file:///big",
    })) as { truncated?: boolean; preview?: string };

    expect(result.truncated).toBe(true);
    expect(result.preview).toContain("…[truncated");
    expect(result.preview!.length).toBeLessThan(25_000);
  });

  it("honors requireToolApproval on connection-opening ops only", () => {
    const { client } = makeClient({});
    const approval = (id: string) =>
      (
        buildMcpjamTool(id, {
          ...toolOpts,
          client,
          requireToolApproval: true,
        }) as { needsApproval?: boolean }
      ).needsApproval;

    expect(approval("call_server_tool")).toBe(true);
    expect(approval("diagnose_server")).toBe(true);
    expect(approval("read_server_resource")).toBe(true);
    expect(approval("list_project_servers")).toBe(false);
  });
});
