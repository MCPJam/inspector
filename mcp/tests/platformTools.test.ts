import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_OPERATIONS,
  getPluginVersionOperation,
  listProjectPluginsOperation,
  listProjectsOperation,
} from "@mcpjam/sdk/platform";
import {
  EXCLUDED_FROM_CATALOG,
  PLATFORM_CATALOG_OPERATIONS,
  PLATFORM_TOOL_WIDGET_VIEWS,
  registerPlatformCatalogTools,
  runPlatformOperation,
} from "../src/tools/platformTools.js";
import {
  registerShowServersTool,
  SHOW_SERVERS_RESOURCE_URI,
} from "../src/tools/showServers.js";
import { PLATFORM_WIDGET_RESOURCE_URIS } from "../src/shared/platform-widgets.js";
import type { PlatformToolContext } from "../src/server.js";
import type { SessionToolRegistrar } from "../src/tools/sessionToolRegistrar.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
};

type CapturedRegistration = {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
    };
  };
  callback: (input: unknown) => Promise<unknown>;
  ui?: {
    resourceUri: string;
    html: string;
    callback?: (input: unknown) => Promise<unknown>;
  };
};

function fakeRegistrar(): {
  registrar: SessionToolRegistrar;
  registrations: CapturedRegistration[];
} {
  const registrations: CapturedRegistration[] = [];
  const registrar = {
    registerTool(
      name: string,
      config: CapturedRegistration["config"],
      callback: CapturedRegistration["callback"],
      ui?: CapturedRegistration["ui"]
    ) {
      registrations.push({ name, config, callback, ui });
      return {} as never;
    },
  } as unknown as SessionToolRegistrar;
  return { registrar, registrations };
}

function fakeToolContext(
  overrides: { bearerToken?: string; platformApiUrl?: string } = {}
): PlatformToolContext {
  return {
    // runPlatformOperation resolves the bearer via getBearerToken() (async, so
    // anonymous requests can mint lazily). The stub just returns the override.
    getBearerToken: async () => overrides.bearerToken,
    runtimeEnv: {
      PLATFORM_API_URL:
        overrides.platformApiUrl ?? "https://staging.example.com/api/v1",
    },
  };
}

const WIDGET_TOOLS: Record<string, keyof typeof PLATFORM_WIDGET_RESOURCE_URIS> =
  {
    list_eval_suites: "eval_suites",
    list_eval_suite_runs: "eval_suite_runs",
    get_eval_run: "eval_run",
    list_eval_run_iterations: "eval_run_iterations",
    list_chatboxes: "chatboxes",
    get_chatbox: "chatbox",
  };

