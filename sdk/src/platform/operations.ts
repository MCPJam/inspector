/**
 * Curated, task-shaped operations over the Platform API. Each operation is
 * defined once and adapted per surface: MCP worker tools, CLI commands, and
 * (later) in-product agent tools. Names follow the built-in tool id
 * convention (`^[a-z][a-z0-9_]{0,63}$`) so they can be registered in the
 * product catalog unchanged.
 */
import { z } from "zod";
import type { PlatformApiClient } from "./client.js";
import { PlatformApiError } from "./errors.js";
import { HOST_TEMPLATE_IDS } from "../host-config/templates/index.js";
import {
  evaluateMarketHosts,
  scanWidgetUsage,
  type CompatFinding,
  type CompatProvenance,
  type CompatVerdict,
  type HostCompatToolsInput,
  type ReadResourceResult,
} from "../host-compat/index.js";
import {
  buildShowServersPayload,
  projectResolutionError,
  resolveProject,
  type ProjectInfo,
  type SelectedProjectInfo,
  type ShowServersPayload,
} from "./show-servers.js";
import type {
  PlatformChatbox,
  PlatformChatboxDetail,
  PlatformChatSession,
  PlatformDoctorReport,
  PlatformEvalCase,
  PlatformEvalCaseDeleted,
  PlatformEvalCasesGenerated,
  PlatformEvalIteration,
  PlatformEvalStepResult,
  PlatformEvalRun,
  PlatformEvalRunCreated,
  PlatformEvalSuite,
  PlatformEvalSuiteCreated,
  PlatformEvalSuiteDeleted,
  PlatformEvalSuiteDetail,
  PlatformComputerAttached,
  PlatformComputerReset,
  PlatformEnvironment,
  PlatformEnvironmentBuild,
  PlatformEnvironmentBuildStarted,
  PlatformEnvironmentDeleted,
  PlatformHost,
  PlatformHostDeleted,
  PlatformHostDetail,
  PlatformPage,
  PlatformProject,
  PlatformProjectServer,
  PlatformTunnelGrant,
} from "./types.js";

export interface PlatformOperationContext {
  client: PlatformApiClient;
  signal?: AbortSignal;
}

export interface PlatformOperation<TInput, TOutput> {
  /** Stable wire id; doubles as the MCP/AI-SDK tool name. */
  name: string;
  title: string;
  description: string;
  /**
   * Whether the operation only reads platform state. Surfaces map this to
   * their own affordances (MCP `readOnlyHint`, CLI confirmation prompts).
   */
  readOnly: boolean;
  /**
   * True when a non-read operation's effects are unknowable upstream of the
   * call (call_server_tool runs arbitrary third-party tools). Surfaces must
   * not soften the destructive default for these — MCP clients assume
   * destructive when the hint is absent, and that absence is the honest
   * claim here.
   */
  mayBeDestructive?: boolean;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, context: PlatformOperationContext): Promise<TOutput>;
}

const PROJECT_SELECTOR_DESCRIPTION =
  "Project name or ID. Defaults to the most recently updated accessible project.";

const listProjectsInput = z.object({
  organizationId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Restrict the listing to one organization."),
});

export type ListProjectsInput = z.infer<typeof listProjectsInput>;

export const listProjectsOperation: PlatformOperation<
  ListProjectsInput,
  PlatformPage<PlatformProject>
> = {
  name: "list_projects",
  title: "List MCPJam projects",
  description:
    "List the MCPJam projects the caller can access, most recently updated first.",
  readOnly: true,
  inputSchema: listProjectsInput,
  async execute(input, { client, signal }) {
    const page = await client.listProjects(
      { organizationId: input.organizationId },
      { signal }
    );
    const resolution = resolveProject(page.items);
    return {
      ...page,
      items: resolution.ok ? resolution.sortedProjects : page.items,
    };
  },
};

const projectScopedInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
});

export type ProjectScopedInput = z.infer<typeof projectScopedInput>;

export type ListProjectServersResult = {
  project: SelectedProjectInfo;
  items: PlatformProjectServer[];
  otherProjects: ProjectInfo[];
};

export const listProjectServersOperation: PlatformOperation<
  ProjectScopedInput,
  ListProjectServersResult
> = {
  name: "list_project_servers",
  title: "List MCPJam project servers",
  description:
    "List the MCP servers saved in an MCPJam project. If no project is specified, uses the most recently updated accessible project and returns other project names for switching.",
  readOnly: true,
  inputSchema: projectScopedInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const page = await client.listProjectServers(
      { projectId: project.id },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

export const showServersOperation: PlatformOperation<
  ProjectScopedInput,
  ShowServersPayload
> = {
  name: "show_servers",
  title: "Show MCPJam servers",
  description:
    "Show all MCP servers in a project with their health status. If no project is specified, shows the most recently updated accessible project and returns other project names for switching.",
  readOnly: true,
  inputSchema: projectScopedInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const page = await client.listProjectServers(
      { projectId: project.id },
      { signal }
    );
    return buildShowServersPayload({
      doctor: (args) =>
        client.doctorServer(
          { projectId: args.projectId, serverId: args.serverId },
          { signal: args.signal }
        ),
      project,
      projects: sortedProjects,
      servers: page.items,
      generatedAt: new Date().toISOString(),
      signal,
    });
  },
};

async function resolveProjectOrThrow(
  client: PlatformApiClient,
  selector: string | undefined,
  signal: AbortSignal | undefined
): Promise<{ project: PlatformProject; sortedProjects: PlatformProject[] }> {
  const page = await client.listProjects({}, { signal });
  const resolution = resolveProject(page.items, selector);
  if (!resolution.ok) {
    throw projectResolutionError(resolution.message);
  }
  return {
    project: resolution.project,
    sortedProjects: resolution.sortedProjects,
  };
}

// ── Named-resource resolution ────────────────────────────────────────

/**
 * Resolve a suite/chatbox/server selector against a project listing the same
 * way `resolveProject` works: exact id first, then unique case-insensitive
 * name. Failures become NOT_FOUND platform errors whose message enumerates
 * the valid choices, so every surface renders the same actionable text.
 */
function resolveByIdOrName<T extends { id: string; name?: string | null }>(
  items: T[],
  selector: string,
  kind: string,
  scope: string
): T {
  const trimmedSelector = selector.trim();
  const idMatch = items.find((item) => item.id === trimmedSelector);
  if (idMatch) {
    return idMatch;
  }

  const normalizedSelector = trimmedSelector.toLocaleLowerCase();
  const nameMatches = items.filter(
    (item) => item.name?.toLocaleLowerCase() === normalizedSelector
  );

  if (nameMatches.length === 1) {
    return nameMatches[0]!;
  }

  if (nameMatches.length > 1) {
    throw resolutionError(
      `${kind} name "${trimmedSelector}" is ambiguous in ${scope}. Use one of these IDs: ${formatResourceList(
        nameMatches
      )}.`
    );
  }

  throw resolutionError(
    items.length > 0
      ? `${kind} "${trimmedSelector}" was not found in ${scope}. Available: ${formatResourceList(
          items
        )}.`
      : `${kind} "${trimmedSelector}" was not found: ${scope} has none.`
  );
}

function formatResourceList(
  items: Array<{ id: string; name?: string | null }>
): string {
  return items
    .map((item) => `${item.name ?? "(unnamed)"} (id: ${item.id})`)
    .join(", ");
}

function resolutionError(message: string): PlatformApiError {
  return new PlatformApiError(message, "NOT_FOUND", { status: 0 });
}

function toSelectedProjectInfo(project: PlatformProject): SelectedProjectInfo {
  return {
    id: project.id,
    name: project.name,
    organizationId: project.organizationId ?? "",
  };
}

function toOtherProjects(
  sortedProjects: PlatformProject[],
  selectedId: string
): ProjectInfo[] {
  return sortedProjects
    .filter((candidate) => candidate.id !== selectedId)
    .map((candidate) => ({ id: candidate.id, name: candidate.name }));
}

// ── Server live operations ───────────────────────────────────────────
// Live MCP ops against one saved server: the platform authorizes the caller,
// opens an ephemeral connection, runs the op, and disconnects. The server is
// matched by name or ID within the project, like suites and chatboxes.

const SERVER_SELECTOR_DESCRIPTION =
  "Server name or ID, as saved in the project.";

const serverScopedInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  server: z.string().trim().min(1).describe(SERVER_SELECTOR_DESCRIPTION),
});

export type ServerScopedInput = z.infer<typeof serverScopedInput>;

export type ResolvedServerInfo = { id: string; name: string };

/**
 * Resolve a server selector and require it to be hosted-operable: live ops
 * connect from the hosted runtime, which can never spawn stdio servers.
 * Failing here is deterministic and names the reason, instead of a
 * downstream connect error.
 */
