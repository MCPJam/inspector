import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_OPERATIONS,
  expandComposeModelChoices,
  getPluginVersionOperation,
  listProjectPluginsOperation,
  listProjectServersOperation,
  listProjectsOperation,
  listStudiesOperation,
  runEvalSuiteOperation,
  showServersOperation,
} from "@mcpjam/sdk/platform";
import {
  compactModelCatalogForModel,
  EXCLUDED_FROM_CATALOG,
  PLATFORM_CATALOG_OPERATIONS,
  PLATFORM_TOOL_WIDGET_VIEWS,
  platformWidgetUi,
  registerPlatformCatalogTools,
  runPlatformOperation,
} from "../src/tools/platformTools.js";
import {
  registerShowServersTool,
  SHOW_SERVERS_RESOURCE_URI,
} from "../src/tools/showServers.js";
import {
  PLATFORM_WIDGETS_ENABLED,
  PLATFORM_WIDGET_RESOURCE_URIS,
} from "../src/shared/platform-widgets.js";
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
      openWorldHint?: boolean;
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

/**
 * The JSON half of a tool's text content.
 *
 * The text block leads with one `Label: https://…` line per permalink and then
 * the payload, separated by a blank line — deliberately not parseable as a
 * whole. The text channel is what a MODEL reads (and hosts vary in whether
 * they render `structuredContent` at all, which is why the links are there
 * too); `structuredContent` is the machine channel, and every consumer that
 * wants an object should read that.
 */
function jsonBodyOf(result: ToolResult): Record<string, unknown> {
  const text = (result.content?.[0] as { text: string }).text;
  const separator = text.indexOf("\n\n{");
  return JSON.parse(separator === -1 ? text : text.slice(separator + 2));
}

function fakeToolContext(
  overrides: {
    bearerToken?: string;
    platformApiUrl?: string;
    appOrigin?: string;
    callerUserAgent?: string;
    isGuestSession?: boolean;
  } = {}
): PlatformToolContext {
  return {
    // runPlatformOperation resolves the bearer via getBearerToken() (async, so
    // anonymous requests can mint lazily). The stub just returns the override.
    getBearerToken: async () => overrides.bearerToken,
    runtimeEnv: {
      PLATFORM_API_URL:
        overrides.platformApiUrl ?? "https://staging.example.com/api/v1",
      MCPJAM_APP_ORIGIN: overrides.appOrigin ?? "https://staging.example.com",
    },
    ...(overrides.callerUserAgent
      ? { callerUserAgent: overrides.callerUserAgent }
      : {}),
    ...(overrides.isGuestSession !== undefined
      ? { isGuestSession: overrides.isGuestSession }
      : {}),
  };
}