const PLAIN_TOOLS = [
  "get_me",
  "list_models",
  "list_organizations",
  "list_projects",
  "create_project",
  "update_project",
  "list_project_servers",
  "create_project_server",
  "get_project_server",
  "update_project_server",
  "delete_project_server",
  // Server live operations are agent-oriented payloads with no widget view.
  "connect_project_server",
  "get_project_server_connection_status",
  "diagnose_server",
  "list_server_tools",
  "call_server_tool",
  "list_server_prompts",
  "get_server_prompt",
  "list_server_resources",
  "read_server_resource",
  // Host-compat check: agent-oriented per-host verdict payload, no widget view.
  "check_host_compatibility",
  "run_eval_case",
  "run_eval_suite",
  "create_eval_suite",
  // Eval suite/case editing: agent-oriented payloads, no widget view.
  "get_eval_suite",
  "update_eval_suite",
  "delete_eval_suite",
  "set_eval_suite_schedule",
  "list_eval_cases",
  "get_eval_case",
  "create_eval_case",
  "update_eval_case",
  "delete_eval_case",
  "generate_eval_cases",
  "set_eval_suite_environments",
  // Project environments: agent-oriented payloads, no widget view.
  "list_project_environments",
  "get_project_environment",
  "resolve_project_environment",
  // Agent Plugins reads: agent-oriented payloads, no widget view.
  "list_project_plugins",
  "get_plugin_version",
  "get_eval_iteration_trace",
  "get_eval_run_steps",
  "cancel_eval_run",
  "list_chat_sessions",
  // Swarms + user testing. No widget views yet: these are agent-oriented
  // payloads, and a half-designed panel is worse than the structured JSON.
  "get_capabilities",
  "list_personas",
  "get_persona",
  "create_persona",
  "update_persona",
  "delete_persona",
  "generate_personas",
  "list_journeys",
  "get_journey",
  "create_journey",
  "update_journey",
  "archive_journey",
  "generate_journeys",
  "list_journey_runs",
  "get_journey_run",
  "list_journey_run_sessions",
  "launch_journey_run",
  "cancel_journey_run",
  "list_swarms",
  "get_swarm",
  "create_swarm",
  "update_swarm",
  "archive_swarm",
  "get_swarms_overview",
  "get_journey_run_scorecard",
  "list_swarm_findings",
  "dismiss_swarm_finding",
  "undismiss_swarm_finding",
  "get_wave_insights",
  "request_wave_insights",
  "cancel_wave_insights",
  "publish_scenario",
  "unpublish_scenario",
  "get_user_testing_scenario",
  "list_user_testing_sessions",
  "get_user_testing_session",
  "get_user_testing_metrics",
  "get_user_testing_usage",
  "list_user_testing_findings",
  "get_user_testing_signals",
  "get_user_testing_insights",
  "update_user_testing_scenario",
  "request_user_testing_insights",
  "cancel_user_testing_insights",
  "dismiss_user_testing_finding",
  "undismiss_user_testing_finding",
  "set_user_testing_guest_execution",
  "rotate_user_testing_link",
  "upsert_user_testing_member",
  "remove_user_testing_member",
  "rebind_user_testing_scenario",
];

function stubPlatformFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (target: unknown) => {
      const path = new URL(String(target)).pathname;
      for (const [suffix, payload] of Object.entries(routes)) {
        if (path.endsWith(suffix)) {
          return Response.json(payload);
        }
      }
      throw new Error(`Unexpected fetch: ${path}`);
    })
  );
}

