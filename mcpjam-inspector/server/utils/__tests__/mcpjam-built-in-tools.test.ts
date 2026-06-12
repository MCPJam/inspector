import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildMcpjamTool,
  MCPJAM_TOOL_IDS,
  isMcpjamToolId,
  type McpjamLiveOps,
} from "../built-in-tools/mcpjam";

// mcpjam_list_servers goes through global fetch (CONVEX_HTTP_URL); the live
// ops go through an injectable McpjamLiveOps runner. Stub both and exercise
// the tools exactly as the AI SDK would call them.

const CONVEX_URL = "https://convex.example";

const toolOpts = {
  authHeader: "Bearer user-token",
  projectId: "proj_1",
};

function stubLiveOps(overrides: Partial<McpjamLiveOps> = {}): McpjamLiveOps {
  return {
    diagnoseServer: vi.fn(async () => ({ status: "healthy" })),
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(async () => ({ content: [] })),
    listPrompts: vi.fn(async () => ({ prompts: [] })),
    getPrompt: vi.fn(async () => ({ messages: [] })),
    listResources: vi.fn(async () => ({ resources: [] })),
    readResource: vi.fn(async () => ({ contents: [] })),
    ...overrides,
  };
}

function execTool(
  tool: NonNullable<ReturnType<typeof buildMcpjamTool>>,
  input: Record<string, unknown>,
  abortSignal?: AbortSignal
) {
  return (tool as any).execute(input, {
    toolCallId: "call_1",
    abortSignal,
    messages: [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buildMcpjamTool dispatcher", () => {
  it("builds mcpjam_list_servers without a runner", () => {
    expect(buildMcpjamTool("mcpjam_list_servers", toolOpts)).not.toBeNull();
  });

  it("returns null for every live-op id without a runner", () => {
    for (const id of MCPJAM_TOOL_IDS) {
      if (id === "mcpjam_list_servers") continue;
      expect(buildMcpjamTool(id, toolOpts)).toBeNull();
    }
  });

  it("isMcpjamToolId accepts the catalog ids and rejects others", () => {
    for (const id of MCPJAM_TOOL_IDS) expect(isMcpjamToolId(id)).toBe(true);
    expect(isMcpjamToolId("web_search")).toBe(false);
    expect(isMcpjamToolId("mcpjam_nope")).toBe(false);
  });
});

describe("mcpjam_list_servers", () => {
  let fetchCalls: { url: string; headers: Record<string, string> }[];

  function installFetchStub(status: number, json: unknown) {
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return new Response(JSON.stringify(json), {
          status,
          headers: { "content-type": "application/json" },
        });
      })
    );
  }

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX_URL);
  });

  it("passes the Convex page envelope through on 200", async () => {
    const page = {
      items: [{ id: "srv_1", name: "Linear", url: "https://mcp.linear.app" }],
    };
    installFetchStub(200, page);
    const tool = buildMcpjamTool("mcpjam_list_servers", toolOpts)!;

    const result = await execTool(tool, {});

    expect(result).toEqual(page);
    const call = fetchCalls[0];
    expect(call.url).toBe(
      `${CONVEX_URL}/v1/project-servers?projectId=proj_1`
    );
    expect(call.headers.Authorization).toBe("Bearer user-token");
  });

  it("surfaces the upstream v1 error message on non-OK", async () => {
    installFetchStub(403, {
      code: "FORBIDDEN",
      message: "API key is not scoped to this organization",
    });
    const tool = buildMcpjamTool("mcpjam_list_servers", toolOpts)!;

    expect(await execTool(tool, {})).toEqual({
      error: "API key is not scoped to this organization",
    });
  });

  it("falls back to a status message when the error body is opaque", async () => {
    installFetchStub(500, "not-json-shaped");
    const tool = buildMcpjamTool("mcpjam_list_servers", toolOpts)!;

    expect(await execTool(tool, {})).toEqual({
      error: "Listing project servers failed (500).",
    });
  });

  it("returns { error } when CONVEX_HTTP_URL is missing", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "");
    const tool = buildMcpjamTool("mcpjam_list_servers", toolOpts)!;

    expect(await execTool(tool, {})).toEqual({
      error: "MCPJam workspace tools are not configured.",
    });
  });
});