const WIDGET_TOOLS: Record<string, keyof typeof PLATFORM_WIDGET_RESOURCE_URIS> =
  {
    list_eval_suites: "eval_suites",
    list_eval_suite_runs: "eval_suite_runs",
    get_eval_run: "eval_run",
    list_eval_run_iterations: "eval_run_iterations",
    list_studies: "scenarios",
    get_study: "scenario",
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
  "cancel_project_server_connection",
  "diagnose_server",
  "list_server_tools",
  "call_server_tool",
  // The render verdict is structured evidence (tree, console errors, blocked
  // requests). A widget PANEL here would be a second, drifting copy of the
  // Apps tab.
  "render_server_widget",
  "list_server_prompts",
  "get_server_prompt",
  "list_server_resources",
  "read_server_resource",
  // Skills over MCP: a catalog, a verified skill body, and a verified file.
  // All three can answer with a refusal naming the integrity check that
  // failed, which is structured evidence to read rather than a card to render.
  "list_server_skills",
  "get_server_skill",
  "read_server_skill_file",
  // Host-compat check: agent-oriented per-host verdict payload, no widget view.
  "check_host_compatibility",
  // Directory readiness: receipts and run rows are agent-oriented payloads,
  // and a report is a document to read rather than a card to render.
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
  "run_eval_case",
  "run_eval_suite",
  "create_eval_suite",
  // Eval suite/case editing: agent-oriented payloads, no widget view.
  "get_eval_suite",
  "get_eval_run_disclosure",
  "update_eval_suite",
  "list_eval_suite_revisions",
  "delete_eval_suite",
  "set_eval_suite_schedule",
  "list_eval_cases",
  "get_eval_case",
  "create_eval_case",
  "create_eval_cases",
  "update_eval_case",
  "delete_eval_case",
  "generate_eval_cases",
  "import_eval_cases",
  // Stage analytics: a measured description with slice arrays and exclusion
  // tallies. The app renders it as a funnel; a tool result is the numbers.
  "get_eval_run_stage_analytics",
  "get_eval_run_gate",
  "get_eval_run_route_facts",
  // Server facts: what the run was taken against — a snapshot description, no
  // widget view, so it belongs with the plain tools.
  "get_eval_run_server_facts",
  "list_eval_suite_stage_analytics",
  "set_eval_suite_environments",
  // Project environments: agent-oriented payloads, no widget view.
  "list_project_environments",
  "get_project_environment",
  "resolve_project_environment",
  "ensure_adhoc_environment",
  // Sandbox image reads: the picker behind a suite's computer image.
  "list_sandbox_images",
  "get_sandbox_image",
  // Agent Plugins reads: agent-oriented payloads, no widget view.
  "list_project_plugins",
  "get_plugin_version",
  "list_project_skills",
  "get_project_skill",
  "get_eval_iteration_trace",
  "compare_eval_run",
  // The gate-waiver read: an agent-oriented payload, no widget view.
  "get_eval_gate_waiver",
  "get_eval_run_steps",
  "cancel_eval_run",
  "backtest_eval_run",
  "backtest_eval_run_judge",
  "request_eval_run_judge",
  // The description-rewrite experiment: agent-oriented payloads (a diff and
  // two arm counts), no widget view.
  "propose_eval_description_rewrite",
  "start_eval_description_experiment",
  "get_eval_description_experiment",
  // GitHub checks: agent-oriented payloads, no widget view. Both spellings —
  // the `*_check_repo*` pair is the pre-rename one, still advertised.
  "list_eval_github_repos",
  "connect_eval_github_repo",
  "list_eval_check_repos",
  "connect_eval_check_repo",
  "list_chat_sessions",
  "search_sessions",
  // Agent Playground: the turn plus its two reads. Agent-oriented payloads —
  // a trace panel would be a second, drifting copy of the eval trace viewer.
  "send_chat_message",
  "drive_chat_session_browser",
  "observe_chat_session_browser",
  "get_chat_session",
  "get_chat_session_trace",
  // Swarms + user testing. No widget views yet: these are agent-oriented
  // payloads, and a half-designed panel is worse than the structured JSON.
  "get_capabilities",
  "list_personas",
  "get_persona",
  "create_persona",
  "update_persona",
  "delete_persona",
  "list_secrets",
  "get_secret",
  "delete_secret",
  "generate_personas",
  "list_goals",
  "get_goal",
  "create_goal",
  "update_goal",
  "archive_goal",
  "generate_goals",
  "list_goal_runs",
  "get_goal_run",
  "list_goal_run_sessions",
  "launch_goal_run",
  "cancel_goal_run",
  "list_swarms",
  "get_swarm",
  "create_swarm",
  "update_swarm",
  "archive_swarm",
  "get_swarms_overview",
  "get_goal_run_scorecard",
  "list_swarm_findings",
  "dismiss_swarm_finding",
  "undismiss_swarm_finding",
  "get_swarm_run_insights",
  "request_swarm_run_insights",
  "cancel_swarm_run_insights",
  "publish_study",
  "unpublish_study",
  "get_study",
  "list_study_sessions",
  "get_study_session",
  "get_study_metrics",
  "get_study_usage",
  "list_study_findings",
  "get_study_signals",
  "get_study_insights",
  "update_study",
  "request_study_insights",
  "cancel_study_insights",
  "dismiss_study_finding",
  "undismiss_study_finding",
  "set_study_guest_execution",
  "rotate_study_link",
  "upsert_study_member",
  "remove_study_member",
  "rebind_study",
  "list_clients",
  "get_client",
  "create_client",
  "update_client",
  "set_client_servers",
  "duplicate_client",
  "search_registry_directory",
  "get_registry_directory_server",
  "list_registry_directory_sources",
  "list_registry_servers",
  "list_registry_connections",
  "install_registry_directory_server",
  "install_registry_server",
  "uninstall_registry_server",
  "send_feedback",
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

  it("warns that a spend operation costs money, derived from its risk facet", () => {
    // MCP has no "this costs money" annotation, so the honest place for it is
    // the description every client renders. Derived from the operation's own
    // `risk`, never a second name list here: that list would go stale the
    // first time an operation is re-classified, silently and in the direction
    // that drops the warning.
    const { registrar, registrations } = fakeRegistrar();
    registerPlatformCatalogTools(
      registrar,
      fakeToolContext({ bearerToken: "jwt" })
    );
    const byName = new Map(
      registrations.map((registration) => [registration.name, registration])
    );
    for (const operation of PLATFORM_CATALOG_OPERATIONS) {
      const description = String(
        byName.get(operation.name)?.config.description
      );
      expect(description.includes("COSTS MONEY")).toBe(
        operation.risk === "spend"
      );
    }
    // The two eval launches are the ones this exists for.
    expect(String(byName.get("run_eval_suite")?.config.description)).toContain(
      "COSTS MONEY"
    );
    expect(
      String(byName.get("list_eval_suites")?.config.description)
    ).not.toContain("COSTS MONEY");
  });

  it("registers show_servers, with its MCP Apps UI resource only while widgets are on", () => {
    const { registrar, registrations } = fakeRegistrar();

    registerShowServersTool(registrar, fakeToolContext({ bearerToken: "jwt" }));

    // The tool itself registers either way: pausing the widgets must not
    // remove a tool name hosts and agents already call.
    expect(registrations).toHaveLength(1);
    const registration = registrations[0]!;
    expect(registration.name).toBe("show_servers");
    expect(registration.config.annotations?.readOnlyHint).toBe(true);
    expect(registration.config.annotations?.title).toBe(
      registration.config.title
    );
    if (PLATFORM_WIDGETS_ENABLED) {
      expect(registration.ui?.resourceUri).toBe(SHOW_SERVERS_RESOURCE_URI);
      expect(registration.ui?.html).toContain("<html");
    } else {
      expect(registration.ui).toBeUndefined();
    }
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
      "cancel_project_server_connection",
      "diagnose_server",
      "list_server_tools",
      "call_server_tool",
      "render_server_widget",
      "list_server_prompts",
      "get_server_prompt",
      "list_server_resources",
      "read_server_resource",
      "list_server_skills",
      "get_server_skill",
      "read_server_skill_file",
      "check_host_compatibility",
      "list_eval_suites",
      "list_eval_suite_runs",
      "run_eval_case",
      "run_eval_suite",
      "create_eval_suite",
      "get_eval_suite",
      "get_eval_run_disclosure",
      "update_eval_suite",
      "list_eval_suite_revisions",
      "delete_eval_suite",
      "set_eval_suite_environments",
      "list_eval_cases",
      "get_eval_case",
      "create_eval_case",
      "create_eval_cases",
      "update_eval_case",
      "delete_eval_case",
      "generate_eval_cases",
      "import_eval_cases",
      "get_eval_run",
      "get_eval_run_stage_analytics",
      "get_eval_run_gate",
      "get_eval_run_route_facts",
      "get_eval_run_server_facts",
      "list_eval_suite_stage_analytics",
      "compare_eval_run",
      "get_eval_gate_waiver",
      "list_eval_run_iterations",
      "get_eval_iteration_trace",
      "get_eval_run_steps",
      "cancel_eval_run",
      "backtest_eval_run",
      "backtest_eval_run_judge",
      "request_eval_run_judge",
      "list_project_environments",
      "get_project_environment",
      "resolve_project_environment",
      "ensure_adhoc_environment",
      "list_studies",
      "get_study",
      "list_chat_sessions",
      "send_chat_message",
      "get_chat_session",
      "get_chat_session_trace",
      "get_capabilities",
      "list_personas",
      "get_persona",
      "create_persona",
      "update_persona",
      "delete_persona",
      "list_secrets",
      "get_secret",
      "delete_secret",
      "generate_personas",
      "list_goals",
      "get_goal",
      "create_goal",
      "update_goal",
      "archive_goal",
      "generate_goals",
      "list_goal_runs",
      "get_goal_run",
      "list_goal_run_sessions",
      "launch_goal_run",
      "cancel_goal_run",
      "list_swarms",
      "get_swarm",
      "create_swarm",
      "update_swarm",
      "archive_swarm",
      "get_swarms_overview",
      "get_goal_run_scorecard",
      "list_swarm_findings",
      "dismiss_swarm_finding",
      "undismiss_swarm_finding",
      "get_swarm_run_insights",
      "request_swarm_run_insights",
      "cancel_swarm_run_insights",
      "publish_study",
      "unpublish_study",
      "list_study_sessions",
      "get_study_session",
      "get_study_metrics",
      "get_study_usage",
      "list_study_findings",
      "get_study_signals",
      "get_study_insights",
      "update_study",
      "request_study_insights",
      "cancel_study_insights",
      "dismiss_study_finding",
      "undismiss_study_finding",
      "set_study_guest_execution",
      "rotate_study_link",
      "upsert_study_member",
      "remove_study_member",
      "rebind_study",
      "list_clients",
      "get_client",
      "create_client",
      "update_client",
      "set_client_servers",
      "duplicate_client",
      "list_registry_servers",
      "list_registry_connections",
      "install_registry_server",
      "uninstall_registry_server",
      "send_feedback",
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
      // Widgets paused ⇒ every tool registers plain, whatever the view map
      // says. The map itself is still checked below, so it cannot rot while
      // the switch is off.
      const view = PLATFORM_WIDGETS_ENABLED
        ? WIDGET_TOOLS[registration.name]
        : undefined;
      if (view) {
        expect(registration.ui?.resourceUri).toBe(
          PLATFORM_WIDGET_RESOURCE_URIS[view]
        );
        expect(registration.ui?.html).toContain("<html");
        expect(registration.ui?.callback).toBeTypeOf("function");
      } else {
        if (PLATFORM_WIDGETS_ENABLED) {
          expect(PLAIN_TOOLS).toContain(registration.name);
        }
        expect(registration.ui).toBeUndefined();
      }
    }
    expect(Object.keys(PLATFORM_TOOL_WIDGET_VIEWS).sort()).toEqual(
      Object.keys(WIDGET_TOOLS).sort()
    );
  });

  it("annotates every tool for Claude's directory: a title, read-only reads, and destructive unless purely additive", () => {
    const { registrar, registrations } = fakeRegistrar();

    registerPlatformCatalogTools(
      registrar,
      fakeToolContext({ bearerToken: "jwt" })
    );

    // Spelled out, not read from the worker's tables, so a name that drifts
    // into or out of either list fails here instead of passing by construction.
    //
    // Writes that only create rows or start new work. Every other write —
    // updates, replacements, cancels, revokes, deletes, forced regenerations,
    // and anything that runs a third party's tool — must say destructive.
    const ADDITIVE_WRITES = new Set([
      "create_project",
      "create_project_server",
      "create_eval_suite",
      "create_eval_case",
      "create_eval_cases",
      "generate_eval_cases",
      "import_eval_cases",
      "run_eval_case",
      "run_eval_suite",
      "backtest_eval_run",
      "backtest_eval_run_judge",
      "ensure_adhoc_environment",
      "create_persona",
      "generate_personas",
      "create_goal",
      "generate_goals",
      "launch_goal_run",
      "create_swarm",
      "publish_study",
      "create_client",
      "duplicate_client",
      "send_feedback",
    ]);
    // Writes whose identical repeat answers success on the state the first
    // call produced. NOT here: update_client and set_client_servers (409 on a
    // rotated config id), delete_eval_suite / delete_eval_case /
    // uninstall_registry_server (not-found), unpublish_study (not-found for a
    // named study), rotate_study_link (mints another link).
    const IDEMPOTENT_WRITES = new Set([
      "delete_project_server",
      "cancel_eval_run",
      "cancel_goal_run",
      "cancel_project_server_connection",
      "send_feedback",
      "ensure_adhoc_environment",
      "dismiss_swarm_finding",
      "undismiss_swarm_finding",
      "dismiss_study_finding",
      "undismiss_study_finding",
      "upsert_study_member",
      "update_project",
      "archive_goal",
    ]);
    // Writes whose effect leaves the caller's organization.
    const EXTERNAL_COMMUNICATION = new Set(["send_feedback"]);

    const names = new Set(registrations.map((registration) => registration.name));
    for (const name of [...ADDITIVE_WRITES, ...IDEMPOTENT_WRITES]) {
      expect(names, `${name} is not a registered tool`).toContain(name);
    }

    // The ones the directory review named, and the ones the audit moved.
    const annotationsOf = (name: string) =>
      registrations.find((registration) => registration.name === name)?.config
        .annotations;
    for (const name of [
      "call_server_tool",
      "send_chat_message",
      "update_project",
      "update_project_server",
      "connect_project_server",
      "install_registry_server",
      "request_eval_run_judge",
      "request_study_insights",
      "request_swarm_run_insights",
      "cancel_study_insights",
      "cancel_swarm_run_insights",
      "upsert_study_member",
      "set_study_guest_execution",
      "update_eval_suite",
      "update_eval_case",
      "set_eval_suite_environments",
    ]) {
      expect(annotationsOf(name)?.destructiveHint, name).toBe(true);
    }
    for (const name of [
      "update_client",
      "set_client_servers",
      "delete_eval_suite",
      "delete_eval_case",
      "uninstall_registry_server",
      "unpublish_study",
      "rotate_study_link",
      "publish_study",
    ]) {
      expect(annotationsOf(name)?.idempotentHint, name).toBe(false);
    }

    for (const registration of registrations) {
      const { title, ...hints } = registration.config.annotations ?? {};
      // Claude's directory reads `annotations.title` and ignores the top-level
      // one, so every tool carries both.
      expect(title, registration.name).toBe(registration.config.title);
      expect(String(title).trim(), registration.name).not.toBe("");
      expect(registration.name.length, registration.name).toBeLessThanOrEqual(
        64
      );

      if (hints.readOnlyHint === true) {
        expect(hints, registration.name).toEqual({ readOnlyHint: true });
        continue;
      }
      expect(hints, registration.name).toEqual({
        readOnlyHint: false,
        destructiveHint: !ADDITIVE_WRITES.has(registration.name),
        idempotentHint: IDEMPOTENT_WRITES.has(registration.name),
        ...(EXTERNAL_COMMUNICATION.has(registration.name)
          ? { openWorldHint: true }
          : {}),
      });
    }
  });
});

