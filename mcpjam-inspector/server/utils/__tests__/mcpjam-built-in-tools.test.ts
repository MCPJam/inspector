import { describe, it, expect, vi } from "vitest";
import { ALL_OPERATIONS, PlatformApiClient } from "@mcpjam/sdk/platform";
import {
  buildMcpjamTool,
  EXCLUDED_FROM_WORKSPACE,
  isMcpjamToolId,
  MCPJAM_TOOL_IDS,
  WORKSPACE_INPUT_CLAMPS,
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
      "create_project_server",
      "get_project_server",
      "update_project_server",
      "delete_project_server",
      "connect_project_server",
      "get_project_server_connection_status",
      "diagnose_server",
      "list_server_tools",
      "call_server_tool",
      "list_server_prompts",
      "get_server_prompt",
      "list_server_resources",
      "read_server_resource",
      "start_claude_readiness_run",
      "start_openai_readiness_run",
      "get_readiness_run",
      "list_readiness_runs",
      "cancel_readiness_run",
      "get_readiness_report",
      "start_conformance_run",
      "get_conformance_run",
      "list_conformance_runs",
      "get_conformance_report",
      "list_eval_suites",
      "list_eval_suite_runs",
      "get_eval_run_disclosure",
      "run_eval_case",
      "run_eval_suite",
      "get_eval_run",
      "compare_eval_run",
      "list_eval_run_iterations",
      "get_eval_iteration_trace",
      "get_eval_run_steps",
      "cancel_eval_run",
      "request_eval_run_judge",
      // The GitHub Checks READ. Its connect sibling is in
      // EXCLUDED_FROM_WORKSPACE: it reaches a shared repository.
      "list_eval_check_repos",
      "list_scenarios",
      "get_scenario",
      "list_chat_sessions",
      "search_sessions",
      // Swarms: reads and the REVERSIBLE half of authoring. Launching,
      // generation and the removals stay out — see EXCLUDED_FROM_WORKSPACE for
      // why each one wants the tab's context rather than a chat tool.
      "get_capabilities",
      "list_personas",
      "get_persona",
      "create_persona",
      "update_persona",
      "list_journeys",
      "get_journey",
      "create_journey",
      "update_journey",
      "list_journey_runs",
      "get_journey_run",
      "list_journey_run_sessions",
      "list_swarms",
      "get_swarm",
      "create_swarm",
      "update_swarm",
      "get_swarms_overview",
      "get_journey_run_scorecard",
      "list_swarm_findings",
      "dismiss_swarm_finding",
      "undismiss_swarm_finding",
      "get_wave_insights",
      // User testing: aggregate reads and the judgement calls over them.
      // Session listings, transcripts and every exposure control stay out —
      // see EXCLUDED_FROM_WORKSPACE for which reason applies to which.
      "get_user_testing_metrics",
      "get_user_testing_usage",
      "list_user_testing_findings",
      "get_user_testing_signals",
      "get_user_testing_insights",
      "dismiss_user_testing_finding",
      "undismiss_user_testing_finding",
      "search_registry_directory",
      "get_registry_directory_server",
      "list_registry_directory_sources",
      "list_registry_servers",
      "list_registry_connections",
      "install_registry_directory_server",
      "install_registry_server",
      "uninstall_registry_server",
    ]);
    for (const id of MCPJAM_TOOL_IDS) expect(isMcpjamToolId(id)).toBe(true);
    expect(isMcpjamToolId("web_search")).toBe(false);
    expect(isMcpjamToolId("show_servers")).toBe(false);
  });

  it("returns null for ids outside the workspace set", () => {
    const { client } = makeClient({});
    expect(buildMcpjamTool("web_search", { ...toolOpts, client })).toBeNull();
  });

  describe("exposure partition against the SDK's operation list", () => {
    // The ratchet. Every SDK operation is either advertised in chat or named in
    // EXCLUDED_FROM_WORKSPACE with a reason, so a new operation cannot appear
    // in — or be quietly withheld from — the chat toolset without an edit a
    // reviewer sees. Both directions, so the exclusion list only shrinks except
    // by deliberate change.
    const advertised = new Set<string>(MCPJAM_TOOL_IDS);
    const excluded = new Set(Object.keys(EXCLUDED_FROM_WORKSPACE));

    it("covers every operation exactly once", () => {
      const uncovered = ALL_OPERATIONS.map((op) => op.name)
        .filter((name) => !advertised.has(name) && !excluded.has(name))
        .sort();
      expect(uncovered).toEqual([]);

      const both = [...advertised].filter((name) => excluded.has(name)).sort();
      expect(both).toEqual([]);
    });

    it("has no stale exclusions", () => {
      const known = new Set(ALL_OPERATIONS.map((op) => op.name));
      const stale = [...excluded].filter((name) => !known.has(name)).sort();
      expect(stale).toEqual([]);
    });

    it("gives every exclusion a substantive, non-boilerplate reason", () => {
      for (const [name, reason] of Object.entries(EXCLUDED_FROM_WORKSPACE)) {
        expect(
          reason.length,
          `${name} needs a substantive reason`
        ).toBeGreaterThan(20);
      }
      // One sentence copy-pasted across every entry is a derived map wearing a
      // literal's clothes.
      const reasons = Object.values(EXCLUDED_FROM_WORKSPACE);
      expect(new Set(reasons).size).toBeGreaterThan(reasons.length / 3);
    });
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

describe("workspace input clamps", () => {
  const SESSIONS_PAGE = {
    items: [],
    scope: "titles",
  };

  function searchTool() {
    const { client, calls } = makeClient({
      "GET /api/v1/projects": () => ({ json: PROJECTS_PAGE }),
      "GET /api/v1/projects/proj_1/sessions": () => ({ json: SESSIONS_PAGE }),
    });
    return {
      calls,
      builtTool: buildMcpjamTool("search_sessions", { ...toolOpts, client })!,
    };
  }

  /** The sourceType filter the request actually carried. */
  function sourceTypeParam(path: string): string | null {
    return new URL(path, "http://self.test").searchParams.get("sourceType");
  }

  it("injects the three allowed sources when sourceTypes is omitted", async () => {
    const { builtTool, calls } = searchTool();

    await execTool(builtTool, { query: "refund" });

    const sessionsCall = calls.find((c) => c.path.includes("/sessions"))!;
    expect(sourceTypeParam(sessionsCall.path)).toBe("direct,eval,swarm");
  });

  it("treats an EMPTY sourceTypes array exactly like omission", async () => {
    // Defense in depth. The zod schema's `.min(1)` rejects `[]`, but
    // `execute()` can be called raw with no schema in the way — and `[]`
    // serializes to no filter at all, silently widening the search to every
    // source including scenario. This is the case that must not regress.
    const { builtTool, calls } = searchTool();

    await execTool(builtTool, { query: "refund", sourceTypes: [] });

    const sessionsCall = calls.find((c) => c.path.includes("/sessions"))!;
    expect(sourceTypeParam(sessionsCall.path)).toBe("direct,eval,swarm");
  });

  it("treats a null sourceTypes exactly like omission", async () => {
    // `transform` reads anything non-array as "no filter given". A raw
    // execute() caller passing null must land on the narrowed default, not on
    // every source.
    const { builtTool, calls } = searchTool();

    await execTool(builtTool, { query: "refund", sourceTypes: null });

    const sessionsCall = calls.find((c) => c.path.includes("/sessions"))!;
    expect(sourceTypeParam(sessionsCall.path)).toBe("direct,eval,swarm");
  });

  it("passes an explicit allowed subset through untouched", async () => {
    const { builtTool, calls } = searchTool();

    await execTool(builtTool, { query: "refund", sourceTypes: ["eval"] });

    const sessionsCall = calls.find((c) => c.path.includes("/sessions"))!;
    expect(sourceTypeParam(sessionsCall.path)).toBe("eval");
  });

  it("REFUSES an explicit scenario request instead of silently narrowing it", async () => {
    // Narrowing would answer a question the caller did not ask; the model
    // should be told why and pick something else.
    const { builtTool, calls } = searchTool();

    const result = (await execTool(builtTool, {
      query: "refund",
      sourceTypes: ["direct", "scenario"],
    })) as { error?: string };

    expect(result.error).toContain("visitors");
    // And it never reached the API.
    expect(calls.some((c) => c.path.includes("/sessions"))).toBe(false);
  });

  it("tells the model about the narrowing in the tool description", async () => {
    const { builtTool } = searchTool();
    const description = (builtTool as { description?: string }).description!;
    // The ambient-project note still leads; the clamp note follows it.
    expect(description).toContain("current chat's project");
    expect(description).toContain("scenario");
  });

  it("clamps only operations this surface actually advertises", () => {
    // A clamp keyed to an unadvertised operation is dead code guarding
    // nothing — and reads as protection that is not there.
    const advertised = new Set<string>(MCPJAM_TOOL_IDS);
    const orphans = Object.keys(WORKSPACE_INPUT_CLAMPS)
      .filter((name) => !advertised.has(name))
      .sort();
    expect(orphans).toEqual([]);
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

  it("requires approval for registry installs and uninstall", () => {
    // install_registry_directory_server is create_project_server with
    // different spelling — a caller-supplied endpointUrl that ends as a
    // server row in the user's project — and uninstall is its
    // delete_project_server sibling. Skipping the approval gate here would
    // let a prompt-injected chat add or remove servers silently.
    const { client } = makeClient({});
    const approval = (id: string) =>
      (
        buildMcpjamTool(id, {
          ...toolOpts,
          client,
          requireToolApproval: true,
        }) as { needsApproval?: boolean }
      ).needsApproval;

    expect(approval("install_registry_directory_server")).toBe(true);
    expect(approval("install_registry_server")).toBe(true);
    expect(approval("uninstall_registry_server")).toBe(true);
    // The registry reads stay approval-free.
    expect(approval("search_registry_directory")).toBe(false);
    expect(approval("list_registry_connections")).toBe(false);
  });
});