async function resolveLiveServer(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined
): Promise<PlatformProjectServer> {
  const page = await client.listProjectServers(
    { projectId: project.id },
    { signal }
  );
  const server = resolveByIdOrName(
    page.items,
    selector,
    "Server",
    `project "${project.name}"`
  );
  if (server.transportType === "stdio" || !server.url) {
    throw resolutionError(
      `Server "${selector.trim()}" can't run hosted operations: ${
        server.transportType === "stdio"
          ? "stdio servers are not supported on the hosted platform"
          : "it has no URL"
      }.`
    );
  }
  return server;
}

function toServerInfo(server: PlatformProjectServer): ResolvedServerInfo {
  return { id: server.id, name: server.name };
}

export type DiagnoseServerResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  report: PlatformDoctorReport;
};

export const diagnoseServerOperation: PlatformOperation<
  ServerScopedInput,
  DiagnoseServerResult
> = {
  name: "diagnose_server",
  title: "Diagnose MCPJam server",
  description:
    "Diagnose a saved MCP server's connection: probe the URL, connect, initialize, and report capabilities and what failed. Use when a server is erroring, won't connect, or to check its health.",
  readOnly: true,
  inputSchema: serverScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    const report = await client.doctorServer(
      { projectId: project.id, serverId: server.id },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      report,
    };
  },
};

const PAGE_CURSOR_DESCRIPTION =
  "Opaque pagination cursor from a previous response.";

const serverPagedInput = serverScopedInput.extend({
  cursor: z.string().min(1).optional().describe(PAGE_CURSOR_DESCRIPTION),
});

export type ServerPagedInput = z.infer<typeof serverPagedInput>;

export type ServerPagedResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  items: Array<Record<string, unknown>>;
  nextCursor?: string;
};

/** Shared body for the three paged listings (tools/prompts/resources). */
async function runServerListing(
  input: ServerPagedInput,
  context: PlatformOperationContext,
  list: (
    scope: { projectId: string; serverId: string },
    body: Record<string, unknown>
  ) => Promise<PlatformPage<Record<string, unknown>>>
): Promise<ServerPagedResult> {
  const { client, signal } = context;
  const { project } = await resolveProjectOrThrow(
    client,
    input.project,
    signal
  );
  const server = await resolveLiveServer(client, project, input.server, signal);
  const page = await list(
    { projectId: project.id, serverId: server.id },
    input.cursor ? { cursor: input.cursor } : {}
  );
  return {
    project: toSelectedProjectInfo(project),
    server: toServerInfo(server),
    items: page.items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export const listServerToolsOperation: PlatformOperation<
  ServerPagedInput,
  ServerPagedResult
> = {
  name: "list_server_tools",
  title: "List MCPJam server tools",
  description:
    "List the tools a saved MCP server exposes: names, descriptions, and input schemas. Use before call_server_tool to find the tool name and required parameters. Paginated — pass nextCursor back as cursor for the next page.",
  readOnly: true,
  inputSchema: serverPagedInput,
  async execute(input, context) {
    return runServerListing(input, context, (scope, body) =>
      context.client.listServerTools(
        { ...scope, body },
        { signal: context.signal }
      )
    );
  },
};

export const listServerPromptsOperation: PlatformOperation<
  ServerPagedInput,
  ServerPagedResult
> = {
  name: "list_server_prompts",
  title: "List MCPJam server prompts",
  description:
    "List the prompts a saved MCP server exposes: names, descriptions, and arguments. Use before get_server_prompt to find the prompt name and its arguments. Paginated — pass nextCursor back as cursor for the next page.",
  readOnly: true,
  inputSchema: serverPagedInput,
  async execute(input, context) {
    return runServerListing(input, context, (scope, body) =>
      context.client.listServerPrompts(
        { ...scope, body },
        { signal: context.signal }
      )
    );
  },
};

export const listServerResourcesOperation: PlatformOperation<
  ServerPagedInput,
  ServerPagedResult
> = {
  name: "list_server_resources",
  title: "List MCPJam server resources",
  description:
    "List the resources a saved MCP server exposes: uris, names, and mime types. Use before read_server_resource to find the resource uri. Paginated — pass nextCursor back as cursor for the next page.",
  readOnly: true,
  inputSchema: serverPagedInput,
  async execute(input, context) {
    return runServerListing(input, context, (scope, body) =>
      context.client.listServerResources(
        { ...scope, body },
        { signal: context.signal }
      )
    );
  },
};

const callServerToolInput = serverScopedInput.extend({
  toolName: z
    .string()
    .trim()
    .min(1)
    .describe("Exact tool name to execute, as returned by list_server_tools."),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Tool arguments matching the tool's input schema."),
});

export type CallServerToolInput = z.infer<typeof callServerToolInput>;

export type CallServerToolResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  result: Record<string, unknown>;
};

export const callServerToolOperation: PlatformOperation<
  CallServerToolInput,
  CallServerToolResult
> = {
  name: "call_server_tool",
  title: "Call MCPJam server tool",
  description:
    "Execute a tool on a saved MCP server and return its result. Runs with the caller's own authorization and may have side effects on the server. Get the tool name and parameter schema from list_server_tools first.",
  readOnly: false,
  mayBeDestructive: true,
  inputSchema: callServerToolInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    const result = await client.callServerTool(
      {
        projectId: project.id,
        serverId: server.id,
        body: {
          toolName: input.toolName,
          parameters: input.parameters ?? {},
        },
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      result,
    };
  },
};

const getServerPromptInput = serverScopedInput.extend({
  promptName: z
    .string()
    .trim()
    .min(1)
    .describe("Exact prompt name, as returned by list_server_prompts."),
  arguments: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Prompt arguments, if the prompt declares any."),
});

export type GetServerPromptInput = z.infer<typeof getServerPromptInput>;

export type GetServerPromptResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  result: Record<string, unknown>;
};

export const getServerPromptOperation: PlatformOperation<
  GetServerPromptInput,
  GetServerPromptResult
> = {
  name: "get_server_prompt",
  title: "Get MCPJam server prompt",
  description:
    "Render a prompt from a saved MCP server with the given arguments and return its messages. Get the prompt name and argument list from list_server_prompts first.",
  readOnly: true,
  inputSchema: getServerPromptInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    const result = await client.getServerPrompt(
      {
        projectId: project.id,
        serverId: server.id,
        body: {
          promptName: input.promptName,
          ...(input.arguments ? { arguments: input.arguments } : {}),
        },
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      result,
    };
  },
};

const readServerResourceInput = serverScopedInput.extend({
  uri: z
    .string()
    .trim()
    .min(1)
    .describe("Exact resource uri, as returned by list_server_resources."),
});

export type ReadServerResourceInput = z.infer<typeof readServerResourceInput>;

export type ReadServerResourceResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  result: Record<string, unknown>;
};

export const readServerResourceOperation: PlatformOperation<
  ReadServerResourceInput,
  ReadServerResourceResult
> = {
  name: "read_server_resource",
  title: "Read MCPJam server resource",
  description:
    "Read one resource from a saved MCP server by uri and return its contents. Get the uri from list_server_resources first.",
  readOnly: true,
  inputSchema: readServerResourceInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    const result = await client.readServerResource(
      {
        projectId: project.id,
        serverId: server.id,
        body: { uri: input.uri },
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      result,
    };
  },
};

// ── Host compatibility ───────────────────────────────────────────────

export type HostCompatibilityVerdict = {
  hostId: string;
  hostLabel: string;
  /** Worst-wins aggregate across the apps + server lanes. */
  verdict: CompatVerdict;
  /** Weakest source backing this host's facts. */
  provenance: CompatProvenance;
  /** Machine-readable findings (each carries a stable `code`). */
  findings: CompatFinding[];
};

export type CheckHostCompatibilityResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  /** What the server demands, summarized. */
  widgets: { total: number; appOnly: number };
  /** Dimensions that couldn't be analyzed (e.g. unreadable widget HTML). */
  unknownDimensions: string[];
  hosts: HostCompatibilityVerdict[];
};

// Bound the tools pagination so a pathological server can't loop forever.
const HOST_COMPAT_TOOLS_PAGE_CAP = 50;

export const checkHostCompatibilityOperation: PlatformOperation<
  ServerScopedInput,
  CheckHostCompatibilityResult