describe("widget payload tagging", () => {
  it("tags the widget callback's payload in both channels and leaves the plain callback untagged", async () => {
    stubPlatformFetch({
      "/projects": PROJECTS_PAGE,
      "/studies": {
        items: [
          {
            id: "study-1",
            name: "Support bot",
            serverCount: 0,
            serverNames: [],
          },
        ],
      },
    });
    // The widget UI is built here rather than read off a registration: the
    // tagging contract is the same whether or not PLATFORM_WIDGETS_ENABLED is
    // currently attaching it to the tool.
    const context = fakeToolContext({ bearerToken: "jwt" });
    const ui = platformWidgetUi(context, listStudiesOperation, "scenarios");

    const tagged = (await ui.callback({})) as ToolResult;
    expect(tagged.isError).toBeUndefined();
    expect(tagged.structuredContent?.widget).toBe("scenarios");
    expect(jsonBodyOf(tagged).widget).toBe("scenarios");

    const plain = (await runPlatformOperation(
      context,
      listStudiesOperation,
      {}
    )) as ToolResult;
    expect(plain.isError).toBeUndefined();
    expect(plain.structuredContent).not.toHaveProperty("widget");
    expect(jsonBodyOf(plain)).not.toHaveProperty("widget");
  });

  it("tags show_servers widget payloads with the servers view", async () => {
    stubPlatformFetch({
      "/projects": PROJECTS_PAGE,
      "/servers": { items: [] },
    });
    const ui = platformWidgetUi(
      fakeToolContext({ bearerToken: "jwt" }),
      showServersOperation,
      "servers"
    );

    const result = (await ui.callback({})) as ToolResult;

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
    // The envelope: the operation's own payload, plus the permalinks it
    // derived. `get_plugin_version` resolves no project (it takes a global
    // pluginVersionId), so it declares no permalink and the array is empty —
    // present regardless, so a consumer never has to branch on the field
    // existing.
    expect(result.structuredContent).toEqual({ ...version, permalinks: [] });
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
    // No x-request-id on the response, so nothing to quote.
    expect(result.structuredContent?.error).toEqual({
      code: "FORBIDDEN",
      message: "Denied",
    });
  });

  it("quotes the failing request's id in both channels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "INTERNAL_ERROR", message: "Something broke" },
          {
            status: 500,
            headers: { "x-request-id": "req_0123456789abcdef" },
          }
        )
      )
    );

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "INTERNAL_ERROR: Something broke (request id: req_0123456789abcdef)"
    );
    expect(result.structuredContent?.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Something broke",
      requestId: "req_0123456789abcdef",
    });
  });

  it("keeps the request id beside a refusal's retry guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "RATE_LIMITED", message: "Slow down." },
          {
            status: 429,
            headers: {
              "Retry-After": "30",
              "x-request-id": "req_0123456789abcdef",
            },
          }
        )
      )
    );

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.content[0]?.text).toBe(
      "RATE_LIMITED: Slow down. (request id: req_0123456789abcdef) Retry after 30s, not sooner."
    );
    expect(
      (result.structuredContent?.error as { requestId?: string }).requestId
    ).toBe("req_0123456789abcdef");
  });

  it("tells the model when a usage-limit refusal lifts, in both channels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "RATE_LIMITED",
            message: "MCPJam's daily budget for this feature is used up.",
            details: {
              ok: false,
              code: "platform_capacity",
              canTopUp: false,
              isRetryable: true,
              retryAfterMs: 3_600_000,
              error: "not forwarded as a refusal field",
            },
          },
          { status: 429, headers: { "Retry-After": "3600" } }
        )
      )
    );

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "RATE_LIMITED: MCPJam's daily budget for this feature is used up. " +
        "Retry after 3600s, not sooner. This is a usage limit: topping up credits does not lift it."
    );
    expect(result.structuredContent?.error).toEqual({
      code: "RATE_LIMITED",
      message: "MCPJam's daily budget for this feature is used up.",
      refusal: {
        status: 429,
        code: "RATE_LIMITED",
        reason: "platform_capacity",
        canTopUp: false,
        retryable: true,
        retryAfterSeconds: 3600,
      },
    });
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