describe("mcpjam live ops", () => {
  it("mcpjam_call_tool forwards serverId/toolName/parameters to the runner", async () => {
    const liveOps = stubLiveOps({
      callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    });
    const tool = buildMcpjamTool("mcpjam_call_tool", { ...toolOpts, liveOps })!;

    const result = await execTool(tool, {
      serverId: "srv_1",
      toolName: "create_issue",
      parameters: { title: "Bug" },
    });

    expect(liveOps.callTool).toHaveBeenCalledWith(
      "srv_1",
      "create_issue",
      { title: "Bug" },
      undefined
    );
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("mcpjam_call_tool defaults omitted parameters to {}", async () => {
    const liveOps = stubLiveOps();
    const tool = buildMcpjamTool("mcpjam_call_tool", { ...toolOpts, liveOps })!;

    await execTool(tool, { serverId: "srv_1", toolName: "ping" });

    expect(liveOps.callTool).toHaveBeenCalledWith(
      "srv_1",
      "ping",
      {},
      undefined
    );
  });

  it("maps a runner throw to { error: message } instead of breaking the turn", async () => {
    const liveOps = stubLiveOps({
      callTool: vi.fn(async () => {
        throw new Error("Server not found");
      }),
    });
    const tool = buildMcpjamTool("mcpjam_call_tool", { ...toolOpts, liveOps })!;

    expect(
      await execTool(tool, { serverId: "srv_x", toolName: "ping" })
    ).toEqual({ error: "Server not found" });
  });

  it("uses the per-tool fallback message when the throw has no message", async () => {
    const liveOps = stubLiveOps({
      diagnoseServer: vi.fn(async () => {
        throw new Error("");
      }),
    });
    const tool = buildMcpjamTool("mcpjam_diagnose_server", {
      ...toolOpts,
      liveOps,
    })!;

    expect(await execTool(tool, { serverId: "srv_1" })).toEqual({
      error: "Failed to diagnose the server.",
    });
  });

  it("pre-checks abort and never dispatches to the runner", async () => {
    const liveOps = stubLiveOps();
    const tool = buildMcpjamTool("mcpjam_call_tool", { ...toolOpts, liveOps })!;
    const controller = new AbortController();
    controller.abort();

    const result = await execTool(
      tool,
      { serverId: "srv_1", toolName: "ping" },
      controller.signal
    );

    expect(result).toEqual({ error: "Tool execution was cancelled." });
    expect(liveOps.callTool).not.toHaveBeenCalled();
  });

  it("mcpjam_get_prompt forwards promptName and arguments", async () => {
    const liveOps = stubLiveOps();
    const tool = buildMcpjamTool("mcpjam_get_prompt", { ...toolOpts, liveOps })!;

    await execTool(tool, {
      serverId: "srv_1",
      promptName: "summarize",
      arguments: { style: "brief", limit: 3 },
    });

    expect(liveOps.getPrompt).toHaveBeenCalledWith(
      "srv_1",
      "summarize",
      { style: "brief", limit: 3 },
      undefined
    );
  });

  it("caps oversized results to a truncated preview", async () => {
    const liveOps = stubLiveOps({
      readResource: vi.fn(async () => ({ contents: "x".repeat(50_000) })),
    });
    const tool = buildMcpjamTool("mcpjam_read_resource", {
      ...toolOpts,
      liveOps,
    })!;

    const result = (await execTool(tool, {
      serverId: "srv_1",
      uri: "file:///big",
    })) as { truncated?: boolean; preview?: string };

    expect(result.truncated).toBe(true);
    expect(result.preview).toContain("…[truncated");
    expect(result.preview!.length).toBeLessThan(25_000);
  });
});