> = {
  name: "check_host_compatibility",
  title: "Check MCP host compatibility",
  description:
    "Check whether a saved MCP server's tools and widgets work on each AI host (Claude, ChatGPT, Cursor, Copilot, Codex, Goose, Mistral, n8n, Perplexity, Cline). Returns a per-host verdict (works / degraded / blocked / unknown) with the specific findings — e.g. a widget a host can't render, or a host API a widget needs that the host lacks.",
  readOnly: true,
  inputSchema: serverScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const server = await resolveLiveServer(client, project, input.server, signal);
    const scope = { projectId: project.id, serverId: server.id };

    // Gather every tool (with its inline `_meta`) across all pages.
    const rawTools: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < HOST_COMPAT_TOOLS_PAGE_CAP; page++) {
      const result = await client.listServerTools(
        { ...scope, body: cursor ? { cursor } : {} },
        { signal }
      );
      rawTools.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor) break;
      // Hit the cap with tools still pending — don't pretend the report is
      // complete (a later page could hold widgets that change a verdict).
      if (page === HOST_COMPAT_TOOLS_PAGE_CAP - 1) truncated = true;
    }

    const toolsData: HostCompatToolsInput = {
      tools: rawTools.map((tool) => ({
        name: String(tool.name),
        _meta: tool._meta as Record<string, unknown> | undefined,
      })),
    };

    // Apps lane: read each widget's resource through the platform and scan it.
    const widgetUsage = await scanWidgetUsage(
      toolsData,
      async (uri) =>
        (await client.readServerResource(
          { ...scope, body: { uri } },
          { signal }
        )) as ReadResourceResult
    );

    // `toolsTruncated` makes the engine demote any `works` to `unknown` and add
    // the explaining dimension — verdicts never read complete when they aren't.
    const { requirements, reports } = evaluateMarketHosts(toolsData, {
      widgetUsage,
      toolsTruncated: truncated,
    });

    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      widgets: {
        total:
          requirements.widgets.mcpAppsOnly.length +
          requirements.widgets.openaiAppsOnly.length +
          requirements.widgets.dual.length,
        appOnly: requirements.appOnlyWidgets.length,
      },
      unknownDimensions: requirements.unknownDimensions,
      hosts: reports.map((report) => ({
        hostId: report.hostId,
        hostLabel: report.hostLabel,
        verdict: report.verdict,
        provenance: report.provenance,
        findings: report.findings,
      })),
    };
  },
};

// ── Eval operations ──────────────────────────────────────────────────

const SUITE_SELECTOR_DESCRIPTION = "Eval suite name or ID.";
// Unlike the listing operations, the run-polling reads do NOT default the
// project: a run is an existing resource in one specific project, and
// guessing "most recently updated" makes a run in any other project read as
// NOT_FOUND. run_eval_suite and list_eval_suite_runs return the resolved
// project precisely so callers can address the polls exactly.
const RUN_PROJECT_DESCRIPTION =
  "Project the run belongs to (name or ID), as returned by run_eval_suite or list_eval_suite_runs.";

export type ListEvalSuitesResult = {
  project: SelectedProjectInfo;
  items: PlatformEvalSuite[];
  otherProjects: ProjectInfo[];
};

export const listEvalSuitesOperation: PlatformOperation<
  ProjectScopedInput,
  ListEvalSuitesResult
> = {
  name: "list_eval_suites",
  title: "List MCPJam eval suites",
  description:
    "List the eval suites saved in an MCPJam project, with latest-run summaries and pass-rate trends. If no project is specified, uses the most recently updated accessible project and returns other project names for switching.",
  readOnly: true,
  inputSchema: projectScopedInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const page = await client.listEvalSuites(
      { projectId: project.id },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

const evalSuiteScopedInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of runs to return (newest first)."),
});

export type ListEvalSuiteRunsInput = z.infer<typeof evalSuiteScopedInput>;

export type ListEvalSuiteRunsResult = {
  project: SelectedProjectInfo;
  suite: { id: string; name: string | null };
  items: PlatformEvalRun[];
};

export const listEvalSuiteRunsOperation: PlatformOperation<
  ListEvalSuiteRunsInput,
  ListEvalSuiteRunsResult
> = {
  name: "list_eval_suite_runs",
  title: "List MCPJam eval suite runs",
  description:
    "List recent runs of an eval suite, newest first, with status, pass/fail result, and summary counts. The suite is matched by name or ID within the project.",
  readOnly: true,
  inputSchema: evalSuiteScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const page = await client.listEvalSuiteRuns(
      { projectId: project.id, suiteId: suite.id, limit: input.limit },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      suite: { id: suite.id, name: suite.name },
      items: page.items,
    };
  },
};

const runEvalSuiteInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  servers: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe(
      "Project server names or IDs to override the suite's saved server selection. When omitted, the platform connects exactly the servers the suite was configured with. Naming a server explicitly overrides its disabled toggle — the run connects to it and consumes credits all the same; stdio servers can never run hosted."
    ),
});

export type RunEvalSuiteInput = z.infer<typeof runEvalSuiteInput>;

export type RunEvalSuiteResult = {
  project: SelectedProjectInfo;
  suite: { id: string; name: string | null };
  /** The servers the run connects to; names are included when known. */
  servers: Array<{ id: string; name?: string }>;
  runId: string;
  status: string;
  caseUpsert: PlatformEvalRunCreated["caseUpsert"];
};

export const runEvalSuiteOperation: PlatformOperation<
  RunEvalSuiteInput,
  RunEvalSuiteResult
> = {
  name: "run_eval_suite",
  title: "Run MCPJam eval suite",
  description:
    "Start an asynchronous rerun of an existing eval suite. By default the run connects the suite's saved server selection, resolved by the platform; pass servers only to override it. Returns a runId immediately; poll get_eval_run with the returned project and runId until status is completed, failed, or cancelled. Eval runs execute LLM iterations and consume the organization's credits or configured provider keys.",
  readOnly: false,
  inputSchema: runEvalSuiteInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    // No client-side server default: the platform derives the suite's saved
    // selection when serverIds is omitted — the exact set the run snapshot
    // references, which a project-wide guess here could miss.
    const overrideServers = input.servers
      ? await resolveRunServers(client, project, input.servers, signal)
      : undefined;
    const created = await client.createEvalRun(
      {
        projectId: project.id,
        body: {
          suiteId: suite.id,
          ...(overrideServers
            ? { serverIds: overrideServers.map((server) => server.id) }
            : {}),
        },
      },
      { signal }
    );
    const servers =
      overrideServers?.map((server) => ({
        id: server.id,
        name: server.name,
      })) ??
      (created.servers ?? []).map((server) => ({
        id: server.id,
        ...(server.name ? { name: server.name } : {}),
      }));
    return {
      project: toSelectedProjectInfo(project),
      suite: { id: suite.id, name: suite.name },
      servers,
      runId: created.runId,
      status: created.status,
      caseUpsert: created.caseUpsert,
    };
  },
};

const runEvalCaseInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  case: z
    .string()
    .trim()
    .min(1)
    .describe("The test case to run, by id or title, within the suite."),
  servers: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe(
      "Project server names or IDs to override the suite's saved server selection for this run. When omitted, the platform connects exactly the servers the suite was configured with."
    ),
});

export type RunEvalCaseInput = z.infer<typeof runEvalCaseInput>;

export type RunEvalCaseResult = {
  project: SelectedProjectInfo;
  suite: { id: string; name: string | null };
  case: { id: string; title: string | null };
  servers: Array<{ id: string; name?: string }>;
  runId: string;
  status: string;
};

export const runEvalCaseOperation: PlatformOperation<
  RunEvalCaseInput,
  RunEvalCaseResult
> = {
  name: "run_eval_case",
  title: "Run a single MCPJam eval case",
  description:
    "Start an asynchronous run of ONE case in an existing eval suite — a persisted, fully-queryable run scoped to just that case (inspect it with get_eval_run / list_eval_run_iterations / get_eval_run_steps, same as a full run). Returns a runId immediately; poll get_eval_run until terminal. Consumes credits like any eval run.",
  readOnly: false,
  inputSchema: runEvalCaseInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const testCase = await resolveCase(
      client,
      project,
      suite,
      input.case,
      signal
    );
    const overrideServers = input.servers
      ? await resolveRunServers(client, project, input.servers, signal)
      : undefined;
    const created = await client.createEvalRun(
      {
        projectId: project.id,
        body: {
          suiteId: suite.id,
          caseIds: [testCase.id],
          ...(overrideServers
            ? { serverIds: overrideServers.map((server) => server.id) }
            : {}),
        },
      },
      { signal }
    );
    const servers =
      overrideServers?.map((server) => ({
        id: server.id,
        name: server.name,
      })) ??
      (created.servers ?? []).map((server) => ({
        id: server.id,
        ...(server.name ? { name: server.name } : {}),
      }));
    return {
      project: toSelectedProjectInfo(project),
      suite: { id: suite.id, name: suite.name },
      case: { id: testCase.id, title: testCase.title },
      servers,
      runId: created.runId,
      status: created.status,
    };
  },
};

/**
 * Authored test-step (`TestStep`) input — the unified test model that REPLACES
 * the old `query` / `expectedToolCalls` / `promptTurns` / `caseType` /
 * `probeConfig` authoring fields (see the inspector's `shared/steps.ts`).
 *
 * A case is an ordered `steps` array of:
 *   - `prompt`   — a user message (model-driven turn);
 *   - `toolCall` — a deterministic, model-free tool call (= old widget probe);
 *   - `interact` — one pure widget action (click/type/key/scroll/wait);
 *   - `assert`   — an assertion (a `Predicate` like `toolCalledWith` /
 *                  `widgetRendered`, or a DOM `WidgetAssertion`).
 *
 * Typed permissively here (discriminated only on `kind` + the per-kind core
 * fields); the backend `/api/v1` route validates authoritatively with the
 * shared `stepsSchema`. Declared fully so the body is forwarded verbatim
 * instead of having unknown keys stripped.
 *
 * BREAKING (Phase 2.5): this is a clean break from the old per-case authoring
 * fields. No users existed for the old shape, so no compatibility layer.
 */
const stepInputSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        id: z.string().min(1),
        kind: z.literal("prompt"),
        prompt: z.string(),
      })
      .passthrough(),
    z
      .object({
        id: z.string().min(1),
        kind: z.literal("toolCall"),
        serverId: z.string().min(1).optional(),
        serverName: z.string().min(1),
        toolName: z.string().min(1),
        arguments: z.record(z.string(), z.any()),
        renderTimeoutMs: z.number().int().positive().optional(),
      })
      .passthrough(),
    z
      .object({
        id: z.string().min(1),
        kind: z.literal("interact"),
        toolName: z.string().min(1),
        action: z.record(z.string(), z.any()),
      })
      .passthrough(),
    z
      .object({
        id: z.string().min(1),
        kind: z.literal("assert"),
        assertion: z.record(z.string(), z.any()),
      })
      .passthrough(),
  ])
  .describe("One authored test step (prompt | toolCall | interact | assert).");

const evalCaseInput = z
  .object({
    title: z.string().trim().min(1).describe("Short label for the test case."),
    runs: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Iterations to run this case per eval run. Defaults to 1."),
    steps: z
      .array(stepInputSchema)
      .min(1)
      .describe(
        "Ordered test steps (prompt / toolCall / interact / assert). The first `prompt` step's text is the case query; `toolCalledWith` asserts are the expected tool calls."
      ),
    expectedOutput: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Expected final answer or substring to assert against."),
    isNegativeTest: z
      .boolean()
      .optional()
      .describe("When true, the case passes if the expectation is NOT met."),
    scenario: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional scenario/context note for the case."),
    advancedConfig: z
      .object({
        system: z.string().optional(),
        temperature: z.number().optional(),
        toolChoice: z.any().optional(),
      })
      .passthrough()
      .optional()
      .describe(
        "Per-case system prompt / temperature / tool-choice overrides."
      ),
    matchOptions: z
      .record(z.string(), z.any())
      .optional()
      .describe("Per-case matcher options (advanced)."),
    predicates: z
      .record(z.string(), z.any())
      .optional()
      .describe("Per-case success-predicate gate (advanced)."),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Per-case model override; defaults to the suite-level model."),
    provider: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Per-case provider override; defaults to the suite-level provider."
      ),
  });

const createEvalSuiteInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  name: z.string().trim().min(1).describe("Name for the new eval suite."),
  description: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional human description of what the suite covers."),
  servers: z
    .array(z.string().trim().min(1))
    .min(1)
    .describe(
      "Project server names or IDs the suite runs against. Must be HTTP servers; stdio servers can never run hosted."
    ),
  model: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Suite-level default model applied to every case, e.g. "anthropic/claude-haiku-4.5". Use a hosted model id, or a provider-prefixed id with the matching provider.'
    ),
  provider: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Suite-level default provider. Optional when the model id is provider-prefixed (the provider is derived from the first path segment)."
    ),
  cases: z
    .array(evalCaseInput)
    .min(1)
    // Mirrors the backend MAX_V1_TESTS cap so a guaranteed-413 payload is
    // rejected before the network call.
    .max(100)
    .describe("Authored test cases (1–100)."),
});

export type CreateEvalSuiteInput = z.infer<typeof createEvalSuiteInput>;

export type CreateEvalSuiteResult = {
  project: SelectedProjectInfo;
  suite: { id: string; name: string | null };
  /** The HTTP servers the suite was configured against. */
  servers: Array<{ id: string; name?: string }>;
  caseUpsert: PlatformEvalSuiteCreated["caseUpsert"];
};

export const createEvalSuiteOperation: PlatformOperation<
  CreateEvalSuiteInput,
  CreateEvalSuiteResult
> = {
  name: "create_eval_suite",
  title: "Create MCPJam eval suite",
  description:
    "Create a runnable eval suite from authored test cases. Specify a name, a default model, the project HTTP servers it runs against, and one or more cases. Each case is an ordered `steps` array (prompt / toolCall / interact / assert) plus optional expected-output / negative-test. Returns the new suite id; run it with run_eval_suite. Does NOT run the suite — authoring is free. Servers must be HTTP; stdio servers can never run hosted.",
  readOnly: false,
  inputSchema: createEvalSuiteInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const servers = await resolveRunServers(
      client,
      project,
      input.servers,
      signal
    );
    const created = await client.createEvalSuite(
      {
        projectId: project.id,
        body: {
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          serverIds: servers.map((server) => server.id),
          serverNames: servers.map((server) => server.name),
          model: input.model,
          ...(input.provider ? { provider: input.provider } : {}),
          // Ergonomic case shape; the backend normalizes per-case defaults
          // (runs, model/provider fill, tool-call mapping) into the run schema.
          tests: input.cases,
        },
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      suite: { id: created.suiteId, name: created.name ?? input.name },
      servers: servers.map((server) => ({
        id: server.id,
        name: server.name,
      })),
      caseUpsert: created.caseUpsert,
    };
  },
};

// ── Eval suite + case editing ────────────────────────────────────────
// Public-model operations: callers speak the eval-suite vocabulary (settings,
// checks, judge, match options, environment, hosts, execution config). The
// inspector v1 route layer translates these to the internal Convex model — no
// internal field names cross this boundary.

const CASE_SELECTOR_DESCRIPTION = "Eval case title or ID.";

const publicMatchOptionsSchema = z
  .object({
    toolCallOrder: z
      .enum(["any", "in-order", "exact"])
      .optional()
      .describe(
        "any = order ignored; in-order = expected calls appear in order (extras allowed); exact = exact sequence."
      ),
    extraToolCalls: z
      .union([z.literal("unlimited"), z.number().int().min(0)])
      .optional()
      .describe('"unlimited" or a max count of unexpected extra tool calls.'),
    arguments: z
      .enum(["ignore", "partial", "exact"])
      .optional()
      .describe("Argument comparison strictness."),
  })
  .describe("Tool-call match options.");

const publicCheckSchema = z
  .object({ type: z.string().trim().min(1) })
  .passthrough()
  .describe(
    "A deterministic check; `type` is the check kind (e.g. responseContains, toolCalledWith) and remaining fields depend on it."
  );

const publicCheckOverrideSchema = z
  .object({
    mode: z.enum(["inherit", "replace", "extend"]),
    list: z.array(publicCheckSchema),
  })
  .describe("Per-case check override (how case checks combine with defaults).");

const caseModelSchema = z.object({
  model: z.string().trim().min(1),
  provider: z.string().trim().min(1).optional(),
});

// Per-case editable fields, shared by create and update. All optional so a
// PATCH carries only what changes; create layers required fields on top.
const caseFieldsShape = {
  title: z.string().trim().min(1).optional().describe("Short case label."),
  // The unified test-step model REPLACES the old kind / prompt / turns /
  // expectedToolCalls / renderCheck authoring fields (Phase 2.5 clean break).
  // A `prompt` step is a model turn; a `toolCall` step is a deterministic
  // (formerly render-check) call; `assert` steps hold the expectations.
  steps: z
    .array(stepInputSchema)
    .min(1)
    .optional()
    .describe(
      "Ordered test steps (prompt / toolCall / interact / assert). Replaces the case body wholesale when provided."
    ),
  expectedOutput: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Expected final answer / substring to assert against."),
  iterations: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Iterations to run per eval run. Defaults to 1."),
  isNegative: z
    .boolean()
    .optional()
    .describe("When true, the case passes if the expectation is NOT met."),
  scenario: z.string().trim().min(1).optional(),
  models: z
    .array(caseModelSchema)
    .optional()
    .describe("Execution models for the case (compare runs each model)."),
  // Nullable so an update can CLEAR a per-case override (null) vs leave it
  // untouched (omitted). On create, null is treated as "no override".
  matchOptions: publicMatchOptionsSchema.nullable().optional(),
  checks: publicCheckOverrideSchema.nullable().optional(),
} as const;

/** Build the public case body forwarded to the route (drops undefined keys). */
function buildCaseBody(
  input: Record<string, unknown>
): Record<string, unknown> {
  const keys = Object.keys(caseFieldsShape);
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  return body;
}

const getEvalSuiteInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
});
export type GetEvalSuiteInput = z.infer<typeof getEvalSuiteInput>;

export const getEvalSuiteOperation: PlatformOperation<
  GetEvalSuiteInput,
  PlatformEvalSuiteDetail