describe("the permalink envelope", () => {
  it("returns one permalink per row, scoped to the project the op resolved", async () => {
    // The reproduction, inverted: the caller names the project by NAME, so the
    // id exists only after the operation resolves it. Before the resolved-scope
    // receipt an adapter had nothing to scope a link with, and the model
    // invented `https://app.mcpjam.com/servers` — which opens whichever
    // project the RECIPIENT last selected.
    stubPlatformFetch({
      "/projects": {
        items: [
          { id: "proj_demo", name: "Demo", updatedAt: 2 },
          { id: "proj_default", name: "Default", updatedAt: 1 },
        ],
      },
      "/projects/proj_demo/servers": {
        items: [
          { id: "srv_1", name: "Asana", projectId: "proj_demo" },
          { id: "srv_2", name: "Linear", projectId: "proj_demo" },
        ],
      },
    });

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "jwt" }),
      listProjectServersOperation,
      { project: "Demo" }
    )) as ToolResult;

    expect(result.isError).toBeUndefined();
    const permalinks = (
      result.structuredContent as { permalinks: Array<Record<string, unknown>> }
    ).permalinks;
    expect(permalinks.map((permalink) => permalink.url)).toEqual([
      "https://staging.example.com/servers/srv_1?project=proj_demo",
      "https://staging.example.com/servers/srv_2?project=proj_demo",
    ]);
    // Correlated by resource, not by array position.
    expect(permalinks[0]!.resource).toEqual({
      type: "project_server",
      id: "srv_1",
    });
  });

  it("leads the text fallback with the links, because hosts vary", async () => {
    stubPlatformFetch({
      "/projects": { items: [{ id: "proj_demo", name: "Demo", updatedAt: 2 }] },
      "/projects/proj_demo/servers": {
        items: [{ id: "srv_1", name: "Asana", projectId: "proj_demo" }],
      },
    });

    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "jwt" }),
      listProjectServersOperation,
      {}
    )) as ToolResult;

    const text = (result.content?.[0] as { text: string }).text;
    // First, so truncation of a large list cannot cut it.
    expect(text.startsWith("Open Asana: ")).toBe(true);
    expect(text).toContain(
      "https://staging.example.com/servers/srv_1?project=proj_demo"
    );
  });

  it("honors a staging app origin rather than the hosted default", async () => {
    stubPlatformFetch({
      "/projects": { items: [{ id: "proj_demo", name: "Demo", updatedAt: 2 }] },
      "/projects/proj_demo/servers": {
        items: [{ id: "srv_1", name: "Asana", projectId: "proj_demo" }],
      },
    });

    const result = (await runPlatformOperation(
      fakeToolContext({
        bearerToken: "jwt",
        appOrigin: "http://localhost:6274",
      }),
      listProjectServersOperation,
      {}
    )) as ToolResult;

    const permalinks = (
      result.structuredContent as { permalinks: Array<{ url: string }> }
    ).permalinks;
    expect(permalinks[0]!.url).toBe(
      "http://localhost:6274/servers/srv_1?project=proj_demo"
    );
  });
});

