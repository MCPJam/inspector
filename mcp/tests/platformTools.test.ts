import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_OPERATIONS,
  getPluginVersionOperation,
  listProjectPluginsOperation,
  listProjectServersOperation,
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
  };
}

const WIDGET_TOOLS: Record<string, keyof typeof PLATFORM_WIDGET_RESOURCE_URIS> =
  {
    list_eval_suites: "eval_suites",
    list_eval_suite_runs: "eval_suite_runs",
    get_eval_run: "eval_run",
    list_eval_run_iterations: "eval_run_iterations",
    list_scenarios: "scenarios",
    get_scenario: "scenario",
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
  // The render verdict is structured evidence (tree, console errors, blocked
  // requests). A widget PANEL here would be a second, drifting copy of the
  // Apps tab.
  "render_server_widget",
  "list_server_prompts",
  "get_server_prompt",
  "list_server_resources",
  "read_server_resource",
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
  "delete_eval_suite",
  "set_eval_suite_schedule",
  "list_eval_cases",
  "get_eval_case",
  "create_eval_case",
  "create_eval_cases",
  "update_eval_case",
  "delete_eval_case",
  "generate_eval_cases",
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
  "get_eval_iteration_trace",
  "compare_eval_run",
  // The gate-waiver read: an agent-oriented payload, no widget view.
  "get_eval_gate_waiver",
  "get_eval_run_steps",
  "cancel_eval_run",
  "request_eval_run_judge",
  // GitHub Checks: agent-oriented payloads, no widget view.
  "list_eval_check_repos",
  "connect_eval_check_repo",
  "list_chat_sessions",
  "search_sessions",
  // Agent Playground: the turn plus its two reads. Agent-oriented payloads —
  // a trace panel would be a second, drifting copy of the eval trace viewer.
  "send_chat_message",
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
      const description = String(byName.get(operation.name)?.config.description);
      expect(description.includes("COSTS MONEY")).toBe(
        operation.risk === "spend"
      );
    }
    // The two eval launches are the ones this exists for.
    expect(String(byName.get("run_eval_suite")?.config.description)).toContain(
      "COSTS MONEY"
    );
    expect(String(byName.get("list_eval_suites")?.config.description)).not.toContain(
      "COSTS MONEY"
    );
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
      "render_server_widget",
      "list_server_prompts",
      "get_server_prompt",
      "list_server_resources",
      "read_server_resource",
      "check_host_compatibility",
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
      "run_eval_case",
      "run_eval_suite",
      "create_eval_suite",
      "get_eval_suite",
      "get_eval_run_disclosure",
      "update_eval_suite",
      "delete_eval_suite",
      "set_eval_suite_schedule",
      "set_eval_suite_environments",
      "list_eval_cases",
      "get_eval_case",
      "create_eval_case",
      "create_eval_cases",
      "update_eval_case",
      "delete_eval_case",
      "generate_eval_cases",
      "get_eval_run",
      "compare_eval_run",
      "get_eval_gate_waiver",
      "list_eval_run_iterations",
      "get_eval_iteration_trace",
      "get_eval_run_steps",
      "cancel_eval_run",
      "request_eval_run_judge",
      "list_eval_check_repos",
      "connect_eval_check_repo",
      "list_project_environments",
      "get_project_environment",
      "resolve_project_environment",
      "ensure_adhoc_environment",
      "list_sandbox_images",
      "get_sandbox_image",
      "list_project_plugins",
      "get_plugin_version",
      "list_scenarios",
      "get_scenario",
      "list_chat_sessions",
      "search_sessions",
      "send_chat_message",
      "get_chat_session",
      "get_chat_session_trace",
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
      // Starting dials a third party's server and can spend; cancelling stops
      // one. Neither destroys a record, so both annotate as plain writes.
      "start_claude_readiness_run",
      "start_openai_readiness_run",
      "start_conformance_run",
      "cancel_readiness_run",
      "run_eval_case",
      "run_eval_suite",
      "create_eval_suite",
      "update_eval_suite",
      "set_eval_suite_schedule",
      "set_eval_suite_environments",
      "create_eval_case",
      "create_eval_cases",
      "update_eval_case",
      "generate_eval_cases",
      // Grading SPENDS but writes only an advisory result onto the run — the
      // deterministic verdict stays authoritative, so nothing is destroyed.
      "request_eval_run_judge",
      // Additive: it creates a repository connection. Its hazard is REACH (a
      // shared repository, everyone's pull requests), not destruction — the
      // annotation says write, and the gated tier is what warns.
      "connect_eval_check_repo",
      // Content-addressed mint: repeating the same stack reuses one row.
      // Nothing is destroyed and nothing is named.
      "ensure_adhoc_environment",
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
      // Install writes a servers row + provenance. Not a live connection and
      // not a removal — exposure is the risk, announced as a plain write.
      "install_registry_directory_server",
      "install_registry_server",
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
      // Client authoring, the ADDITIVE half. Both mint a new client and change
      // nothing that exists — which is exactly what separates them from
      // `update_client` / `set_client_servers` below.
      "create_client",
      "duplicate_client",
    ]);
    // Destructive AND not safe to repeat — for opposite reasons: the soft
    // deletes 404 on a retry, the rotation mints another link.
    const NON_IDEMPOTENT_DESTRUCTIVE = new Set([
      // Executes the caller's tool before rendering, and nobody can promise
      // that running a third party's tool twice is safe.
      "render_server_widget",
      "delete_persona",
      "archive_journey",
      "archive_swarm",
      "remove_user_testing_member",
      "rotate_user_testing_link",
    ]);
    const DESTRUCTIVE_OPS = new Set([
      // `risk: "destructive"` is the CONSERVATIVE reading of an unknowable
      // effect, not a claim that this removes a specific record. Overclaiming
      // destructiveness is the safe direction, and it matches what the spec
      // tells a client to assume when the hints are absent anyway.
      "render_server_widget",
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
      "uninstall_registry_server",
      // Client edits: DETERMINISTIC OVERWRITES. `destructiveHint: true` here is
      // not "this is a deletion" — the taxonomy is "removes or invalidates
      // something that existed", and replacing a live setting (or a server set,
      // where every omitted server is detached) does exactly that. They stay in
      // the catalog anyway, behind compare-and-set; `delete_client` does not,
      // because it removes the client identity itself. They ARE idempotent:
      // applying the same `set` twice against the same `expectedConfigId`
      // conflicts on the second call rather than compounding, and applying it
      // to the already-edited config is a no-op.
      "update_client",
      "set_client_servers",
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
      } else if (
        registration.name === "call_server_tool" ||
        // A turn under `toolMode: "auto"` executes arbitrary third-party
        // tools with the MODEL choosing the arguments, so its effects are no
        // more knowable than a direct call's. Same absent hints, same reason.
        registration.name === "send_chat_message"
      ) {
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
      "/scenarios": {
        items: [
          {
            id: "scenario-1",
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
      (candidate) => candidate.name === "list_scenarios"
    )!;

    const tagged = (await registration.ui!.callback!({})) as ToolResult;
    expect(tagged.isError).toBeUndefined();
    expect(tagged.structuredContent?.widget).toBe("scenarios");
    expect(jsonBodyOf(tagged).widget).toBe("scenarios");

    const plain = (await registration.callback({})) as ToolResult;
    expect(plain.isError).toBeUndefined();
    expect(plain.structuredContent).not.toHaveProperty("widget");
    expect(jsonBodyOf(plain)).not.toHaveProperty("widget");
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