> = {
  name: "get_eval_suite",
  title: "Get MCPJam eval suite",
  description:
    "Fetch one eval suite's full settings: environment (servers), execution config (model/system prompt/temperature), hosts, match options, checks, LLM-as-judge, schedule.",
  readOnly: true,
  inputSchema: getEvalSuiteInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.getEvalSuite(
      { projectId: project.id, suiteId: suite.id },
      { signal }
    );
  },
};

const updateEvalSuiteInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().optional(),
  environment: z
    .object({ servers: z.array(z.string().trim().min(1)) })
    .optional()
    .describe("Server selection by name; replaces the suite's server set."),
  executionConfig: z
    .object({
      model: z.string().trim().min(1).optional(),
      systemPrompt: z.string().optional(),
      temperature: z.number().optional(),
    })
    .optional()
    .describe("Suite execution config; unspecified fields are preserved."),
  hosts: z
    .array(
      z.object({
        host: z.string().trim().min(1).describe("Host name or ID."),
        servers: z.array(z.string().trim().min(1)).optional(),
      })
    )
    .optional()
    .describe("Host attachments (replace-all)."),
  settings: z
    .object({
      minimumAccuracy: z.number().min(0).max(100).optional(),
      // Nullable to CLEAR suite defaults (vs omit to leave untouched).
      matchOptions: publicMatchOptionsSchema.nullable().optional(),
      checks: z.array(publicCheckSchema).nullable().optional(),
      judge: z
        .object({
          enabled: z.boolean().optional(),
          model: z.string().trim().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
});
export type UpdateEvalSuiteInput = z.infer<typeof updateEvalSuiteInput>;

export const updateEvalSuiteOperation: PlatformOperation<
  UpdateEvalSuiteInput,
  PlatformEvalSuiteDetail
> = {
  name: "update_eval_suite",
  title: "Update MCPJam eval suite",
  description:
    "Edit an eval suite's settings: name, description, environment servers, execution config (model/system prompt/temperature), hosts, minimum accuracy, match options, checks, and LLM-as-judge. Only the fields you pass change.",
  readOnly: false,
  inputSchema: updateEvalSuiteInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const body: Record<string, unknown> = {};
    for (const key of [
      "name",
      "description",
      "environment",
      "executionConfig",
      "hosts",
      "settings",
    ] as const) {
      if (input[key] !== undefined) body[key] = input[key];
    }
    return client.updateEvalSuite(
      { projectId: project.id, suiteId: suite.id, body },
      { signal }
    );
  },
};

const deleteEvalSuiteInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
});
export type DeleteEvalSuiteInput = z.infer<typeof deleteEvalSuiteInput>;

export const deleteEvalSuiteOperation: PlatformOperation<
  DeleteEvalSuiteInput,
  PlatformEvalSuiteDeleted
> = {
  name: "delete_eval_suite",
  title: "Delete MCPJam eval suite",
  description:
    "Permanently delete an eval suite and all its cases and runs. This cannot be undone.",
  readOnly: false,
  inputSchema: deleteEvalSuiteInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.deleteEvalSuite(
      { projectId: project.id, suiteId: suite.id },
      { signal }
    );
  },
};

const setEvalSuiteScheduleInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  enabled: z.boolean().describe("Turn scheduled runs on or off."),
  intervalMinutes: z
    .number()
    .int()
    .min(5)
    .max(10080)
    .optional()
    .describe(
      "Run interval in minutes (5–10080). Required only when enabling a suite with no saved interval; on re-enable it is reused when omitted."
    ),
});
export type SetEvalSuiteScheduleInput = z.infer<
  typeof setEvalSuiteScheduleInput
>;

export const setEvalSuiteScheduleOperation: PlatformOperation<
  SetEvalSuiteScheduleInput,
  PlatformEvalSuiteDetail
> = {
  name: "set_eval_suite_schedule",
  title: "Set MCPJam eval suite schedule",
  description:
    "Enable or disable automatic scheduled runs for a suite, and set the interval. Disabling preserves the stored interval.",
  readOnly: false,
  inputSchema: setEvalSuiteScheduleInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.setEvalSuiteSchedule(
      {
        projectId: project.id,
        suiteId: suite.id,
        body: {
          enabled: input.enabled,
          ...(input.intervalMinutes !== undefined
            ? { intervalMinutes: input.intervalMinutes }
            : {}),
        },
      },
      { signal }
    );
  },
};

const listEvalCasesInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
});
export type ListEvalCasesInput = z.infer<typeof listEvalCasesInput>;

export const listEvalCasesOperation: PlatformOperation<
  ListEvalCasesInput,
  PlatformPage<PlatformEvalCase>
> = {
  name: "list_eval_cases",
  title: "List MCPJam eval cases",
  description:
    "List the test cases in an eval suite, with their ids and configuration.",
  readOnly: true,
  inputSchema: listEvalCasesInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.listEvalCases(
      { projectId: project.id, suiteId: suite.id },
      { signal }
    );
  },
};

const getEvalCaseInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  case: z.string().trim().min(1).describe(CASE_SELECTOR_DESCRIPTION),
});
export type GetEvalCaseInput = z.infer<typeof getEvalCaseInput>;

export const getEvalCaseOperation: PlatformOperation<
  GetEvalCaseInput,
  PlatformEvalCase
> = {
  name: "get_eval_case",
  title: "Get MCPJam eval case",
  description: "Fetch one eval test case's full definition.",
  readOnly: true,
  inputSchema: getEvalCaseInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const testCase = await resolveCase(
      client,
      project,
      suite,
      input.case,
      signal
    );
    return client.getEvalCase(
      { projectId: project.id, suiteId: suite.id, caseId: testCase.id },
      { signal }
    );
  },
};

const createEvalCaseInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  ...caseFieldsShape,
  title: z.string().trim().min(1).describe("Short case label."),
});
export type CreateEvalCaseInput = z.infer<typeof createEvalCaseInput>;

export const createEvalCaseOperation: PlatformOperation<
  CreateEvalCaseInput,
  PlatformEvalCase
> = {
  name: "create_eval_case",
  title: "Create MCPJam eval case",
  description:
    "Add one test case to an eval suite. Provide ordered `steps`: a `prompt` step is a model turn, a `toolCall` step is a deterministic tool call, and `assert` steps hold the expectations (e.g. a `toolCalledWith` or `widgetRendered` predicate). Positive cases must include at least one `assert` step.",
  readOnly: false,
  inputSchema: createEvalCaseInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.createEvalCase(
      { projectId: project.id, suiteId: suite.id, body: buildCaseBody(input) },
      { signal }
    );
  },
};

const updateEvalCaseInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  case: z.string().trim().min(1).describe(CASE_SELECTOR_DESCRIPTION),
  ...caseFieldsShape,
});
export type UpdateEvalCaseInput = z.infer<typeof updateEvalCaseInput>;

export const updateEvalCaseOperation: PlatformOperation<
  UpdateEvalCaseInput,
  PlatformEvalCase
> = {
  name: "update_eval_case",
  title: "Update MCPJam eval case",
  description:
    "Edit an eval test case. Only the fields you pass change (steps, expected output, iterations, models, match options, checks). Passing `steps` replaces the case's test-step sequence wholesale.",
  readOnly: false,
  inputSchema: updateEvalCaseInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const testCase = await resolveCase(
      client,
      project,
      suite,
      input.case,
      signal
    );
    return client.updateEvalCase(
      {
        projectId: project.id,
        suiteId: suite.id,
        caseId: testCase.id,
        body: buildCaseBody(input),
      },
      { signal }
    );
  },
};

const deleteEvalCaseInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  case: z.string().trim().min(1).describe(CASE_SELECTOR_DESCRIPTION),
});
export type DeleteEvalCaseInput = z.infer<typeof deleteEvalCaseInput>;

export const deleteEvalCaseOperation: PlatformOperation<
  DeleteEvalCaseInput,
  PlatformEvalCaseDeleted
> = {
  name: "delete_eval_case",
  title: "Delete MCPJam eval case",
  description:
    "Permanently delete one test case from an eval suite. This cannot be undone.",
  readOnly: false,
  inputSchema: deleteEvalCaseInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const testCase = await resolveCase(
      client,
      project,
      suite,
      input.case,
      signal
    );
    return client.deleteEvalCase(
      { projectId: project.id, suiteId: suite.id, caseId: testCase.id },
      { signal }
    );
  },
};

const generateEvalCasesInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  mode: z
    .enum(["normal", "negative"])
    .optional()
    .describe(
      "normal = mixed positive/negative cases; negative = only negative. Defaults to normal."
    ),
  servers: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      "Server names/IDs to discover tools from; defaults to the suite's selection."
    ),
  caseModels: z
    .array(caseModelSchema)
    .optional()
    .describe("Execution models to set on the generated cases."),
  caseMix: z
    .object({
      simple: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Easy, single-tool, single-turn cases."),
      multiTool: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Medium, 2+ tools, single-turn cases."),
      multiTurn: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Medium, multi-turn follow-up cases."),
      complex: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Hard, multi-turn, 3+ tools / cross-server cases."),
      negative: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Cases that should NOT trigger any tools."),
    })
    .optional()
    .describe(
      "Per-bucket case counts. Omitted buckets inherit the default mix; supersedes `mode`. Each bucket and the total are bounded server-side."
    ),
  varyUserStyles: z
    .boolean()
    .optional()
    .describe(
      "Condition generated cases on a realistic range of user styles so the queries read like different users wrote them."
    ),
});
export type GenerateEvalCasesInput = z.infer<typeof generateEvalCasesInput>;