/**
 * What a run launched through this worker calls itself.
 *
 * The platform stamps `source: "api"` on everything that arrives over the
 * public API, so an agent's eval run was indistinguishable from a script's in
 * the Runs table. The worker declares `mcp` — a display label beside the stamp,
 * never an authorization input — and names the calling agent when the request
 * did.
 */
describe("the worker's declared launcher", () => {
  const RUN_LAUNCH_HEADER = "x-mcpjam-launcher";

  /**
   * A launch makes three requests — resolve the project, resolve the suite,
   * then POST the run — so the stub answers by path. Returning one shape for
   * all three would abort at the first resolution and never reach the call
   * whose headers these tests are about.
   */
  function captureHeaders(): {
    launchHeaders: () => Record<string, string> | undefined;
    fetchMock: ReturnType<typeof vi.fn>;
  } {
    let launch: Record<string, string> | undefined;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
      if (path.endsWith("/eval-runs") && init?.method === "POST") {
        launch = headers;
        return Response.json({ runId: "run_1", suiteId: "suite_1" });
      }
      if (path.endsWith("/eval-suites")) {
        return Response.json({
          items: [{ id: "suite_1", name: "s1", projectId: "proj_1" }],
        });
      }
      return Response.json({
        items: [{ id: "proj_1", name: "p1", updatedAt: 1 }],
      });
    });
    return { launchHeaders: () => launch, fetchMock };
  }

  it("declares mcp, and names the agent from the request's user-agent", async () => {
    const { launchHeaders, fetchMock } = captureHeaders();
    vi.stubGlobal("fetch", fetchMock);

    await runPlatformOperation(
      fakeToolContext({
        bearerToken: "user-jwt",
        callerUserAgent: "claude-code/1.2.3",
      }),
      runEvalSuiteOperation,
      { project: "p1", suite: "s1" } as never
    );

    const launch = launchHeaders();
    expect(launch).toBeDefined();
    expect(JSON.parse(launch![RUN_LAUNCH_HEADER]!)).toEqual({
      kind: "mcp",
      client: "claude-code/1.2.3",
    });
  });

  it("still declares mcp when the request named no agent", async () => {
    const { launchHeaders, fetchMock } = captureHeaders();
    vi.stubGlobal("fetch", fetchMock);

    await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      runEvalSuiteOperation,
      { project: "p1", suite: "s1" } as never
    );

    const launch = launchHeaders();
    // A missing user-agent leaves the launcher UNNAMED, never guessed: the
    // kind is what the worker knows for itself.
    expect(JSON.parse(launch![RUN_LAUNCH_HEADER]!)).toEqual({ kind: "mcp" });
  });

  it("accepts several selections of one model as per-target compose cells", () => {
    const effort = (reasoningEffort: "low" | "high") => ({
      modelId: "anthropic/claude-sonnet-4.5",
      source: "hosted",
      settings: { reasoningEffort },
      fallback: { provider: "none", model: "none" },
    });
    const schema = runEvalSuiteOperation.inputSchema as unknown as {
      safeParse(value: unknown): {
        success: boolean;
        data?: { compose?: Parameters<typeof expandComposeModelChoices>[0] };
      };
    };
    const parsed = schema.safeParse({
      project: "p1",
      suite: "s1",
      compose: {
        host: "Claude Code",
        serverGroup: "group-1",
        modelSelections: [effort("low"), effort("high")],
      },
    });
    expect(parsed.success).toBe(true);
    expect(
      expandComposeModelChoices(parsed.data!.compose!).map(
        (choice) => choice.selection?.settings?.reasoningEffort
      )
    ).toEqual(["low", "high"]);
  });

  it("is not a field an agent can set through the tool's own input", async () => {
    // An operation's `inputSchema` is exposed verbatim as the MCP tool's input.
    // A launcher field there would let the agent whose run it is pick its own
    // badge — which is why this is a client option instead.
    const shape = (
      runEvalSuiteOperation.inputSchema as unknown as {
        shape?: Record<string, unknown>;
      }
    ).shape;
    expect(shape).toBeDefined();
    expect(Object.keys(shape!)).not.toContain("launcher");
  });
});