const PROJECTS_PAGE = {
  items: [
    {
      id: "project-1",
      name: "Project One",
      organizationId: "org-1",
      updatedAt: 1,
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("platform tool registration", () => {
  it("partitions every SDK operation exactly once", () => {
    const exposed = new Set(
      PLATFORM_CATALOG_OPERATIONS.map((operation) => operation.name)
    );
    const excluded = new Set(Object.keys(EXCLUDED_FROM_CATALOG));
    const all = new Set(ALL_OPERATIONS.map((operation) => operation.name));
    expect(exposed.size + excluded.size).toBe(all.size);
    expect([...exposed].filter((name) => excluded.has(name))).toEqual([]);
    expect(
      [...all].filter((name) => !exposed.has(name) && !excluded.has(name))
    ).toEqual([]);
    expect([...exposed, ...excluded].filter((name) => !all.has(name))).toEqual(
      []
    );
    for (const reason of Object.values(EXCLUDED_FROM_CATALOG)) {
      expect(reason.trim().length).toBeGreaterThanOrEqual(20);
    }
  });

  it("registers show_servers with the MCP Apps UI resource", () => {
    const { registrar, registrations } = fakeRegistrar();

    registerShowServersTool(registrar, fakeToolContext({ bearerToken: "jwt" }));

    expect(registrations).toHaveLength(1);
    const registration = registrations[0]!;
    expect(registration.name).toBe("show_servers");
    expect(registration.config.annotations?.readOnlyHint).toBe(true);
    expect(registration.ui?.resourceUri).toBe(SHOW_SERVERS_RESOURCE_URI);
    expect(registration.ui?.html).toContain("<html");
  });

  it("registers the whole operation catalog in order", () => {
    const { registrar, registrations } = fakeRegistrar();

    registerPlatformCatalogTools(
      registrar,
      fakeToolContext({ bearerToken: "jwt" })
    );

    expect(registrations.map((registration) => registration.name)).toEqual([
      "get_me",
      "list_models",
      "list_organizations",
      "list_projects",
      "create_project",
      "update_project",
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
      "check_host_compatibility",
      "list_eval_suites",
      "list_eval_suite_runs",
      "run_eval_case",
      "run_eval_suite",
      "create_eval_suite",
      "get_eval_suite",
      "update_eval_suite",
      "delete_eval_suite",
      "set_eval_suite_schedule",
      "set_eval_suite_environments",
      "list_eval_cases",
      "get_eval_case",
      "create_eval_case",
      "update_eval_case",
      "delete_eval_case",
      "generate_eval_cases",
      "get_eval_run",
      "list_eval_run_iterations",
      "get_eval_iteration_trace",
      "get_eval_run_steps",
      "cancel_eval_run",
      "list_project_environments",
      "get_project_environment",
      "resolve_project_environment",
      "list_project_plugins",
      "get_plugin_version",
      "list_chatboxes",
      "get_chatbox",
      "list_chat_sessions",
      "get_capabilities",
      "list_personas",
      "get_persona",
      "create_persona",
      "update_persona",
      "delete_persona",
      "generate_personas",
      "list_journeys",
      "get_journey",
      "create_journey",
      "update_journey",
      "archive_journey",
      "generate_journeys",
      "list_journey_runs",
      "get_journey_run",
      "list_journey_run_sessions",
      "launch_journey_run",
      "cancel_journey_run",
      "list_swarms",
      "get_swarm",
      "create_swarm",
      "update_swarm",
      "archive_swarm",
      "get_swarms_overview",
      "get_journey_run_scorecard",
      "list_swarm_findings",
      "dismiss_swarm_finding",
      "undismiss_swarm_finding",
      "get_wave_insights",
      "request_wave_insights",
      "cancel_wave_insights",
      "publish_scenario",
      "unpublish_scenario",
      "get_user_testing_scenario",
      "list_user_testing_sessions",
      "get_user_testing_session",
      "get_user_testing_metrics",
      "get_user_testing_usage",
      "list_user_testing_findings",
      "get_user_testing_signals",
      "get_user_testing_insights",
      "update_user_testing_scenario",
      "request_user_testing_insights",
      "cancel_user_testing_insights",
      "dismiss_user_testing_finding",
      "undismiss_user_testing_finding",
      "set_user_testing_guest_execution",
      "rotate_user_testing_link",
      "upsert_user_testing_member",
      "remove_user_testing_member",
      "rebind_user_testing_scenario",
    ]);
    expect(registrations).toHaveLength(PLATFORM_CATALOG_OPERATIONS.length);
    for (const registration of registrations) {
      expect(registration.config.description).toBeTruthy();
    }
  });

  it("attaches the shared widget bundle to the widget-backed tools only", () => {
    const { registrar, registrations } = fakeRegistrar();

    registerPlatformCatalogTools(
      registrar,
      fakeToolContext({ bearerToken: "jwt" })
    );

    for (const registration of registrations) {
      const view = WIDGET_TOOLS[registration.name];
      if (view) {
        expect(registration.ui?.resourceUri).toBe(
          PLATFORM_WIDGET_RESOURCE_URIS[view]
        );
        expect(registration.ui?.html).toContain("<html");
        expect(registration.ui?.callback).toBeTypeOf("function");
      } else {
        expect(PLAIN_TOOLS).toContain(registration.name);
        expect(registration.ui).toBeUndefined();
      }
    }
    expect(Object.keys(PLATFORM_TOOL_WIDGET_VIEWS).sort()).toEqual(
      Object.keys(WIDGET_TOOLS).sort()
    );
  });

  it("marks reads read-only, the eval-run starter as non-destructive write, and call_server_tool as assume-destructive", () => {
    const { registrar, registrations } = fakeRegistrar();

    registerPlatformCatalogTools(
      registrar,
      fakeToolContext({ bearerToken: "jwt" })
    );

    const NON_DESTRUCTIVE_WRITES = new Set([
      "run_eval_case",
      "run_eval_suite",
      "create_eval_suite",
      "update_eval_suite",
      "set_eval_suite_schedule",
      "set_eval_suite_environments",
      "create_eval_case",
      "update_eval_case",
      "generate_eval_cases",
      "create_project_server",
      "update_project_server",
      // Project create/update: both are cheap, both are metadata-only (the
      // update schema has no `servers` key at all), and neither destroys
      // anything — so they announce a plain write, not a destructive one.
      "create_project",
      "update_project",
      // Creates a connection request, and possibly a DISABLED server row.
      // Nothing is destroyed and nothing is enabled without a person
      // completing the flow, so it is a write rather than a destructive one.
      "connect_project_server",
      // Swarms authoring. Persists and is editable; nothing here removes
      // anything, and creating a journey starts nothing.
      "create_persona",
      "update_persona",
      "create_journey",
      "update_journey",
      "create_swarm",
      "update_swarm",
      // Generation writes NOTHING — it returns drafts — but it spends, so it
      // cannot claim to be a read.
      "generate_personas",
      "generate_journeys",
      // Insight lifecycle. Requesting spends; dismissing records a judgement;
      // cancelling stops a generation nobody is waiting for.
      "dismiss_swarm_finding",
      "undismiss_swarm_finding",
      "request_wave_insights",
      "cancel_wave_insights",
      // Launching spends across a fan-out, but it does not destroy anything.
      "launch_journey_run",
      // Publishing exposes an environment. Additive: it creates a scenario.
      "publish_scenario",
      // User testing writes that change state without removing anything.
      // `rotate_user_testing_link` and `remove_user_testing_member` are below,
      // with the destructive set: both take access away from people who have
      // it, immediately.
      "update_user_testing_scenario",
      "request_user_testing_insights",
      "cancel_user_testing_insights",
      "dismiss_user_testing_finding",
      "undismiss_user_testing_finding",
      "set_user_testing_guest_execution",
      "upsert_user_testing_member",
      "rebind_user_testing_scenario",
    ]);
    // Destructive AND not safe to repeat — for opposite reasons: the soft
    // deletes 404 on a retry, the rotation mints another link.
    const NON_IDEMPOTENT_DESTRUCTIVE = new Set([
      "delete_persona",
      "archive_journey",
      "archive_swarm",
      "remove_user_testing_member",
      "rotate_user_testing_link",
    ]);
    const DESTRUCTIVE_OPS = new Set([
      "delete_eval_suite",
      "delete_eval_case",
      // Cancelling a run terminates in-flight work, so it announces destructive.
      "cancel_eval_run",
      "delete_project_server",
      // The swarm soft deletes: history survives, but the resource leaves the
      // roster and a second call answers not-found. From the caller's side
      // that is a removal.
      "delete_persona",
      "archive_journey",
      "archive_swarm",
      "cancel_journey_run",
      // Unpublishing kills every live guest session on the scenario.
      "unpublish_scenario",
      // Rotating invalidates every copy of the share link that anyone holds.
      "rotate_user_testing_link",
      "remove_user_testing_member",
    ]);

    for (const registration of registrations) {
      if (NON_DESTRUCTIVE_WRITES.has(registration.name)) {
        expect(registration.config.annotations).toEqual({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        });
      } else if (DESTRUCTIVE_OPS.has(registration.name)) {
        // Known-destructive ops announce it explicitly. Whether they also
        // announce IDEMPOTENCY is a separate claim: a soft delete answers
        // not-found on a second call and a link rotation mints a new link, so
        // an auto-retrying client would get a spurious error or a broken link.
        expect(registration.config.annotations).toEqual({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: !NON_IDEMPOTENT_DESTRUCTIVE.has(registration.name),
        });
      } else if (registration.name === "call_server_tool") {
        // Arbitrary third-party tool execution: destructive/idempotent hints
        // are deliberately absent so clients assume destructive (spec
        // default).
        expect(registration.config.annotations).toEqual({
          readOnlyHint: false,
        });
      } else {
        expect(registration.config.annotations).toEqual({
          readOnlyHint: true,
        });
      }
    }
  });
});

describe("widget payload tagging", () => {
  it("tags the widget callback's payload in both channels and leaves the plain callback untagged", async () => {
    stubPlatformFetch({
      "/projects": PROJECTS_PAGE,
      "/chatboxes": {
        items: [
          {
            id: "chatbox-1",
            name: "Support bot",
            serverCount: 0,
            serverNames: [],
          },
        ],
      },
    });
    const { registrar, registrations } = fakeRegistrar();
    registerPlatformCatalogTools(
      registrar,
      fakeToolContext({ bearerToken: "jwt" })
    );
    const registration = registrations.find(
      (candidate) => candidate.name === "list_chatboxes"
    )!;

    const tagged = (await registration.ui!.callback!({})) as ToolResult;
    expect(tagged.isError).toBeUndefined();
    expect(tagged.structuredContent?.widget).toBe("chatboxes");
    expect(JSON.parse(tagged.content[0]!.text).widget).toBe("chatboxes");

    const plain = (await registration.callback({})) as ToolResult;
    expect(plain.isError).toBeUndefined();
    expect(plain.structuredContent).not.toHaveProperty("widget");
    expect(JSON.parse(plain.content[0]!.text)).not.toHaveProperty("widget");
  });

  it("tags show_servers widget payloads with the servers view", async () => {
    stubPlatformFetch({
      "/projects": PROJECTS_PAGE,
      "/servers": { items: [] },
    });
    const { registrar, registrations } = fakeRegistrar();
    registerShowServersTool(registrar, fakeToolContext({ bearerToken: "jwt" }));

    const result = (await registrations[0]!.ui!.callback!({})) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.widget).toBe("servers");
    expect(result.structuredContent?.servers).toEqual([]);
  });
});

describe("plugin read tools", () => {
  it("list_project_plugins resolves the project and returns the live plugins", async () => {
    const pluginsPage = {
      items: [
        {
          id: "plugin-1",
          projectId: "project-1",
          name: "linear-tools",
          displayName: "Linear Tools",
          enabled: true,
          activeVersionId: "pv-1",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    stubPlatformFetch({
      "/projects": PROJECTS_PAGE,
      "/projects/project-1/plugins": pluginsPage,
    });

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      listProjectPluginsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      project: { id: "project-1" },
      items: pluginsPage.items,
    });
  });

  it("get_plugin_version returns the version detail by raw id", async () => {
    const version = {
      id: "pv-1",
      pluginId: "plugin-1",
      bundleHash: "hash-abc",
      status: "ready",
      componentCounts: {
        skills: 1,
        servers: 1,
        apps: 0,
        assets: 0,
        unsupported: 0,
      },
      servers: [],
      skills: [],
      createdAt: 1,
    };
    stubPlatformFetch({ "/plugin-versions/pv-1": version });

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      getPluginVersionOperation,
      { pluginVersionId: "pv-1" }
    )) as ToolResult;

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(version);
  });
});

describe("runPlatformOperation", () => {
  it("returns a tool error when the request has no bearer token", async () => {
    const result = (await runPlatformOperation(
      fakeToolContext(),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("bearer token");
  });

  it("caps the model-visible text while keeping structuredContent complete", async () => {
    const hugeDescription = "x".repeat(60_000);
    const hugePage = {
      items: [
        {
          id: "project-1",
          name: "Big Project",
          description: hugeDescription,
          icon: null,
          organizationId: null,
          visibility: "private",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(hugePage))
    );

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text.length).toBeLessThan(25_000);
    expect(text).toContain("…[truncated");
    // The complete payload survives for widgets/programmatic consumers.
    expect(
      (result.structuredContent as { items: Array<{ description: string }> })
        .items[0]!.description
    ).toBe(hugeDescription);
  });

  it("calls the configured platform API with the agent bearer and returns structured content", async () => {
    const fetchMock = vi.fn(async () => Response.json(PROJECTS_PAGE));
    vi.stubGlobal("fetch", fetchMock);

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as {
      isError?: boolean;
      structuredContent: { items: Array<{ id: string }> };
    };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.items[0]?.id).toBe("project-1");

    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe("https://staging.example.com/api/v1/projects");
    expect(
      new Headers((init as RequestInit).headers as HeadersInit).get(
        "authorization"
      )
    ).toBe("Bearer user-jwt");
  });

  it("maps wire errors onto tool errors with their stable code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ code: "FORBIDDEN", message: "Denied" }, { status: 403 })
      )
    );

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("FORBIDDEN: Denied");
  });

  it("carries the error code in structuredContent so the widget can branch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "NOT_FOUND",
            message: "No accessible MCPJam projects were found.",
          },
          { status: 404 }
        )
      )
    );

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toEqual({
      code: "NOT_FOUND",
      message: "No accessible MCPJam projects were found.",
    });
  });
});