export const generateEvalCasesOperation: PlatformOperation<
  GenerateEvalCasesInput,
  PlatformEvalCasesGenerated
> = {
  name: "generate_eval_cases",
  title: "Generate MCPJam eval cases",
  description:
    "AI-generate test cases from the suite's server tools and persist them into the suite. Connects the servers to discover tools and spends the organization's credits. The authoring model is platform-controlled; set caseModels to choose the generated cases' execution models.",
  readOnly: false,
  inputSchema: generateEvalCasesInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    // Resolve server name/id selectors to project server IDs before sending —
    // the route hands `servers` straight to batch authorization, which expects
    // IDs. Mirrors run_eval_suite so a `--server <name>` override works.
    const overrideServers = input.servers
      ? await resolveRunServers(client, project, input.servers, signal)
      : undefined;
    return client.generateEvalCases(
      {
        projectId: project.id,
        suiteId: suite.id,
        body: {
          ...(input.mode ? { mode: input.mode } : {}),
          ...(overrideServers
            ? { servers: overrideServers.map((server) => server.id) }
            : {}),
          ...(input.caseModels ? { caseModels: input.caseModels } : {}),
          ...(input.caseMix ? { caseMix: input.caseMix } : {}),
          ...(input.varyUserStyles ? { varyUserStyles: true } : {}),
        },
      },
      { signal }
    );
  },
};

const evalRunScopedInput = z.object({
  project: z.string().trim().min(1).describe(RUN_PROJECT_DESCRIPTION),
  runId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Eval run ID, as returned by run_eval_suite or list_eval_suite_runs."
    ),
});

export type EvalRunScopedInput = z.infer<typeof evalRunScopedInput>;

export type GetEvalRunResult = {
  project: SelectedProjectInfo;
  run: PlatformEvalRun;
};

export const getEvalRunOperation: PlatformOperation<
  EvalRunScopedInput,
  GetEvalRunResult
> = {
  name: "get_eval_run",
  title: "Get MCPJam eval run",
  description:
    "Get the status, pass/fail result, and summary counts of an eval run. Poll this until status is completed, failed, or cancelled.",
  readOnly: true,
  inputSchema: evalRunScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const run = await client.getEvalRun(
      { projectId: project.id, runId: input.runId },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

const evalRunIterationsInput = evalRunScopedInput.extend({
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe("Opaque pagination cursor from a previous response."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum number of iterations to return per page."),
});

export type ListEvalRunIterationsInput = z.infer<typeof evalRunIterationsInput>;

export type ListEvalRunIterationsResult = {
  project: SelectedProjectInfo;
  runId: string;
  items: PlatformEvalIteration[];
  nextCursor?: string;
};

export const listEvalRunIterationsOperation: PlatformOperation<
  ListEvalRunIterationsInput,
  ListEvalRunIterationsResult
> = {
  name: "list_eval_run_iterations",
  title: "List MCPJam eval run iterations",
  description:
    "List per-iteration results for an eval run: pass/fail, expected vs actual tool calls, token usage, and latency. Paginated — pass nextCursor back as cursor for the next page.",
  readOnly: true,
  inputSchema: evalRunIterationsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const page = await client.listEvalRunIterations(
      {
        projectId: project.id,
        runId: input.runId,
        cursor: input.cursor,
        limit: input.limit,
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      runId: input.runId,
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  },
};

const evalIterationTraceInput = evalRunScopedInput.extend({
  iterationId: z
    .string()
    .trim()
    .min(1)
    .describe("Iteration ID, as returned by list_eval_run_iterations."),
});

export type GetEvalIterationTraceInput = z.infer<
  typeof evalIterationTraceInput
>;

export type GetEvalIterationTraceResult = {
  project: SelectedProjectInfo;
  runId: string;
  iterationId: string;
  trace: unknown;
};

export const getEvalIterationTraceOperation: PlatformOperation<
  GetEvalIterationTraceInput,
  GetEvalIterationTraceResult
> = {
  name: "get_eval_iteration_trace",
  title: "Get MCPJam eval iteration trace",
  description:
    "Fetch the full trace for one eval iteration: the complete message history plus expected-vs-actual tool-call analysis. Use it to diagnose why an iteration failed. Responses can be large.",
  readOnly: true,
  inputSchema: evalIterationTraceInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const trace = await client.getEvalIterationTrace(
      {
        projectId: project.id,
        runId: input.runId,
        iterationId: input.iterationId,
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      runId: input.runId,
      iterationId: input.iterationId,
      trace,
    };
  },
};

export type CancelEvalRunResult = {
  project: SelectedProjectInfo;
  run: PlatformEvalRun;
};

export const cancelEvalRunOperation: PlatformOperation<
  EvalRunScopedInput,
  CancelEvalRunResult
> = {
  name: "cancel_eval_run",
  title: "Cancel MCPJam eval run",
  description:
    "Cancel an in-flight eval run. Marks the run and its pending/running iterations cancelled. No-op if already cancelled; errors if the run already finished.",
  readOnly: false,
  inputSchema: evalRunScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const run = await client.cancelEvalRun(
      { projectId: project.id, runId: input.runId },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

const evalRunStepsInput = evalRunScopedInput.extend({
  iterationId: z
    .string()
    .trim()
    .min(1)
    .describe("Iteration ID, as returned by list_eval_run_iterations."),
});

export type GetEvalRunStepsInput = z.infer<typeof evalRunStepsInput>;

export type GetEvalRunStepsResult = {
  project: SelectedProjectInfo;
  runId: string;
  iterationId: string;
  steps: PlatformEvalStepResult[];
};

export const getEvalRunStepsOperation: PlatformOperation<
  GetEvalRunStepsInput,
  GetEvalRunStepsResult
> = {
  name: "get_eval_run_steps",
  title: "Get MCPJam eval iteration step results",
  description:
    "Fetch one row per authored test step for an eval iteration, in order: each step's status (ok / fail / skipped / pending), the reason, and evidence (screenshot/video URLs, widget tool calls). The fastest way to see WHICH step failed and why.",
  readOnly: true,
  inputSchema: evalRunStepsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const page = await client.getEvalRunSteps(
      {
        projectId: project.id,
        runId: input.runId,
        iterationId: input.iterationId,
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      runId: input.runId,
      iterationId: input.iterationId,
      steps: page.items,
    };
  },
};

async function resolveSuite(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined
): Promise<PlatformEvalSuite> {
  const page = await client.listEvalSuites(
    { projectId: project.id },
    { signal }
  );
  return resolveByIdOrName(
    page.items,
    selector,
    "Eval suite",
    `project "${project.name}"`
  );
}

/**
 * Resolve a test case within a suite by id or (case-insensitive) title. Cases
 * expose `title`, so map it onto the `name` field `resolveByIdOrName` matches.
 */
async function resolveCase(
  client: PlatformApiClient,
  project: PlatformProject,
  suite: PlatformEvalSuite,
  selector: string,
  signal: AbortSignal | undefined
): Promise<PlatformEvalCase> {
  const page = await client.listEvalCases(
    { projectId: project.id, suiteId: suite.id },
    { signal }
  );
  return resolveByIdOrName(
    page.items.map((testCase) => ({ ...testCase, name: testCase.title })),
    selector,
    "Eval case",
    `suite "${suite.name ?? suite.id}"`
  );
}

/**
 * Resolve an explicit server override for a run. Selectors resolve by id or
 * unique name (deduplicated) and must be hosted-runnable HTTP servers;
 * disabled servers stay selectable, since naming one is an explicit choice.
 * That mirrors what the platform itself permits: eval-run authorization is
 * project-membership-based and does not consult the `enabled` toggle, which
 * only controls default connection sets. The no-override default lives
 * server-side: the platform connects the suite's saved selection.
 */
async function resolveRunServers(
  client: PlatformApiClient,
  project: PlatformProject,
  selectors: string[],
  signal: AbortSignal | undefined
): Promise<PlatformProjectServer[]> {
  const page = await client.listProjectServers(
    { projectId: project.id },
    { signal }
  );

  const resolved = new Map<string, PlatformProjectServer>();
  for (const selector of selectors) {
    const server = resolveByIdOrName(
      page.items,
      selector,
      "Server",
      `project "${project.name}"`
    );
    // Fail deterministically here rather than downstream at run creation:
    // the hosted runner can never connect to these.
    if (server.transportType === "stdio" || !server.url) {
      throw resolutionError(
        `Server "${selector.trim()}" can't run hosted evals: ${
          server.transportType === "stdio"
            ? "stdio servers are not supported on the hosted platform"
            : "it has no URL"
        }. Select an HTTP server instead.`
      );
    }
    resolved.set(server.id, server);
  }
  return [...resolved.values()];
}

// ── Tunnel operations ────────────────────────────────────────────────
// Register/revoke relay tunnels for project servers. The grant returned by
// create_tunnel is a credential: its url embeds the plaintext ?k= bearer
// secret and its connectToken authenticates the relay WebSocket.

const createTunnelInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  name: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Server name to register the tunnel under. Reusing an existing server's name points that record at the tunnel (its URL is overwritten and stdio records are converted to HTTP)."
    ),
});

export type CreateTunnelInput = z.infer<typeof createTunnelInput>;

export type CreateTunnelResult = {
  project: SelectedProjectInfo;
  grant: PlatformTunnelGrant;
};

export const createTunnelOperation: PlatformOperation<
  CreateTunnelInput,
  CreateTunnelResult
> = {
  name: "create_tunnel",
  title: "Create MCPJam tunnel",
  description:
    "Register (or revive) a relay tunnel for a named server in an MCPJam project and return the connection grant. Each call rotates the tunnel secret and disconnects any previous tunnel session for that server, so calling it again is also how a lost or expired grant is replaced.",
  readOnly: false,
  inputSchema: createTunnelInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const grant = await client.createTunnel(
      { projectId: project.id, name: input.name },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), grant };
  },
};

const closeTunnelInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  serverId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Server ID whose tunnel to revoke, as returned by create_tunnel."
    ),
});