// Claude's directory review rejects server text that steers the model toward
// a tool the user did not ask for. Error results used to close with "report it
// with send_feedback"; they now carry the failure and nothing else.
describe("tool errors carry no unsolicited send_feedback suggestion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function failWith(
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        body === undefined
          ? new Response("upstream exploded", { status, headers })
          : Response.json(body, { status, headers })
      )
    );
  }

  async function listProjectsText(): Promise<string> {
    const result = (await runPlatformOperation(
      fakeToolContext({ bearerToken: "user-jwt" }),
      listProjectsOperation,
      {}
    )) as ToolResult;
    expect(result.isError).toBe(true);
    return result.content[0]!.text;
  }

  it("reports an internal error with its request id and nothing else", async () => {
    failWith(
      500,
      { code: "INTERNAL_ERROR", message: "Something broke" },
      { "x-request-id": "req_0123456789abcdef" }
    );
    expect(await listProjectsText()).toBe(
      "INTERNAL_ERROR: Something broke (request id: req_0123456789abcdef)"
    );
  });

  it("reports a missing capability without suggesting a report", async () => {
    failWith(422, {
      code: "FEATURE_NOT_SUPPORTED",
      message: "This server does not support tasks.",
    });
    expect(await listProjectsText()).toBe(
      "FEATURE_NOT_SUPPORTED: This server does not support tasks."
    );
  });

  it("still describes where send_feedback's text goes, without steering the agent", () => {
    const { registrar, registrations } = fakeRegistrar();
    registerPlatformCatalogTools(
      registrar,
      fakeToolContext({ bearerToken: "jwt" })
    );
    const description = String(
      registrations.find((registration) => registration.name === "send_feedback")
        ?.config.description
    );
    expect(description).toContain("SENDS YOUR TEXT TO THE MCPJAM TEAM");
    expect(description).not.toContain("HINT:");
    expect(description).not.toContain("continue with the user's original task");
  });
});


describe("list_models on this surface", () => {
  it("keeps what choosing a model needs and names what it drops", () => {
    const full = {
      items: [
        {
          id: "amazon/nova-2-lite",
          canonical_slug: "amazon/nova-2-lite",
          name: "Nova 2 Lite",
          pricing: { prompt: "3e-7", completion: "0.0000025", image: "0" },
          context_length: 1_000_000,
          architecture: {
            modality: "text+image->text",
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
          },
          top_provider: { context_length: 1_000_000 },
          supported_parameters: ["max_tokens", "tools", "reasoning"],
          description: "x".repeat(500),
          providerSource: "gateway",
          guestAllowed: false,
          deprecated_at: null,
          observations: { tools: { status: "supported", observedAt: 1 } },
        },
      ],
    };
    const compact = compactModelCatalogForModel(full) as {
      items: Array<Record<string, unknown>>;
      compacted: { omittedFields: string[] };
    };
    expect(compact.items).toEqual([
      {
        id: "amazon/nova-2-lite",
        name: "Nova 2 Lite",
        providerSource: "gateway",
        contextLength: 1_000_000,
        pricingPerToken: { prompt: "3e-7", completion: "0.0000025" },
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsTools: true,
        guestAllowed: false,
      },
    ]);
    expect(compact.compacted.omittedFields).toContain("observations");
    expect(JSON.stringify(compact).length).toBeLessThan(
      JSON.stringify(full).length / 2
    );
  });

  it("leaves a payload without items alone", () => {
    const payload = { error: "x" };
    expect(compactModelCatalogForModel(payload)).toBe(payload);
  });
});