export type CloseTunnelInput = z.infer<typeof closeTunnelInput>;

export type CloseTunnelResult = {
  project: SelectedProjectInfo;
  serverId: string;
  status: string;
};

export const closeTunnelOperation: PlatformOperation<
  CloseTunnelInput,
  CloseTunnelResult
> = {
  name: "close_tunnel",
  title: "Close MCPJam tunnel",
  description:
    "Revoke a tunnel's live grant: the public URL stops working immediately. The server record is kept (with its now-dead URL) so the tunnel revives with the same slug on the next create_tunnel.",
  readOnly: false,
  inputSchema: closeTunnelInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const result = await client.closeTunnel(
      { projectId: project.id, serverId: input.serverId },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      serverId: result.serverId,
      status: result.status,
    };
  },
};

// ── Chat operations ──────────────────────────────────────────────────

export type ListChatboxesResult = {
  project: SelectedProjectInfo;
  items: PlatformChatbox[];
  otherProjects: ProjectInfo[];
};

export const listChatboxesOperation: PlatformOperation<
  ProjectScopedInput,
  ListChatboxesResult
> = {
  name: "list_chatboxes",
  title: "List MCPJam chatboxes",
  description:
    "List the chatboxes published from an MCPJam project: name, access mode, attached servers, and share link. If no project is specified, uses the most recently updated accessible project and returns other project names for switching.",
  readOnly: true,
  inputSchema: projectScopedInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const page = await client.listChatboxes(
      { projectId: project.id },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

const chatboxScopedInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  chatbox: z.string().trim().min(1).describe("Chatbox name or ID."),
});

export type GetChatboxInput = z.infer<typeof chatboxScopedInput>;

export type GetChatboxResult = {
  project: SelectedProjectInfo;
  chatbox: PlatformChatboxDetail;
};

export const getChatboxOperation: PlatformOperation<
  GetChatboxInput,
  GetChatboxResult
> = {
  name: "get_chatbox",
  title: "Get MCPJam chatbox",
  description:
    "Get one chatbox's read-only settings: model, system prompt, temperature, tool-approval policy, and resolved servers. The chatbox is matched by name or ID within the project.",
  readOnly: true,
  inputSchema: chatboxScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const page = await client.listChatboxes(
      { projectId: project.id },
      { signal }
    );
    const match = resolveByIdOrName(
      page.items,
      input.chatbox,
      "Chatbox",
      `project "${project.name}"`
    );
    const chatbox = await client.getChatbox(
      { projectId: project.id, chatboxId: match.id },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), chatbox };
  },
};

const listChatSessionsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional project filter (name or ID). When omitted, lists sessions across all accessible projects."
    ),
  status: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Filter by session status."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum number of sessions to return per page."),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe("Opaque pagination cursor from a previous response."),
});

export type ListChatSessionsInput = z.infer<typeof listChatSessionsInput>;

export type ListChatSessionsResult = {
  project?: SelectedProjectInfo;
  items: PlatformChatSession[];
  nextCursor?: string;
};

export const listChatSessionsOperation: PlatformOperation<
  ListChatSessionsInput,
  ListChatSessionsResult
> = {
  name: "list_chat_sessions",
  title: "List MCPJam chat sessions",
  description:
    "List chat sessions visible to the caller, most recent activity first. Optionally filter by project (name or ID) and status; paginated — pass nextCursor back as cursor for the next page.",
  readOnly: true,
  inputSchema: listChatSessionsInput,
  async execute(input, { client, signal }) {
    // Unlike the project-scoped reads, no default project is applied: the
    // unfiltered listing (personal + project-shared sessions) is the API's
    // own default and the more useful answer for "what was I working on?".
    // Trim again for raw execute() callers who bypass the schema — a blank
    // selector must mean "unfiltered", never silently the default project.
    const projectSelector = input.project?.trim();
    const project = projectSelector
      ? (await resolveProjectOrThrow(client, projectSelector, signal)).project
      : undefined;
    const page = await client.listChatSessions(
      {
        projectId: project?.id,
        status: input.status,
        limit: input.limit,
        before: input.cursor,
      },
      { signal }
    );
    return {
      ...(project ? { project: toSelectedProjectInfo(project) } : {}),
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  },
};

// ── Hosts ──────────────────────────────────────────────────────────────────

const HOST_SELECTOR_DESCRIPTION = "Host name or ID.";

async function resolveHost(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined
): Promise<PlatformHost> {
  const page = await client.listHosts({ projectId: project.id }, { signal });
  return resolveByIdOrName(
    page.items,
    selector,
    "Host",
    `project "${project.name}"`
  );
}

export type ListHostsResult = {
  project: SelectedProjectInfo;
  items: PlatformHost[];
  otherProjects: ProjectInfo[];
};

export const listHostsOperation: PlatformOperation<
  ProjectScopedInput,
  ListHostsResult
> = {
  name: "list_hosts",
  title: "List MCPJam hosts",
  description:
    "List the hosts saved in an MCPJam project. If no project is specified, uses the most recently updated accessible project and returns other project names for switching.",
  readOnly: true,
  inputSchema: projectScopedInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const page = await client.listHosts({ projectId: project.id }, { signal });
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

const getHostInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  host: z.string().trim().min(1).describe(HOST_SELECTOR_DESCRIPTION),
});
export type GetHostInput = z.infer<typeof getHostInput>;

export const getHostOperation: PlatformOperation<
  GetHostInput,
  PlatformHostDetail
> = {
  name: "get_host",
  title: "Show an MCPJam host",
  description:
    "Show one host's full settings, including its resolved host config (model, capabilities, host context).",
  readOnly: true,
  inputSchema: getHostInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const host = await resolveHost(client, project, input.host, signal);
    return client.getHost(
      { projectId: project.id, hostId: host.id },
      { signal }
    );
  },
};

const createHostInput = z
  .object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    name: z.string().trim().min(1).describe("Display name for the new host."),
    template: z
      .enum(HOST_TEMPLATE_IDS)
      .optional()
      .describe(
        "Built-in template to seed the host config from (e.g. claude, chatgpt, cursor)."
      ),
    theme: z
      .enum(["light", "dark"])
      .optional()
      .describe("Theme stamped into the seeded host config (template only)."),
    config: z
      .record(z.string(), z.unknown())
      .refine((value) => Object.keys(value).length > 0, {
        message: "`config` must be a non-empty host config object.",
      })
      .optional()
      .describe("Full host config v2 to use verbatim (alternative to template)."),
  })
  .refine(
    (value) => (value.template ? 1 : 0) + (value.config ? 1 : 0) === 1,
    { message: "Provide exactly one of `template` or a non-empty `config`." }
  );
export type CreateHostInput = z.infer<typeof createHostInput>;

export const createHostOperation: PlatformOperation<
  CreateHostInput,
  PlatformHostDetail
> = {
  name: "create_host",
  title: "Create an MCPJam host",
  description:
    "Create a host in a project, either from a built-in template (`template`, optional `theme`) or from a full host config (`config`). Returns the created host.",
  readOnly: false,
  inputSchema: createHostInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const body: Record<string, unknown> = { name: input.name };
    if (input.template) {
      body.template = input.template;
      if (input.theme) body.theme = input.theme;
    }
    if (input.config) body.config = input.config;
    return client.createHost({ projectId: project.id, body }, { signal });
  },
};

const updateHostInput = z
  .object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    host: z.string().trim().min(1).describe(HOST_SELECTOR_DESCRIPTION),
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("New display name for the host."),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Replacement host config v2."),
  })
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: "Provide at least one of `name` or `config` to update.",
  });
export type UpdateHostInput = z.infer<typeof updateHostInput>;

export const updateHostOperation: PlatformOperation<
  UpdateHostInput,
  PlatformHostDetail
> = {
  name: "update_host",
  title: "Update an MCPJam host",
  description:
    "Edit a host's display name and/or its host config. Only the fields you pass change.",
  readOnly: false,
  inputSchema: updateHostInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const host = await resolveHost(client, project, input.host, signal);
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.config !== undefined) body.config = input.config;
    return client.updateHost(
      { projectId: project.id, hostId: host.id, body },
      { signal }
    );
  },
};

const deleteHostInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  host: z.string().trim().min(1).describe(HOST_SELECTOR_DESCRIPTION),
});
export type DeleteHostInput = z.infer<typeof deleteHostInput>;

export const deleteHostOperation: PlatformOperation<
  DeleteHostInput,
  PlatformHostDeleted
> = {
  name: "delete_host",
  title: "Delete an MCPJam host",
  description:
    "Permanently delete a host from a project. This cannot be undone.",
  readOnly: false,
  inputSchema: deleteHostInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const host = await resolveHost(client, project, input.host, signal);
    return client.deleteHost(
      {
        projectId: project.id,
        hostId: host.id,
        // The v1 delete contract is bodyless — the route rejects any field.
        body: {},
      },
      { signal }
    );
  },
};

// ── Computer environments ────────────────────────────────────────────────────

const ENVIRONMENT_SELECTOR_DESCRIPTION = "Environment name or ID.";

async function resolveEnvironment(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined
): Promise<PlatformEnvironment> {
  const page = await client.listEnvironments(
    { projectId: project.id },
    { signal }
  );
  return resolveByIdOrName(
    page.items,
    selector,
    "Environment",
    `project "${project.name}"`
  );
}

const environmentSelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  environment: z.string().trim().min(1).describe(ENVIRONMENT_SELECTOR_DESCRIPTION),
});
export type EnvironmentSelectorInput = z.infer<typeof environmentSelectorInput>;

export type ListEnvironmentsResult = {
  project: SelectedProjectInfo;
  items: PlatformEnvironment[];
  otherProjects: ProjectInfo[];
};

export const listEnvironmentsOperation: PlatformOperation<
  ProjectScopedInput,
  ListEnvironmentsResult
> = {
  name: "list_computer_environments",
  title: "List computer environments",
  description:
    "List the custom Computer environments (Dockerfile images) in an MCPJam project. If no project is specified, uses the most recently updated accessible project.",
  readOnly: true,
  inputSchema: projectScopedInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const page = await client.listEnvironments(
      { projectId: project.id },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

export const getEnvironmentOperation: PlatformOperation<
  EnvironmentSelectorInput,
  PlatformEnvironment
> = {
  name: "get_computer_environment",
  title: "Show a computer environment",
  description:
    "Show one environment's Dockerfile, sharing, and latest build status.",
  readOnly: true,
  inputSchema: environmentSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const env = await resolveEnvironment(
      client,
      project,
      input.environment,
      signal
    );
    return client.getEnvironment(
      { projectId: project.id, environmentId: env.id },
      { signal }
    );
  },
};

const createEnvironmentInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  name: z.string().trim().min(1).describe("Display name for the new environment."),
  dockerfile: z
    .string()
    .min(1)
    .describe(
      "Dockerfile text. Must start FROM an allowlisted official base pinned by @sha256 digest; only FROM + RUN are supported."
    ),
});
export type CreateEnvironmentInput = z.infer<typeof createEnvironmentInput>;

export const createEnvironmentOperation: PlatformOperation<
  CreateEnvironmentInput,
  PlatformEnvironment
> = {
  name: "create_computer_environment",
  title: "Create a computer environment",
  description:
    "Create a custom Computer environment from a Dockerfile. Build it (build_computer_environment) before a computer can boot from it.",
  readOnly: false,
  inputSchema: createEnvironmentInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    return client.createEnvironment(
      {
        projectId: project.id,
        body: { name: input.name, dockerfile: input.dockerfile },
      },
      { signal }
    );
  },
};

const updateEnvironmentInput = z
  .object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    environment: z
      .string()
      .trim()
      .min(1)
      .describe(ENVIRONMENT_SELECTOR_DESCRIPTION),
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("New display name for the environment."),
    dockerfile: z
      .string()
      .min(1)
      .optional()
      .describe("Replacement Dockerfile text."),
  })
  .refine((value) => value.name !== undefined || value.dockerfile !== undefined, {
    message: "Provide at least one of `name` or `dockerfile` to update.",
  });
export type UpdateEnvironmentInput = z.infer<typeof updateEnvironmentInput>;

export const updateEnvironmentOperation: PlatformOperation<
  UpdateEnvironmentInput,
  PlatformEnvironment
> = {
  name: "update_computer_environment",
  title: "Update a computer environment",
  description:
    "Edit an environment's name and/or Dockerfile. Re-build it for changes to take effect on a computer.",
  readOnly: false,
  inputSchema: updateEnvironmentInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const env = await resolveEnvironment(
      client,
      project,
      input.environment,
      signal
    );
    const body: { name?: string; dockerfile?: string } = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.dockerfile !== undefined) body.dockerfile = input.dockerfile;
    return client.updateEnvironment(
      { projectId: project.id, environmentId: env.id, body },
      { signal }
    );
  },
};

export const buildEnvironmentOperation: PlatformOperation<
  EnvironmentSelectorInput,
  PlatformEnvironmentBuildStarted
> = {
  name: "build_computer_environment",
  title: "Build a computer environment",
  description:
    "Trigger a build of the environment's image. Async — poll list_computer_environment_builds for status.",
  readOnly: false,
  inputSchema: environmentSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const env = await resolveEnvironment(
      client,
      project,
      input.environment,
      signal
    );
    return client.buildEnvironment(
      { projectId: project.id, environmentId: env.id },
      { signal }
    );
  },
};

export type ListEnvironmentBuildsResult = {
  project: SelectedProjectInfo;
  environmentId: string;
  items: PlatformEnvironmentBuild[];
};

export const listEnvironmentBuildsOperation: PlatformOperation<
  EnvironmentSelectorInput,
  ListEnvironmentBuildsResult
> = {
  name: "list_computer_environment_builds",
  title: "List computer environment builds",
  description:
    "List an environment's builds (newest first) with their status and log preview.",
  readOnly: true,
  inputSchema: environmentSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const env = await resolveEnvironment(
      client,
      project,
      input.environment,
      signal
    );
    const page = await client.listEnvironmentBuilds(
      { projectId: project.id, environmentId: env.id },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      environmentId: env.id,
      items: page.items,
    };
  },
};

export const promoteEnvironmentOperation: PlatformOperation<
  EnvironmentSelectorInput,
  PlatformEnvironment
> = {
  name: "promote_computer_environment",
  title: "Share a computer environment with the project",
  description:
    "Promote a personal-draft environment to a project-shared one (requires project admin).",
  readOnly: false,
  inputSchema: environmentSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const env = await resolveEnvironment(
      client,
      project,
      input.environment,
      signal
    );
    return client.promoteEnvironment(
      { projectId: project.id, environmentId: env.id },
      { signal }
    );
  },
};

export const useEnvironmentOperation: PlatformOperation<
  EnvironmentSelectorInput,
  PlatformComputerAttached
> = {
  name: "use_computer_environment",
  title: "Use a computer environment",
  description:
    "Attach the environment to your computer, which rebuilds it from the pinned image (installed files are wiped). The environment must have a ready build.",
  readOnly: false,
  inputSchema: environmentSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const env = await resolveEnvironment(
      client,
      project,
      input.environment,
      signal
    );
    return client.useEnvironment(
      { projectId: project.id, environmentId: env.id },
      { signal }
    );
  },
};

export const resetComputerOperation: PlatformOperation<
  ProjectScopedInput,
  PlatformComputerReset
> = {
  name: "reset_computer",
  title: "Reset your computer to its image",
  description:
    "Reset the caller's computer back to its current image, wiping mutable state.",
  readOnly: false,
  inputSchema: projectScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    return client.resetComputer({ projectId: project.id }, { signal });
  },
};

export const deleteEnvironmentOperation: PlatformOperation<
  EnvironmentSelectorInput,
  PlatformEnvironmentDeleted
> = {
  name: "delete_computer_environment",
  title: "Delete a computer environment",
  description:
    "Permanently delete an environment. Computers booted from it fall back to the base image. This cannot be undone.",
  readOnly: false,
  inputSchema: environmentSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const env = await resolveEnvironment(
      client,
      project,
      input.environment,
      signal
    );
    return client.deleteEnvironment(
      { projectId: project.id, environmentId: env.id },
      { signal }
    );
  },
};
