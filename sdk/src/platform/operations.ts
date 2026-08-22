/**
 * Curated, task-shaped operations over the Platform API. Each operation is
 * defined once and adapted per surface: MCP worker tools, CLI commands, and
 * (later) in-product agent tools. Names follow the built-in tool id
 * convention (`^[a-z][a-z0-9_]{0,63}$`) so they can be registered in the
 * product catalog unchanged.
 */
import { z } from "zod";
import { opaqueIdSchema } from "../contract/identity.js";
import { MAX_BATCH_CREATE_CASES } from "../contract/suite-file.js";
import type { PlatformApiClient } from "./client.js";
import { PlatformApiError } from "./errors.js";
import {
  computeRunTargets,
  type RunTarget,
  type RunTargetHost,
  type RunTargetPlan,
} from "./suite-run-plans.js";
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
  PlatformScenarioSummary,
  PlatformScenarioDetail,
  PlatformChatSession,
  PlatformDoctorReport,
  PlatformReadinessLaneCoverage,
  PlatformReadinessObservationState,
  PlatformReadinessRun,
  PlatformReadinessRunReceipt,
  PlatformConformanceReport,
  PlatformConformanceRun,
  PlatformConformanceRunReceipt,
  PlatformReadinessStageResult,
  PlatformEvalCase,
  PlatformEvalCaseBatchResult,
  PlatformEvalCaseDeleted,
  PlatformEvalCasesGenerated,
  PlatformEvalIteration,
  PlatformEvalStepResult,
  PlatformEvalRun,
  PlatformEvalRunJudgeRequested,
  PlatformEvalCheckRepos,
  PlatformEvalCheckRepoConnected,
  PlatformRunCompare,
  PlatformEvalRunCreated,
  PlatformEvalSuite,
  PlatformEvalSuiteCreated,
  PlatformEvalSuiteDeleted,
  PlatformEvalSuiteDetail,
  PlatformEvalRunGroupCreated,
  PlatformAdhocEnvironment,
  PlatformAdhocEnvironmentBody,
  PlatformComputerAttached,
  PlatformComputerReset,
  PlatformEnvironment,
  PlatformJourney,
  PlatformJourneyRun,
  PlatformJourneyRunSession,
  PlatformCapabilities,
  PlatformFindingDismissed,
  PlatformGenerationDrafts,
  PlatformJourneyArchived,
  PlatformJourneyRunCanceled,
  PlatformPersona,
  PlatformPersonaDeleted,
  PlatformRunScorecard,
  PlatformSessionSummary,
  PlatformSwarm,
  PlatformSwarmArchived,
  PlatformSwarmFinding,
  PlatformSwarmOverview,
  PlatformWaveInsights,
  PlatformWaveInsightsCanceled,
  PlatformUserTestingInsightsRequested,
  PlatformUserTestingScenario,
  PlatformUserTestingScenarioDetail,
  PlatformUserTestingSession,
  PlatformUserTestingSessionDetail,
  PlatformWaveInsightsRequested,
  PlatformJourneyRunLaunched,
  PlatformScenario,
  PlatformScenarioDeleted,
  PlatformEnvironmentCapabilities,
  PlatformEnvironmentResolved,
  PlatformEnvironmentUpdateBody,
  PlatformImage,
  PlatformImageBlueprintValidation,
  PlatformImageBuild,
  PlatformImageBuildStarted,
  PlatformImageDeleted,
  PlatformHost,
  PlatformHostDeleted,
  PlatformHostDetail,
  PlatformOrganization,
  PlatformPage,
  PlatformMe,
  PlatformModel,
  PlatformPlugin,
  PlatformPluginVersion,
  PlatformProject,
  PlatformProjectServer,
  PlatformServerConnection,
  PlatformTunnelGrant,
  PlatformCatalogServer,
  PlatformCatalogSourceStatus,
  PlatformRegistryServer,
  PlatformRegistryConnection,
  PlatformRegistryInstallResult,
} from "./types.js";

export interface PlatformOperationContext {
  client: PlatformApiClient;
  signal?: AbortSignal;
}

export const getMeOperation: PlatformOperation<
  Record<string, never>,
  PlatformMe
> = {
  name: "get_me",
  title: "Get the current MCPJam account",
  description: "Return the account associated with the current API credential.",
  readOnly: true,
  inputSchema: z.object({}),
  async execute(_input, { client, signal }) {
    return client.getMe({ signal });
  },
};

export const listModelsOperation: PlatformOperation<
  Record<string, never>,
  PlatformPage<PlatformModel>
> = {
  name: "list_models",
  title: "List hosted MCPJam models",
  description:
    "List the public hosted model catalog available to MCPJam callers.",
  readOnly: true,
  inputSchema: z.object({}),
  async execute(_input, { client, signal }) {
    return client.listModels({ signal });
  },
};

export const listOrganizationsOperation: PlatformOperation<
  Record<string, never>,
  PlatformPage<PlatformOrganization>
> = {
  name: "list_organizations",
  title: "List MCPJam organizations",
  description:
    "List the organizations the caller belongs to. Use this to discover the organization id that list_projects filters by and create_project takes. An organization-scoped API key only ever sees its own organization.",
  readOnly: true,
  inputSchema: z.object({}),
  async execute(_input, { client, signal }) {
    return client.listOrganizations({ signal });
  },
};

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
  /**
   * What kind of harm a mistaken call does, so every surface can make ONE
   * decision from one place instead of five surfaces each re-deriving it.
   *
   * `readOnly` already separates reads from writes, and that is not the
   * question the surfaces actually have. Creating an eval case and rotating a
   * share link are both writes; one is undo-able with a delete, the other
   * breaks every live link someone has already handed out. Before this field
   * the agent registry, the MCP catalog and the workspace toolset each encoded
   * that difference in their own prose, which is how `cancel_journey_run` came
   * to be excluded from one surface for a reason that only applied to another.
   *
   *   `none`        — persists, but reversible and costs nothing.
   *   `spend`       — consumes credits or quota, possibly a lot.
   *   `exposure`    — changes who can reach something.
   *   `destructive` — removes or invalidates something that existed.
   *
   * Absent means `none` on a write and is meaningless on a read. This is
   * DESCRIPTIVE metadata for surfaces to act on — it enforces nothing by
   * itself, and a surface that ignores it is no less safe than before.
   */
  risk?: "none" | "spend" | "exposure" | "destructive";
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
      { signal },
    );
    const resolution = resolveProject(page.items);
    return {
      ...page,
      items: resolution.ok ? resolution.sortedProjects : page.items,
    };
  },
};

const createProjectInput = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  organizationId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Organization to create the project in, from list_organizations. Defaults to the caller's own organization.",
    ),
  icon: z.string().optional(),
  visibility: z.enum(["public", "private"]).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectInput>;

export const createProjectOperation: PlatformOperation<
  CreateProjectInput,
  PlatformProject
> = {
  name: "create_project",
  title: "Create an MCPJam project",
  description:
    "Create an empty project in an organization the caller belongs to. The new project starts with no MCP servers; add them with create_project_server or connect_project_server. Counts against the organization plan's project limit.",
  readOnly: false,
  inputSchema: createProjectInput,
  async execute(input, { client, signal }) {
    return client.createProject({ body: input }, { signal });
  },
};

const updateProjectInput = z
  .object({
    project: z.string().trim().min(1).describe(PROJECT_SELECTOR_DESCRIPTION),
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    visibility: z.enum(["public", "private"]).optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.icon !== undefined ||
      value.visibility !== undefined,
    { message: "Provide at least one project field to update." },
  );
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;

export const updateProjectOperation: PlatformOperation<
  UpdateProjectInput,
  PlatformProject
> = {
  name: "update_project",
  title: "Update an MCPJam project",
  description:
    "Rename a project or change its description, icon or visibility. Metadata only — this never adds, removes or edits the project's MCP server configurations, which have their own operations.",
  readOnly: false,
  inputSchema: updateProjectInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const { project: _selector, ...body } = input;
    return client.updateProject({ projectId: project.id, body }, { signal });
  },
};

const deleteProjectInput = z.object({
  project: z.string().trim().min(1).describe(PROJECT_SELECTOR_DESCRIPTION),
});
export type DeleteProjectInput = z.infer<typeof deleteProjectInput>;

export const deleteProjectOperation: PlatformOperation<
  DeleteProjectInput,
  { id: string; deleted: boolean }
> = {
  name: "delete_project",
  title: "Delete an MCPJam project",
  description:
    "Delete a project and cascade its project-owned resources. This cannot be undone.",
  readOnly: false,
  inputSchema: deleteProjectInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return client.deleteProject({ projectId: project.id }, { signal });
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
      signal,
    );
    const page = await client.listProjectServers(
      { projectId: project.id },
      { signal },
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
      signal,
    );
    const page = await client.listProjectServers(
      { projectId: project.id },
      { signal },
    );
    return buildShowServersPayload({
      doctor: (args) =>
        client.doctorServer(
          { projectId: args.projectId, serverId: args.serverId },
          { signal: args.signal },
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
  signal: AbortSignal | undefined,
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
 * Resolve a suite/scenario/server selector against a project listing the same
 * way `resolveProject` works: exact id first, then unique case-insensitive
 * name. Failures become NOT_FOUND platform errors whose message enumerates
 * the valid choices, so every surface renders the same actionable text.
 */
function resolveByIdOrName<T extends { id: string; name?: string | null }>(
  items: T[],
  selector: string,
  kind: string,
  scope: string,
): T {
  const trimmedSelector = selector.trim();
  const idMatch = items.find((item) => item.id === trimmedSelector);
  if (idMatch) {
    return idMatch;
  }

  const normalizedSelector = trimmedSelector.toLocaleLowerCase();
  const nameMatches = items.filter(
    (item) => item.name?.toLocaleLowerCase() === normalizedSelector,
  );

  if (nameMatches.length === 1) {
    return nameMatches[0]!;
  }

  if (nameMatches.length > 1) {
    throw resolutionError(
      `${kind} name "${trimmedSelector}" is ambiguous in ${scope}. Use one of these IDs: ${formatResourceList(
        nameMatches,
      )}.`,
    );
  }

  throw resolutionError(
    items.length > 0
      ? `${kind} "${trimmedSelector}" was not found in ${scope}. Available: ${formatResourceList(
          items,
        )}.`
      : `${kind} "${trimmedSelector}" was not found: ${scope} has none.`,
  );
}

function formatResourceList(
  items: Array<{ id: string; name?: string | null }>,
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
  selectedId: string,
): ProjectInfo[] {
  return sortedProjects
    .filter((candidate) => candidate.id !== selectedId)
    .map((candidate) => ({ id: candidate.id, name: candidate.name }));
}

// ── Server live operations ───────────────────────────────────────────
// Live MCP ops against one saved server: the platform authorizes the caller,
// opens an ephemeral connection, runs the op, and disconnects. The server is
// matched by name or ID within the project, like suites and scenarios.

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
  signal: AbortSignal | undefined,
): Promise<PlatformProjectServer> {
  const page = await client.listProjectServers(
    { projectId: project.id },
    { signal },
  );
  const server = resolveByIdOrName(
    page.items,
    selector,
    "Server",
    `project "${project.name}"`,
  );
  if (server.transportType === "stdio" || !server.url) {
    throw resolutionError(
      `Server "${selector.trim()}" can't run hosted operations: ${
        server.transportType === "stdio"
          ? "stdio servers are not supported on the hosted platform"
          : "it has no URL"
      }.`,
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
      signal,
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal,
    );
    const report = await client.doctorServer(
      { projectId: project.id, serverId: server.id },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      report,
    };
  },
};

export const validateServerOperation: PlatformOperation<
  ServerScopedInput,
  Record<string, unknown>
> = {
  name: "validate_server",
  title: "Validate an MCPJam server",
  description:
    "Connect to a saved MCP server and return its validation snapshot, including tools, prompts, and resources.",
  readOnly: true,
  inputSchema: serverScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal,
    );
    return client.validateServer(
      { projectId: project.id, serverId: server.id },
      { signal },
    );
  },
};

export const exportServerOperation: PlatformOperation<
  ServerScopedInput,
  Record<string, unknown>
> = {
  name: "export_server",
  title: "Export an MCPJam server",
  description:
    "Export a saved MCP server's configuration and discovered capabilities as JSON.",
  readOnly: true,
  inputSchema: serverScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal,
    );
    return client.exportServer(
      { projectId: project.id, serverId: server.id },
      { signal },
    );
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
    body: Record<string, unknown>,
  ) => Promise<PlatformPage<Record<string, unknown>>>,
): Promise<ServerPagedResult> {
  const { client, signal } = context;
  const { project } = await resolveProjectOrThrow(
    client,
    input.project,
    signal,
  );
  const server = await resolveLiveServer(client, project, input.server, signal);
  const page = await list(
    { projectId: project.id, serverId: server.id },
    input.cursor ? { cursor: input.cursor } : {},
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
        { signal: context.signal },
      ),
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
        { signal: context.signal },
      ),
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
        { signal: context.signal },
      ),
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
      signal,
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal,
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
      { signal },
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
      signal,
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal,
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
      { signal },
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
      signal,
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal,
    );
    const result = await client.readServerResource(
      {
        projectId: project.id,
        serverId: server.id,
        body: { uri: input.uri },
      },
      { signal },
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
      signal,
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal,
    );
    const scope = { projectId: project.id, serverId: server.id };

    // Gather every tool (with its inline `_meta`) across all pages.
    const rawTools: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < HOST_COMPAT_TOOLS_PAGE_CAP; page++) {
      const result = await client.listServerTools(
        { ...scope, body: cursor ? { cursor } : {} },
        { signal },
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
          { signal },
        )) as ReadResourceResult,
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

// ── Directory readiness operations ───────────────────────────────────

/**
 * Grading a server against a publisher's app directory, as an operation.
 *
 * ## Why a start returns a receipt rather than a grade
 *
 * A readiness run dials somebody else's server, follows its redirects, walks
 * its listings and sometimes asks a model to read the result. That does not
 * fit in a request, so the platform runs it durably: the start answers `202`
 * with a run id and the caller polls. Every surface that offers these
 * operations has to say so — a model told "start a run" and handed a receipt
 * will otherwise report the receipt as the answer.
 *
 * ## Why the starts declare `risk: "spend"` when the default is free
 *
 * `includeLlmObservations` is the only field that costs anything and it
 * defaults off, so most runs are free. But `risk` is a static declaration read
 * by five surfaces to decide how much ceremony a call needs, and a field that
 * described the cheap case would be describing the case that does not need
 * describing. The worst case is what a spend guard has to be told; the
 * agent's `confirmSeverity` is a function precisely so the approval copy can
 * still say "this one is free" when the flag is off.
 */

const readinessRunScopedInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  run: z.string().trim().min(1).describe("The readiness run's id."),
});

export type ReadinessRunScopedInput = z.infer<typeof readinessRunScopedInput>;

const startReadinessInput = serverScopedInput.extend({
  includeLlmObservations: z
    .boolean()
    .optional()
    .describe(
      "Ask a model for optional experience observations. COSTS the organization's MCPJam credits. Defaults false; the deterministic grade is complete without it.",
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Replay guard. A retry carrying the same key returns the run it already started rather than dialling the target twice.",
    ),
});

const startOpenAIReadinessInput = startReadinessInput.extend({
  submissionMode: z
    .enum(["mcp-only", "mcp-imported-skills"])
    .describe(
      "REQUIRED, and never inferred: which submission shape is being graded. The two package shapes need an upload this API cannot receive — grade those with `mcpjam readiness check` locally.",
    ),
});

export type StartClaudeReadinessInput = z.infer<typeof startReadinessInput>;
export type StartOpenAIReadinessInput = z.infer<
  typeof startOpenAIReadinessInput
>;

export type StartReadinessResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  run: PlatformReadinessRunReceipt;
};

export const startClaudeReadinessRunOperation: PlatformOperation<
  StartClaudeReadinessInput,
  StartReadinessResult
> = {
  name: "start_claude_readiness_run",
  title: "Start a Claude directory readiness run",
  description:
    "Grade a saved MCP server against Anthropic's connector-directory rules. Starts a durable run and returns its id — poll `get_readiness_run` for the verdict, which is NOT in this response. Deterministic grading is free; `includeLlmObservations` adds an optional model pass that consumes MCPJam credits.",
  readOnly: false,
  risk: "spend",
  inputSchema: startReadinessInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    // Rejects stdio and URL-less servers with a named reason, which is the
    // same refusal the route makes — better here, before a row exists.
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal,
    );
    const run = await client.startClaudeReadinessRun(
      {
        projectId: project.id,
        serverId: server.id,
        ...(input.includeLlmObservations !== undefined
          ? { includeLlmObservations: input.includeLlmObservations }
          : {}),
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      run,
    };
  },
};

export const startOpenAIReadinessRunOperation: PlatformOperation<
  StartOpenAIReadinessInput,
  StartReadinessResult
> = {
  name: "start_openai_readiness_run",
  title: "Start an OpenAI directory readiness run",
  description:
    "Grade a saved MCP server against OpenAI's app-directory rules. Requires an explicit `submissionMode` — it is never inferred, because guessing turns a missing input into a clean bill of health. Starts a durable run and returns its id; poll `get_readiness_run` for the verdict. Deterministic grading is free; `includeLlmObservations` consumes MCPJam credits.",
  readOnly: false,
  risk: "spend",
  inputSchema: startOpenAIReadinessInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal,
    );
    const run = await client.startOpenAIReadinessRun(
      {
        projectId: project.id,
        serverId: server.id,
        submissionMode: input.submissionMode,
        ...(input.includeLlmObservations !== undefined
          ? { includeLlmObservations: input.includeLlmObservations }
          : {}),
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      run,
    };
  },
};

export type GetReadinessRunResult = {
  project: SelectedProjectInfo;
  run: PlatformReadinessRun;
};

export const getReadinessRunOperation: PlatformOperation<
  ReadinessRunScopedInput,
  GetReadinessRunResult
> = {
  name: "get_readiness_run",
  title: "Get a directory readiness run",
  description:
    "Read one readiness run. THREE SEPARATE ANSWERS: `status` says whether the run finished, `overallStatus` is the grade (a completed run can be `not-ready`), and `llmObservations` says whether the optional model pass ran — a `billing-blocked` observation leaves the grade complete and valid. `lanes` carries per-lane coverage and the inputs that would close each gap.",
  readOnly: true,
  inputSchema: readinessRunScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const run = await client.getReadinessRun(
      { projectId: project.id, runId: input.run },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

const listReadinessRunsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  readinessKind: z
    .enum(["claude", "openai"])
    .optional()
    .describe("Narrow to one publisher. Omitted lists both, newest first."),
  server: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Narrow to one saved server."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Rows to return, 1-100. Defaults to the API's own page size."),
});

export type ListReadinessRunsInput = z.infer<typeof listReadinessRunsInput>;

export type ListReadinessRunsResult = {
  project: SelectedProjectInfo;
  runs: PlatformReadinessRun[];
};

export const listReadinessRunsOperation: PlatformOperation<
  ListReadinessRunsInput,
  ListReadinessRunsResult
> = {
  name: "list_readiness_runs",
  title: "List directory readiness runs",
  description:
    "List a project's readiness runs, newest first, optionally narrowed to one publisher or one server. Use it to find a run id when you have a server but not a run.",
  readOnly: true,
  inputSchema: listReadinessRunsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const serverId = input.server
      ? (await resolveLiveServer(client, project, input.server, signal)).id
      : undefined;
    const page = await client.listReadinessRuns(
      {
        projectId: project.id,
        ...(input.readinessKind ? { readinessKind: input.readinessKind } : {}),
        ...(serverId ? { serverId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), runs: page.items };
  },
};

export const cancelReadinessRunOperation: PlatformOperation<
  ReadinessRunScopedInput,
  { project: SelectedProjectInfo; runId: string; status: string }
> = {
  name: "cancel_readiness_run",
  title: "Cancel a directory readiness run",
  description:
    "Stop a readiness run that is still going. The executing node learns within about half a minute, so the run's real terminal state arrives on a later `get_readiness_run` — this response reports the request, not the outcome.",
  // A write, and it declares its risk as every write must — but cancelling
  // STOPS work rather than starting it: it spends nothing, destroys no record,
  // and the run it interrupts is one somebody is paying to keep running.
  readOnly: false,
  risk: "none",
  inputSchema: readinessRunScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const result = await client.cancelReadinessRun(
      { projectId: project.id, runId: input.run },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      runId: result.runId,
      status: result.status,
    };
  },
};

/**
 * The findings, PROJECTED rather than handed over whole.
 *
 * The stored report is the full graded document and can be megabytes; a model
 * surface would truncate it mid-structure, which is worse than not having it —
 * a JSON object cut in half reads as an object, just a wrong one. So this
 * operation returns a bounded projection and SAYS what it left out.
 *
 * `details` is dropped entirely. It is the raw observation behind a verdict,
 * which is what a human debugging their server wants and what a model
 * summarizing a grade has no use for.
 */
const READINESS_REPORT_FINDING_CAP = 50;

/** Most consequential first, so a truncated list keeps what matters. */
const READINESS_FINDING_CLASS_ORDER = [
  "runtime-blocker",
  "required",
  "recommended",
  "manual-review",
  "heuristic",
] as const;

export type ReadinessReportFinding = {
  id: string;
  title: string;
  lane: string;
  class: string;
  status: string;
  provenance?: string;
  remediation?: string;
  notEvaluatedReason?: string;
};

export type GetReadinessReportResult = {
  project: SelectedProjectInfo;
  runId: string;
  status: string;
  summary?: string;
  lanes: PlatformReadinessLaneCoverage[];
  stages: PlatformReadinessStageResult[];
  observations: PlatformReadinessObservationState;
  findings: ReadinessReportFinding[];
  /** How many findings the run produced, before this projection capped them. */
  totalFindings: number;
  returnedFindings: number;
  /** True when `findings` is a subset. Never left for a reader to infer. */
  truncated: boolean;
};

export const getReadinessReportOperation: PlatformOperation<
  ReadinessRunScopedInput,
  GetReadinessReportResult
> = {
  name: "get_readiness_report",
  title: "Get a directory readiness report",
  description:
    "Read a finished readiness run's findings: what each one requires, whether it was satisfied, violated or never evaluated, and how to fix it. Findings are capped and ordered most-consequential-first; `truncated` and `totalFindings` say when you are seeing a subset. Raw per-finding evidence is not included — read it in the app.",
  readOnly: true,
  inputSchema: readinessRunScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const scope = { projectId: project.id, runId: input.run };
    const [run, report] = await Promise.all([
      client.getReadinessRun(scope, { signal }),
      client.getReadinessReport(scope, { signal }),
    ]);

    const raw = (report ?? {}) as {
      status?: string;
      summary?: string;
      findings?: Array<Record<string, unknown>>;
    };
    const all = Array.isArray(raw.findings) ? raw.findings : [];
    const ranked = [...all].sort((left, right) => {
      const leftRank = READINESS_FINDING_CLASS_ORDER.indexOf(
        String(left.class) as (typeof READINESS_FINDING_CLASS_ORDER)[number],
      );
      const rightRank = READINESS_FINDING_CLASS_ORDER.indexOf(
        String(right.class) as (typeof READINESS_FINDING_CLASS_ORDER)[number],
      );
      // An unknown class sorts last rather than first: a class this build does
      // not know is the one thing that must not displace a known blocker.
      return (
        (leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank) -
        (rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank)
      );
    });
    const findings: ReadinessReportFinding[] = ranked
      .slice(0, READINESS_REPORT_FINDING_CAP)
      .map((finding) => ({
        id: String(finding.id ?? ""),
        title: String(finding.title ?? ""),
        lane: String(finding.lane ?? ""),
        class: String(finding.class ?? ""),
        status: String(finding.status ?? ""),
        ...(typeof finding.provenance === "string"
          ? { provenance: finding.provenance }
          : {}),
        ...(typeof finding.remediation === "string"
          ? { remediation: finding.remediation }
          : {}),
        ...(typeof finding.notEvaluatedReason === "string"
          ? { notEvaluatedReason: finding.notEvaluatedReason }
          : {}),
      }));

    return {
      project: toSelectedProjectInfo(project),
      runId: input.run,
      status: raw.status ?? run.overallStatus ?? "unknown",
      ...(raw.summary ? { summary: raw.summary } : {}),
      lanes: run.lanes,
      stages: run.stages,
      observations: run.llmObservations,
      findings,
      totalFindings: all.length,
      returnedFindings: findings.length,
      truncated: all.length > findings.length,
    };
  },
};

// ── Conformance run operations ───────────────────────────────────────

const conformanceRunScopedInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  run: z.string().trim().min(1).describe("The conformance run's id."),
});

export type ConformanceRunScopedInput = z.infer<
  typeof conformanceRunScopedInput
>;

const startConformanceRunInput = serverScopedInput.extend({
  suites: z
    .array(z.enum(["protocol", "apps", "tasks"]))
    .min(1)
    .optional()
    .describe(
      "Suites to run. Defaults to protocol, apps, and tasks. OAuth is not available on this surface.",
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Replay guard. A retry carrying the same key returns the run it already started rather than dialling the target twice.",
    ),
  protocolVersion: z.string().trim().min(1).optional(),
  engineVersion: z.string().trim().min(1).optional(),
});

export type StartConformanceRunInput = z.infer<typeof startConformanceRunInput>;

export type StartConformanceRunResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  run: PlatformConformanceRunReceipt;
};

export const startConformanceRunOperation: PlatformOperation<
  StartConformanceRunInput,
  StartConformanceRunResult
> = {
  name: "start_conformance_run",
  title: "Start a conformance run",
  description:
    "Run the protocol, apps, and tasks conformance suites against a saved MCP server. Starts a durable run and returns its id — poll `get_conformance_run` for the verdict, which is NOT in this response. OAuth is not available here. Status, outcome, and score are three different answers.",
  readOnly: false,
  risk: "none",
  inputSchema: startConformanceRunInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal,
    );
    const run = await client.startConformanceRun(
      {
        projectId: project.id,
        serverId: server.id,
        ...(input.suites ? { suites: input.suites } : {}),
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
        ...(input.protocolVersion
          ? { protocolVersion: input.protocolVersion }
          : {}),
        ...(input.engineVersion ? { engineVersion: input.engineVersion } : {}),
      },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      run,
    };
  },
};

export type GetConformanceRunResult = {
  project: SelectedProjectInfo;
  run: PlatformConformanceRun;
};

export const getConformanceRunOperation: PlatformOperation<
  ConformanceRunScopedInput,
  GetConformanceRunResult
> = {
  name: "get_conformance_run",
  title: "Get a conformance run",
  description:
    "Read one persisted conformance run. THREE SEPARATE ANSWERS: `status` says whether the run finished, `outcome` is the grade (a completed run can be `failed`), and `score` is the number. `pending` counts checks this profile reported but did not score.",
  readOnly: true,
  inputSchema: conformanceRunScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const run = await client.getConformanceRun(
      { projectId: project.id, runId: input.run },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

const listConformanceRunsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  server: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(SERVER_SELECTOR_DESCRIPTION),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Rows to return, 1-100. Defaults to the API's own page size."),
});

export type ListConformanceRunsInput = z.infer<typeof listConformanceRunsInput>;

export type ListConformanceRunsResult = {
  project: SelectedProjectInfo;
  runs: PlatformConformanceRun[];
};

export const listConformanceRunsOperation: PlatformOperation<
  ListConformanceRunsInput,
  ListConformanceRunsResult
> = {
  name: "list_conformance_runs",
  title: "List conformance runs",
  description:
    "List a project's persisted conformance runs, newest first, optionally narrowed to one saved server. Use it to find a run id when you have a server but not a run.",
  readOnly: true,
  inputSchema: listConformanceRunsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const serverId = input.server
      ? (await resolveLiveServer(client, project, input.server, signal)).id
      : undefined;
    const page = await client.listConformanceRuns(
      {
        projectId: project.id,
        ...(serverId ? { serverId } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), runs: page.items };
  },
};

export type GetConformanceReportResult = {
  project: SelectedProjectInfo;
} & PlatformConformanceReport;

export const getConformanceReportOperation: PlatformOperation<
  ConformanceRunScopedInput,
  GetConformanceReportResult
> = {
  name: "get_conformance_report",
  title: "Get a conformance report",
  description:
    "A bounded projection of a conformance run's failing checks. Failed checks come before could-not-run skips; the list is capped so a model surface is not handed a megabyte-sized report. `pending` on a check means this profile reported it but did not score it.",
  readOnly: true,
  inputSchema: conformanceRunScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const report = await client.getConformanceReport(
      { projectId: project.id, runId: input.run },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), ...report };
  },
};

// ── Eval operations ──────────────────────────────────────────────────

// Declared HERE, above the run operations that reference it, rather than beside
// the eval-EDIT operations further down where its siblings live: every input
// schema in this file is built at module-init time, so a later `const` would be
// in its temporal dead zone and importing this module would throw.
const publicMatchOptionsSchema = z
  .object({
    toolCallOrder: z
      .enum(["any", "in-order", "exact"])
      .optional()
      .describe(
        "any = order ignored; in-order = expected calls appear in order (extras allowed); exact = exact sequence.",
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

const SUITE_SELECTOR_DESCRIPTION = "Eval suite name or ID.";
// Declared here rather than beside the environment operations further down
// because the eval inputs below are built at module-init time and would hit the
// temporal dead zone of a later `const`.
const ENVIRONMENT_SELECTOR_DESCRIPTION = "Project environment name or ID.";
const SUITE_ENVIRONMENT_SELECTOR_DESCRIPTION =
  "Project environment name or ID. Must be one the suite has attached (set them with set_eval_suite_environments). Omit it when the suite has exactly one attached environment — that one is used; a suite with several requires naming one. Mutually exclusive with `servers`: an environment supplies its own closed server set.";

// Unlike the listing operations, the run-polling reads do NOT default the
// project: a run is an existing resource in one specific project, and
// guessing "most recently updated" makes a run in any other project read as
// NOT_FOUND. run_eval_suite and list_eval_suite_runs return the resolved
// project precisely so callers can address the polls exactly.
const RUN_PROJECT_DESCRIPTION =
  "Project the run belongs to (name or ID), as returned by run_eval_suite or list_eval_suite_runs.";

/**
 * A caller-input problem the SDK can see without a round trip. Carries the same
 * `VALIDATION_ERROR` code the API would return, so surfaces render it
 * identically. Guards live in `execute` bodies, not `.refine()`, because the
 * CLI calls `execute` directly and never parses the input schema — a
 * refine-only guard would simply not fire there.
 */
function operationInputError(message: string): PlatformApiError {
  return new PlatformApiError(message, "VALIDATION_ERROR", { status: 0 });
}

/**
 * `environment` and `servers` are mutually exclusive on every eval operation
 * that takes both: an environment's closed server set is the whole point, so
 * honoring an override alongside it would connect one set while the platform
 * stamps another. Rejected here AND at the route — this call fails before the
 * request is even built, so the caller gets the reason without spending a
 * round trip.
 */
function assertNoServerOverrideWithEnvironment(input: {
  environment?: string;
  servers?: string[];
}): void {
  if (input.environment && (input.servers?.length ?? 0) > 0) {
    throw operationInputError(
      "Pass either environment or servers, not both — a project environment supplies its own closed server set, which servers cannot override.",
    );
  }
}

/**
 * Reject every ambiguous COMBINATION of target selectors before anything
 * resolves.
 *
 * All of these are refusals rather than a precedence rule, and deliberately so:
 * each pair describes two different launches, and silently picking one would
 * spend on a run the caller did not ask for. `servers` × a target axis is the
 * same rejection the platform makes (an environment or host supplies its own
 * closed server set), raised here so it costs no round trip.
 */
function assertRunTargetSelectorsCoherent(input: {
  servers?: string[];
  environment?: string;
  environments?: string[];
  host?: string;
  hosts?: string[];
  allAttached?: boolean;
  compose?: unknown;
}): void {
  const hasEnvironmentAxis =
    Boolean(input.environment) || (input.environments?.length ?? 0) > 0;
  const hasHostAxis = Boolean(input.host) || (input.hosts?.length ?? 0) > 0;

  // `compose` DESCRIBES a target rather than selecting one, so it cannot be
  // combined with any selector. Rejected loudly because the alternative is
  // worse than usual here: composing has a persistent side effect (a new
  // environment, attached to the suite), so silently ignoring it would edit
  // the suite for a run that did not use the result.
  if (
    input.compose &&
    (hasEnvironmentAxis ||
      hasHostAxis ||
      (input.servers?.length ?? 0) > 0 ||
      input.allAttached)
  ) {
    throw operationInputError(
      "Pass compose OR a target selector, not both — compose builds the execution stack the run uses, so naming an environment, host, server override or allAttached alongside it describes two different runs.",
    );
  }

  if (input.environment && (input.environments?.length ?? 0) > 0) {
    throw operationInputError(
      "Pass either environment (one) or environments (several), not both.",
    );
  }
  if (input.host && (input.hosts?.length ?? 0) > 0) {
    throw operationInputError(
      "Pass either host (one) or hosts (several), not both.",
    );
  }
  if (hasEnvironmentAxis && hasHostAxis) {
    throw operationInputError(
      "Pass environments or hosts, not both — a run targets ONE axis, and an environment already resolves a host, so combining them would describe a configuration the suite never had.",
    );
  }
  if (hasEnvironmentAxis && (input.servers?.length ?? 0) > 0) {
    // The singular case is also caught by
    // `assertNoServerOverrideWithEnvironment` (which the ops without a plural
    // selector still use); this covers the PLURAL axis with the identical
    // message, so a caller sees one rule however they spelled the selector.
    // Without it, `environments` + `servers` cleared every guard and the
    // server override then suppressed the suite-detail read — so the caller
    // was told the suite "has no environments at all" about a suite that has
    // the named one attached.
    throw operationInputError(
      "Pass either environment or servers, not both — a project environment supplies its own closed server set, which servers cannot override.",
    );
  }
  if (hasHostAxis && (input.servers?.length ?? 0) > 0) {
    throw operationInputError(
      "Pass either a host or servers, not both — running an attached host uses that host's own configured server set, which servers cannot override.",
    );
  }
  if (input.allAttached && (hasEnvironmentAxis || hasHostAxis)) {
    throw operationInputError(
      "Pass allAttached or name targets explicitly, not both — 'every attached target' and 'these ones' cannot both be meant, and guessing would either skip a run you asked for or start one you did not.",
    );
  }
  if (input.allAttached && (input.servers?.length ?? 0) > 0) {
    throw operationInputError(
      "Pass allAttached or servers, not both — a server override replaces the suite's selection for one run and has no fan-out.",
    );
  }
}

/**
 * The TARGET_REQUIRED refusal, enumerating what is actually pickable.
 *
 * Named after the machine-readable code so a surface can match on it, and
 * written so the caller never has to go look the choices up: the whole failure
 * mode this replaces was an agent guessing a target because the error did not
 * say which ones existed.
 */
function targetRequiredMessage(plan: {
  attachedEnvironments: RunTarget[];
  attachedHosts: RunTarget[];
}): string {
  const parts: string[] = [];
  if (plan.attachedEnvironments.length > 0) {
    parts.push(
      `environments: ${plan.attachedEnvironments
        .map((target) =>
          target.name ? `"${target.name}" (${target.id})` : target.id,
        )
        .join(", ")}`,
    );
  }
  if (plan.attachedHosts.length > 0) {
    parts.push(
      `hosts: ${plan.attachedHosts
        .map((target) => `"${target.name}" (${target.id})`)
        .join(", ")}`,
    );
  }
  return (
    "TARGET_REQUIRED — this suite has several attached targets, so which one to run is ambiguous and running all of them would spend more than you may have meant. " +
    `Attached ${parts.join("; ")}. ` +
    "Name one with environment or host, several with environments or hosts, or run every attached target with allAttached (one PAID RUN per target)."
  );
}

/**
 * Resolve environment selectors to ids AND check attachment CLIENT-SIDE.
 *
 * The attachment check is not redundant with the platform's: a fan-out issues
 * one request per target, so an unattached fourth target would otherwise be
 * discovered only after the first three had started spending. Failing here
 * costs nothing and leaves nothing running.
 */
async function resolveSuiteEnvironmentTargets(
  client: PlatformApiClient,
  project: PlatformProject,
  suite: PlatformEvalSuite,
  detail: PlatformEvalSuiteDetail | undefined,
  selectors: string[],
  signal: AbortSignal | undefined,
): Promise<Array<{ id: string; name?: string }>> {
  if (selectors.length === 0) return [];
  const attached = detail?.environmentIds ?? [];
  const resolved: Array<{ id: string; name?: string }> = [];
  for (const selector of selectors) {
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      selector,
      signal,
    );
    if (!attached.includes(environment.id)) {
      throw operationInputError(
        attached.length === 0
          ? `Environment "${selector}" is not attached to suite "${
              suite.name ?? suite.id
            }", which has no environments at all. Attach it with set_eval_suite_environments first.`
          : `Environment "${selector}" is not attached to suite "${
              suite.name ?? suite.id
            }". Attached environment IDs: ${attached.join(", ")}.`,
      );
    }
    resolved.push({
      id: environment.id,
      ...(environment.name ? { name: environment.name } : {}),
    });
  }
  return resolved;
}

/**
 * Display names for a suite's attached environment ids.
 *
 * BEST EFFORT on purpose: these names are read by people, never matched on, so
 * a listing that fails or omits a row costs a nicer message and nothing else.
 * Failing the launch over it would trade a real run for a cosmetic lookup.
 */
async function environmentNamesFor(
  client: PlatformApiClient,
  project: PlatformProject,
  environmentIds: string[],
  signal: AbortSignal | undefined,
): Promise<Map<string, string>> {
  if (environmentIds.length === 0) return new Map();
  try {
    const page = await client.listEnvironments(
      { projectId: project.id },
      { signal },
    );
    const wanted = new Set(environmentIds);
    return new Map(
      page.items
        .filter((environment) => wanted.has(environment.id) && environment.name)
        .map((environment) => [environment.id, environment.name]),
    );
  } catch {
    return new Map();
  }
}

/** Host selectors → attached hosts, by id or unique name. Same rationale as
 *  the environment resolver above: validated here so a fan-out cannot spend on
 *  its first targets and then discover a bad one. */
function resolveSuiteHostTargets(
  suite: PlatformEvalSuite,
  detail: PlatformEvalSuiteDetail | undefined,
  selectors: string[],
): RunTargetHost[] {
  if (selectors.length === 0) return [];
  const hosts = detail?.hosts ?? [];
  if (hosts.length === 0) {
    throw operationInputError(
      `Suite "${
        suite.name ?? suite.id
      }" has no attached hosts, so there is no host to run. Attach one to the suite first, or omit the host selector.`,
    );
  }
  return selectors.map((selector) =>
    resolveByIdOrName(
      hosts,
      selector,
      "Suite host",
      `suite "${suite.name ?? suite.id}"`,
    ),
  );
}

/** The knobs both launch shapes forward, in the wire's own vocabulary. */
function runKnobBody(
  input: {
    iterations?: number;
    notes?: string;
    minPassRate?: number;
    matchOptions?: z.infer<typeof publicMatchOptionsSchema>;
    excludeSkills?: boolean;
    idempotencyKey?: string;
  },
  caseIds: string[] | undefined,
): Record<string, unknown> {
  return {
    ...(input.iterations !== undefined
      ? { iterationOverride: input.iterations }
      : {}),
    ...(caseIds ? { caseIds } : {}),
    ...(input.matchOptions ? { matchOptionsOverride: input.matchOptions } : {}),
    ...(input.excludeSkills ? { skillsOverride: "exclude" as const } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.minPassRate !== undefined
      ? { passCriteria: { minimumPassRate: input.minPassRate } }
      : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };
}

/** What a `compose` produced, plus the report the result carries. */
interface ComposedRunEnvironment {
  environment: { id: string };
  report: {
    environment: { id: string; name: null; adhoc: true; created: boolean };
    attachment: { attached: boolean };
  };
}

/**
 * Turn a composed stack into a runnable target: ensure the ad-hoc environment,
 * then ATTACH it to the suite.
 *
 * THE ATTACHMENT IS DELIBERATE AND VISIBLE, not incidental. It is what makes
 * the run reproducible from the app afterwards — an environment the suite does
 * not list is one nobody can re-run from the UI — and it mirrors what the app's
 * own composer does when a user edits a pill. Both operations say so in their
 * descriptions, because a caller must not discover it from a changed suite.
 *
 * Appended ATOMICALLY rather than read-modify-write: the replace door would
 * silently detach an environment someone else attached between the read and
 * the write, and this path attaches on every launch.
 */
async function composeRunEnvironment(
  client: PlatformApiClient,
  project: PlatformProject,
  suite: PlatformEvalSuite,
  stack: {
    host: string;
    serverGroup?: string;
    model?: string;
    computer?: string;
    skills?: { mode: "explicit"; skillIds: string[] };
    pluginVersionIds?: string[];
  },
  signal: AbortSignal | undefined,
): Promise<ComposedRunEnvironment> {
  const body = await resolveComposeStack(client, project, stack, signal);
  const ensured = await client.ensureAdhocEnvironment(
    { projectId: project.id, body },
    { signal },
  );
  const attachment = await client.attachEvalSuiteEnvironment(
    {
      projectId: project.id,
      suiteId: suite.id,
      environmentId: ensured.environment.id,
    },
    { signal },
  );
  return {
    environment: { id: ensured.environment.id },
    report: {
      environment: {
        id: ensured.environment.id,
        name: null,
        adhoc: true,
        created: ensured.created === true,
      },
      attachment: { attached: attachment.attached === true },
    },
  };
}

/**
 * Launch, and on failure make sure the caller still learns what compose
 * PERSISTED.
 *
 * A compose-and-run writes before it spends: it ensures an environment and
 * edits the suite's attachment list. If the launch then throws, an unannotated
 * error leaves the caller believing nothing happened — when in fact their suite
 * changed. So the persisted outcomes ride on the thrown error's details, where
 * every surface already renders them.
 */
async function createEvalRunOrReportCompose<T>(
  composed: ComposedRunEnvironment | undefined,
  launch: () => Promise<T>,
): Promise<T> {
  if (!composed) return launch();
  try {
    return await launch();
  } catch (error) {
    const note = `(The composed environment ${
      composed.report.environment.id
    } was ${composed.report.environment.created ? "created" : "reused"} and ${
      composed.report.attachment.attached
        ? "attached to the suite"
        : "was already attached"
    }; retrying is safe — it will reuse both.)`;
    if (error instanceof PlatformApiError) {
      throw new PlatformApiError(`${error.message} ${note}`, error.code, {
        status: error.status,
        // STRUCTURED as well as prose: a human reads the sentence, and an
        // agent surface deciding whether to warn about a suite edit needs a
        // field. `retryAfter`/`endpoint` ride along because dropping them
        // would turn a rate-limit into an un-retryable one on this path only.
        details: { ...(error.details ?? {}), composed: composed.report },
        ...(error.retryAfter !== undefined
          ? { retryAfter: error.retryAfter }
          : {}),
        ...(error.endpoint !== undefined ? { endpoint: error.endpoint } : {}),
      });
    }
    // A non-API failure (the connection dropped, the request was aborted)
    // persisted the SAME two writes, so it owes the caller the same report.
    // Annotated IN PLACE rather than rewrapped: an abort must stay an abort —
    // callers match on `name`/`instanceof` to tell "I cancelled this" from "it
    // broke", and a wrapper would make every such check miss.
    if (error instanceof Error) {
      error.message = `${error.message} ${note}`;
      Object.assign(error, { composed: composed.report });
    }
    throw error;
  }
}

/**
 * Call the grouped-launch endpoint, translating "this server does not have it"
 * into an instruction rather than a raw NOT_FOUND.
 *
 * The SDK publishes independently of the hosted API, so a client can legitimately
 * be newer than the server it is pointed at. A bare 404 there reads as "your
 * suite does not exist", which sends the caller looking in the wrong place.
 */
async function createEvalRunGroupOrExplain(
  client: PlatformApiClient,
  projectId: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<PlatformEvalRunGroupCreated> {
  try {
    return await client.createEvalRunGroup({ projectId, body }, { signal });
  } catch (error) {
    // A ROUTE MISS specifically, not every 404. The route itself 404s for real
    // reasons — the suite was deleted between resolving it and launching, or
    // project access was revoked — and telling that caller to wait for a server
    // upgrade that already happened sends them to fix the wrong thing. Only a
    // missing route answers without the v1 error envelope, which is exactly
    // what the generic fallback message below means.
    if (
      error instanceof PlatformApiError &&
      error.status === 404 &&
      error.details === undefined &&
      /^Request to .* failed \(404\)$/.test(error.message)
    ) {
      throw new PlatformApiError(
        "This MCPJam server is too old for grouped eval-run launches. Run the targets one at a time (name a single environment or host per call) until it is upgraded.",
        "NOT_FOUND",
        { status: 404 },
      );
    }
    throw error;
  }
}

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
      signal,
    );
    const page = await client.listEvalSuites(
      { projectId: project.id },
      { signal },
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
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const page = await client.listEvalSuiteRuns(
      { projectId: project.id, suiteId: suite.id, limit: input.limit },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      suite: { id: suite.id, name: suite.name },
      items: page.items,
    };
  },
};

/**
 * Knobs that apply to a run whatever it targets. Declared once and spread into
 * both run inputs: a knob that exists on the suite op and not the case op is a
 * knob callers have to remember two rules for, and the divergence is invisible
 * until someone hits it.
 */
/**
 * A COMPOSED run target: assemble a stack instead of naming a saved
 * environment. Declared here, above the run inputs, for the same
 * temporal-dead-zone reason `publicMatchOptionsSchema` is.
 *
 * The stack resolves to an ad-hoc (unnamed, content-addressed) environment and
 * then launches through the ORDINARY environment path — same resolution, same
 * immutable snapshot. There is deliberately no "override the model for this
 * run" field: that would be a second execution-context channel with none of an
 * environment's guarantees.
 */
const composeRunTargetInput = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Host (name or ID) the composed stack runs as — the client whose configuration the run is stamped with.",
      ),
    serverGroup: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Standalone server group to pin (by ID). Omit to use the host's own servers.",
      ),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Model to run instead of the host's pinned one. Stored verbatim.",
      ),
    computer: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Sandbox image (name or ID) to pin, so the run boots a fresh computer from it. Must be project-shared.",
      ),
    skills: z
      .object({
        mode: z.literal("explicit"),
        skillIds: z.array(z.string().trim().min(1)).min(1),
      })
      .optional()
      .describe("Explicit pinned skill selection for the composed stack."),
    pluginVersionIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe("Plugin VERSION IDs to pin for the composed stack."),
  })
  .describe(
    "Compose an execution stack to run instead of naming a saved environment. THIS EDITS THE SUITE: the composed environment is appended to the suite's environment list, which is what makes the run reproducible from the app afterwards. Deduplicated by content, so composing the same stack twice reuses one environment. Mutually exclusive with environment/environments/host/hosts/servers/allAttached.",
  );

const RUN_KNOB_FIELDS = {
  iterations: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Run each case this many times, overriding its saved iteration count FOR THIS RUN ONLY (the suite is untouched). Multiplies what the run costs.",
    ),
  notes: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Free-text note stored on the run, for your own attribution."),
  minPassRate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Pass threshold for this run as a percentage (0-100), overriding the suite's own criterion.",
    ),
  matchOptions: publicMatchOptionsSchema
    .optional()
    .describe(
      "Tool-call match options for this run only, layered over suite defaults and per-case overrides. Does NOT edit the suite or its cases.",
    ),
  excludeSkills: z
    .boolean()
    .optional()
    .describe(
      "Run the 'without skills' arm of an A/B comparison: NO skills are pinned from any channel and the run is labelled as excluded, rather than merely being skill-free. Scoped to skill delivery — a pinned plugin's MCP servers stay connected, because which servers an arm connects is the one variable a skills A/B has to hold fixed.",
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Retry-safety key. Repeating a call with the same key returns the run it already started instead of starting (and billing) a second one. On a multi-target launch the key covers the whole group: a retry returns the same group and the same runs.",
    ),
} as const;

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
      "Project server names or IDs to override the suite's saved server selection. When omitted, the platform connects exactly the servers the suite was configured with. Naming a server explicitly overrides its disabled toggle — the run connects to it and consumes credits all the same; stdio servers can never run hosted.",
    ),
  environment: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(SUITE_ENVIRONMENT_SELECTOR_DESCRIPTION),
  environments: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe(
      "Several attached environments to run, one PAID RUN EACH, grouped. Every name or ID must be attached to the suite. Use `environment` for exactly one; passing both is an error.",
    ),
  host: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "One host ATTACHED to the suite (name or ID) to run against. The run is stamped with that host's configuration; without it a suite with several attached hosts cannot be run at all, and one with exactly one runs against it automatically. Mutually exclusive with the environment selectors and with `servers`.",
    ),
  hosts: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe(
      "Several attached hosts to run, one PAID RUN EACH, grouped. Every name or ID must be attached to the suite. Use `host` for exactly one; passing both is an error.",
    ),
  allAttached: z
    .boolean()
    .optional()
    .describe(
      "Run EVERY attached environment (or, when the suite has none, every attached host), one run per target, grouped under a single launch. THIS LAUNCHES MULTIPLE PAID RUNS — one per target, each consuming credits. Cannot be combined with naming targets explicitly: 'all of them' and 'these ones' cannot both be meant.",
    ),
  cases: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe(
      "Run only these cases (titles or IDs) instead of the whole suite. The suite itself is untouched.",
    ),
  refreshSnapshot: z
    .boolean()
    .optional()
    .describe(
      "PERSISTS A NEW HOST-CONFIG SNAPSHOT ON THE SUITE, changing what every future run of it uses — not just this one. Without it a rerun leaves the snapshot frozen, which is what stops newly connected servers from silently contaminating an existing suite. Single-target runs only; rejected with any multi-target launch, where last-writer-wins on a frozen snapshot is never what was meant.",
    ),
  compose: composeRunTargetInput.optional(),
  ...RUN_KNOB_FIELDS,
});

export type RunEvalSuiteInput = z.infer<typeof runEvalSuiteInput>;

/** One target's outcome, discriminated on `status`. See `targets` below. */
export type RunEvalTargetResult =
  | {
      status: "started";
      environment?: PlatformEvalRunCreated["environment"];
      host?: { id: string; name: string };
      runId: string;
      runStatus: string;
      servers?: Array<{ id: string; name?: string }>;
      caseUpsert?: PlatformEvalRunCreated["caseUpsert"];
    }
  | {
      status: "failed";
      environment?: PlatformEvalRunCreated["environment"];
      host?: { id: string; name: string };
      error: { code: string; message: string };
    };

export type RunEvalSuiteResult = {
  project: SelectedProjectInfo;
  suite: { id: string; name: string | null };
  /**
   * `"started"` — every target launched; `"partial"` — some did and some did
   * not; `"failed"` — none did.
   *
   * A SINGLE-target run is always `"started"`, because its failures throw:
   * there is one thing the caller asked for, and reporting "it failed" in a
   * resolved value would make every caller check a field to find out whether
   * their one action happened. A multi-target launch cannot do that — aborting
   * on the first failure would strand its already-started siblings unreported —
   * so it resolves with the receipt and the caller reads `outcome`.
   */
  outcome: "started" | "partial" | "failed";
  startedCount: number;
  failedCount: number;
  /** Set only on a grouped launch. Sibling runs share it. */
  runGroupId?: string;
  /**
   * What `compose` PERSISTED, reported even when the launch itself failed.
   *
   * A compose-and-run has side effects before it spends: it ensures an ad-hoc
   * environment and attaches it to the suite. A caller whose launch then fails
   * still needs to know the suite's attachment list changed — and that a retry
   * will hit the dedupe and no-op paths rather than composing again.
   */
  composed?: {
    environment: { id: string; name: null; adhoc: true; created: boolean };
    attachment: { attached: boolean };
  };
  /** One entry per target, in launch order. */
  targets: RunEvalTargetResult[];
  /**
   * @deprecated Mirrors of the FIRST started run, kept so callers written
   * against the single-run shape keep working. Read `targets` instead — on a
   * grouped launch these describe one run out of several.
   */
  runId?: string;
  /** @deprecated See `runId`. */
  status?: string;
  /** @deprecated See `runId`. */
  servers?: Array<{ id: string; name?: string }>;
  /** @deprecated See `runId`. */
  environment?: PlatformEvalRunCreated["environment"];
  /** @deprecated See `runId`. */
  caseUpsert?: PlatformEvalRunCreated["caseUpsert"];
};

export const runEvalSuiteOperation: PlatformOperation<
  RunEvalSuiteInput,
  RunEvalSuiteResult
> = {
  name: "run_eval_suite",
  title: "Run MCPJam eval suite",
  description:
    "Start an asynchronous rerun of an existing eval suite. Returns immediately; poll get_eval_run with the returned project and runId until status is completed, failed, or cancelled. Eval runs execute LLM iterations and CONSUME the organization's credits or configured provider keys.\n\nWHICH TARGET RUNS is explicit, never guessed. A suite with nothing attached runs its saved server selection. A suite with exactly ONE attached environment or host runs against that one automatically. A suite with SEVERAL fails with TARGET_REQUIRED, listing them — name one with environment or host, several with environments or hosts, or every one with allAttached. Each named target is a separate paid run.\n\nA multi-target launch returns a group receipt: outcome (started | partial | failed), startedCount, failedCount, and one entry per target that either started (with its runId) or failed (with its reason). A failed target does not abort its siblings, so read outcome rather than assuming everything started.",
  readOnly: false,
  risk: "spend",
  inputSchema: runEvalSuiteInput,
  async execute(input, { client, signal }) {
    // ── Guards first: reject every ambiguous combination BEFORE resolving
    // anything, so a caller who meant two different things is told so without
    // spending a round trip — let alone a run.
    assertNoServerOverrideWithEnvironment(input);
    assertRunTargetSelectorsCoherent(input);

    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);

    // No client-side server default: the platform derives the suite's saved
    // selection when serverIds is omitted — the exact set the run snapshot
    // references, which a project-wide guess here could miss.
    const overrideServers = input.servers
      ? await resolveRunServers(client, project, input.servers, signal)
      : undefined;

    // Case selectors resolve BEFORE compose, because compose WRITES. Every
    // read that can reject the request has to happen while rejecting is still
    // free: a mistyped case name after an ad-hoc environment had been created
    // and attached would leave the suite edited for a run that never started,
    // and the error would say nothing about it.
    const caseIds = input.cases
      ? (await resolveCases(client, project, suite, input.cases, signal)).map(
          (testCase) => testCase.id,
        )
      : undefined;

    // COMPOSE runs before anything else target-shaped, because it PRODUCES the
    // target: the stack becomes an ad-hoc environment, the environment is
    // appended to the suite, and the launch then takes the ordinary pinned-
    // environment path. Its two writes are reported even if the launch fails.
    const composed = input.compose
      ? await composeRunEnvironment(
          client,
          project,
          suite,
          input.compose,
          signal,
        )
      : undefined;

    // The suite DETAIL carries both attachment axes in attach order, so the
    // targets compute from one read. Skipped on the two paths that have no
    // axis to read: an explicit server override is a single legacy run by
    // construction, and a composed stack has already PRODUCED its target — for
    // either of them the attachments are simply not consulted, so fetching
    // them would be a round trip spent on an answer nobody reads.
    const detail =
      overrideServers || composed
        ? undefined
        : await client.getEvalSuite(
            { projectId: project.id, suiteId: suite.id },
            { signal },
          );

    const selectedEnvironments = await resolveSuiteEnvironmentTargets(
      client,
      project,
      suite,
      detail,
      input.environment ? [input.environment] : input.environments ?? [],
      signal,
    );
    const selectedHosts = resolveSuiteHostTargets(
      suite,
      detail,
      input.host ? [input.host] : input.hosts ?? [],
    );

    // Attached environments arrive as bare IDS — the suite detail carries no
    // names — and every place they surface is one a person reads: the
    // TARGET_REQUIRED refusal listing what is pickable, and a fan-out receipt
    // naming which target failed. One listing buys names for both; an id that
    // no longer resolves degrades to itself rather than failing the run.
    const attachedEnvironmentNames = await environmentNamesFor(
      client,
      project,
      detail?.environmentIds ?? [],
      signal,
    );

    // A composed stack IS the target — it produced an environment, so there is
    // nothing left to select between and the attachment axes do not apply.
    const plan: RunTargetPlan = composed
      ? {
          kind: "single",
          target: { kind: "environment", id: composed.environment.id },
        }
      : computeRunTargets({
          attachedEnvironments: (detail?.environmentIds ?? []).map((id) => ({
            id,
            ...(attachedEnvironmentNames.get(id)
              ? { name: attachedEnvironmentNames.get(id)! }
              : {}),
          })),
          attachedHosts: (detail?.hosts ?? []).map((host) => ({
            id: host.id,
            name: host.name,
          })),
          selectedEnvironments,
          selectedHosts,
          ...(input.allAttached !== undefined
            ? { allAttached: input.allAttached }
            : {}),
          ...(overrideServers
            ? { serverIds: overrideServers.map((server) => server.id) }
            : {}),
        });

    if (plan.kind === "target-required") {
      throw operationInputError(targetRequiredMessage(plan));
    }
    if (plan.kind === "group" && input.refreshSnapshot) {
      throw operationInputError(
        "refreshSnapshot cannot be used with a multi-target launch — it PERSISTS one host-config snapshot on the suite, and several runs racing to write it would leave the suite pinned to whichever finished last. Run one target at a time to refresh it.",
      );
    }

    const knobs = runKnobBody(input, caseIds);
    const projectInfo = toSelectedProjectInfo(project);
    const suiteInfo = { id: suite.id, name: suite.name };

    if (plan.kind === "single") {
      const created = await createEvalRunOrReportCompose(composed, () =>
        client.createEvalRun(
          {
            projectId: project.id,
            body: {
              suiteId: suite.id,
              ...(plan.serverIds ? { serverIds: plan.serverIds } : {}),
              ...(plan.target?.kind === "environment"
                ? { environmentId: plan.target.id }
                : {}),
              ...(plan.target?.kind === "host"
                ? { namedHostId: plan.target.id }
                : {}),
              ...(input.refreshSnapshot ? { refreshSnapshot: true } : {}),
              ...knobs,
            },
          },
          { signal },
        ),
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
      const host =
        plan.target?.kind === "host"
          ? { id: plan.target.id, name: plan.target.name }
          : undefined;
      return {
        project: projectInfo,
        suite: suiteInfo,
        outcome: "started",
        startedCount: 1,
        failedCount: 0,
        ...(composed ? { composed: composed.report } : {}),
        targets: [
          {
            status: "started",
            environment: created.environment ?? null,
            ...(host ? { host } : {}),
            runId: created.runId,
            runStatus: created.status,
            servers,
            caseUpsert: created.caseUpsert,
          },
        ],
        runId: created.runId,
        status: created.status,
        servers,
        environment: created.environment ?? null,
        caseUpsert: created.caseUpsert,
      };
    }

    const group = await createEvalRunGroupOrExplain(
      client,
      project.id,
      {
        suiteId: suite.id,
        targets: plan.targets.map((target) =>
          target.kind === "environment"
            ? { environmentId: target.id }
            : { namedHostId: target.id },
        ),
        ...knobs,
      },
      signal,
    );

    const nameById = new Map(
      plan.targets.map((target) => [target.id, target.name]),
    );
    const targets: RunEvalTargetResult[] = group.targets.map((entry) => {
      const id = entry.target.namedHostId ?? entry.target.environmentId ?? "";
      const host = entry.target.namedHostId
        ? {
            id: entry.target.namedHostId,
            name: entry.target.name ?? nameById.get(id) ?? "",
          }
        : undefined;
      if (entry.status === "failed") {
        return {
          status: "failed",
          ...(host ? { host } : {}),
          // A failed target still has to say WHICH target it was. A started
          // entry carries the pinned environment the platform echoes back;
          // a failed one never launched, so there is no pinned revision to
          // report — but the id and the name the caller selected by are both
          // in hand, and without them the receipt reads "something failed".
          ...(entry.target.environmentId
            ? {
                environment: {
                  id: entry.target.environmentId,
                  name: entry.target.name ?? nameById.get(id) ?? null,
                  revision: null,
                },
              }
            : {}),
          error: entry.error,
        };
      }
      return {
        status: "started",
        environment: entry.environment ?? null,
        ...(host ? { host } : {}),
        runId: entry.runId,
        runStatus: entry.runStatus,
        ...(entry.servers ? { servers: entry.servers } : {}),
        ...(entry.caseUpsert ? { caseUpsert: entry.caseUpsert } : {}),
      };
    });
    const firstStarted = targets.find(
      (target): target is Extract<RunEvalTargetResult, { status: "started" }> =>
        target.status === "started",
    );
    return {
      project: projectInfo,
      suite: suiteInfo,
      // NOT thrown, even when every target failed. The receipt carries each
      // target's own reason, and throwing would discard exactly the detail the
      // caller needs — including which siblings DID start. The op throws only
      // when the HTTP call itself fails.
      outcome: group.outcome,
      startedCount: group.startedCount,
      failedCount: group.failedCount,
      runGroupId: group.runGroupId,
      targets,
      ...(firstStarted
        ? {
            runId: firstStarted.runId,
            status: firstStarted.runStatus,
            ...(firstStarted.servers ? { servers: firstStarted.servers } : {}),
            environment: firstStarted.environment ?? null,
            ...(firstStarted.caseUpsert
              ? { caseUpsert: firstStarted.caseUpsert }
              : {}),
          }
        : {}),
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
      "Project server names or IDs to override the suite's saved server selection for this run. When omitted, the platform connects exactly the servers the suite was configured with.",
    ),
  environment: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(SUITE_ENVIRONMENT_SELECTOR_DESCRIPTION),
  host: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "One host ATTACHED to the suite (name or ID) to run this case against, so the run is stamped with that host's configuration. Mutually exclusive with `environment` and `servers`.",
    ),
  compose: composeRunTargetInput.optional(),
  iterations: RUN_KNOB_FIELDS.iterations,
  idempotencyKey: RUN_KNOB_FIELDS.idempotencyKey,
});

export type RunEvalCaseInput = z.infer<typeof runEvalCaseInput>;

export type RunEvalCaseResult = {
  project: SelectedProjectInfo;
  suite: { id: string; name: string | null };
  case: { id: string; title: string | null };
  servers: Array<{ id: string; name?: string }>;
  /** The environment the run is pinned to; see `RunEvalSuiteResult`. */
  environment: PlatformEvalRunCreated["environment"];
  /** The attached host the run is stamped with, when one was named. */
  host?: { id: string; name: string };
  /** See `RunEvalSuiteResult.composed`. */
  composed?: {
    environment: { id: string; name: null; adhoc: true; created: boolean };
    attachment: { attached: boolean };
  };
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
    "Start an asynchronous run of ONE case in an existing eval suite — a persisted, fully-queryable run scoped to just that case (inspect it with get_eval_run / list_eval_run_iterations / get_eval_run_steps, same as a full run). For a suite with attached project environments, pass environment to choose which one runs; for one with attached hosts, pass host so the run is stamped with that host's configuration. Returns a runId immediately; poll get_eval_run until terminal. CONSUMES credits like any eval run.",
  readOnly: false,
  risk: "spend",
  inputSchema: runEvalCaseInput,
  async execute(input, { client, signal }) {
    assertNoServerOverrideWithEnvironment(input);
    assertRunTargetSelectorsCoherent(input);
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const testCase = await resolveCase(
      client,
      project,
      suite,
      input.case,
      signal,
    );
    const overrideServers = input.servers
      ? await resolveRunServers(client, project, input.servers, signal)
      : undefined;
    const composed = input.compose
      ? await composeRunEnvironment(
          client,
          project,
          suite,
          input.compose,
          signal,
        )
      : undefined;
    const environment = input.environment
      ? await resolveEnvironmentSelector(
          client,
          project,
          input.environment,
          signal,
        )
      : undefined;
    // The suite detail is read ONLY when a host was named — a case run is
    // otherwise unchanged, and paying for an extra request on every call to
    // support an optional selector would be a tax on the common path.
    const host = input.host
      ? resolveSuiteHostTargets(
          suite,
          await client.getEvalSuite(
            { projectId: project.id, suiteId: suite.id },
            { signal },
          ),
          [input.host],
        )[0]!
      : undefined;
    const created = await createEvalRunOrReportCompose(composed, () =>
      client.createEvalRun(
        {
          projectId: project.id,
          body: {
            suiteId: suite.id,
            caseIds: [testCase.id],
            ...(overrideServers
              ? { serverIds: overrideServers.map((server) => server.id) }
              : {}),
            // MUTUALLY EXCLUSIVE, and enforced above by
            // `assertRunTargetSelectorsCoherent`: `compose` with `environment`
            // is refused before this point, so the repeated key can never
            // resolve silently to whichever spread came last.
            ...(composed ? { environmentId: composed.environment.id } : {}),
            ...(environment ? { environmentId: environment.id } : {}),
            ...(host ? { namedHostId: host.id } : {}),
            ...(input.iterations !== undefined
              ? { iterationOverride: input.iterations }
              : {}),
            ...(input.idempotencyKey
              ? { idempotencyKey: input.idempotencyKey }
              : {}),
          },
        },
        { signal },
      ),
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
      environment: created.environment ?? null,
      ...(host ? { host } : {}),
      ...(composed ? { composed: composed.report } : {}),
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

const evalCaseInput = z.object({
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
      "Ordered test steps (prompt / toolCall / interact / assert). The first `prompt` step's text is the case query; `toolCalledWith` asserts are the expected tool calls.",
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
    .describe("Per-case system prompt / temperature / tool-choice overrides."),
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
      "Per-case provider override; defaults to the suite-level provider.",
    ),
});

// STRICT: `--json` / MCP args that invent a top-level key must fail
// validation, not be stripped before the request is built.
const createEvalSuiteInput = z.strictObject({
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
      "Project server names or IDs the suite runs against. Must be HTTP servers; stdio servers can never run hosted.",
    ),
  model: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Suite-level default model applied to every case, e.g. "anthropic/claude-haiku-4.5". Use a hosted model id, or a provider-prefixed id with the matching provider.',
    ),
  provider: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Suite-level default provider. Optional when the model id is provider-prefixed (the provider is derived from the first path segment).",
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
      signal,
    );
    const servers = await resolveRunServers(
      client,
      project,
      input.servers,
      signal,
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
      { signal },
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

const publicCheckSchema = z
  .object({ type: z.string().trim().min(1) })
  .passthrough()
  .describe(
    "A deterministic check; `type` is the check kind (e.g. responseContains, toolCalledWith) and remaining fields depend on it.",
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
      "Ordered test steps (prompt / toolCall / interact / assert). Replaces the case body wholesale when provided.",
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
  input: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(caseFieldsShape);
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  return body;
}

/**
 * The case's declared identity, accepted on CREATE only.
 *
 * Not part of `caseFieldsShape`, which create and update share: an update may
 * change what a case tests, never which case it is. Omitting it is supported —
 * the platform mints one — so an agent that has no id of its own does not have
 * to invent a scheme.
 */
const declaredCaseIdField = opaqueIdSchema
  .optional()
  .describe(
    "Stable declared id for the case (e.g. from a suite file). Minted for you when omitted.",
  );

/** `buildCaseBody` plus the create-only declared id. */
function buildCreateCaseBody(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const body = buildCaseBody(input);
  if (input.id !== undefined) body.id = input.id;
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
    "Fetch one eval suite's full settings: environment (servers, computer image), execution config (model/system prompt/temperature), hosts, match options, checks, LLM-as-judge (resolved: enabled, model, autoRun, threshold), schedule.",
  readOnly: true,
  inputSchema: getEvalSuiteInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.getEvalSuite(
      { projectId: project.id, suiteId: suite.id },
      { signal },
    );
  },
};

// STRICT: the reported silent no-op (`hostIds` / top-level `servers`)
// was stripped here before the HTTP body was ever built.
const updateEvalSuiteInput = z.strictObject({
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
    .object({
      servers: z
        .array(z.string().trim().min(1))
        .optional()
        .describe(
          "Server selection by name; replaces the suite's server set. Omit to leave it (and its bindings) alone.",
        ),
      computerEnvironment: z
        .union([z.string().trim().min(1), z.null()])
        .optional()
        .describe(
          "Custom sandbox image the suite's eval runs boot from, by name or id (see list_sandbox_images). null uses the provider's default base image.",
        ),
    })
    .optional()
    .describe(
      "Suite environment: server selection and the sandbox image runs boot from. Unspecified fields are preserved.",
    ),
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
      }),
    )
    .optional()
    .describe("Host attachments (replace-all)."),
  settings: z
    .object({
      minimumAccuracy: z.number().min(0).max(100).optional(),
      minimumIterations: z
        .union([z.number().int().min(1).max(10), z.null()])
        .optional()
        .describe(
          "Floor on per-case iterations, 1–10: every case runs at least this many times. null removes the floor.",
        ),
      // Nullable to CLEAR suite defaults (vs omit to leave untouched).
      matchOptions: publicMatchOptionsSchema.nullable().optional(),
      checks: z.array(publicCheckSchema).nullable().optional(),
      judge: z
        .object({
          enabled: z
            .boolean()
            .optional()
            .describe(
              "Make the judge available on this suite. On its own this grades nothing — set autoRun (or request grading on a finished run) to make grading happen.",
            ),
          model: z.string().trim().min(1).optional(),
          autoRun: z
            .boolean()
            .optional()
            .describe(
              "Grade every run automatically as it completes. This is the flag that makes LLM-as-judge grading happen; it SPENDS on each run.",
            ),
          threshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "Advisory pass threshold, 0–1 (passed = score >= threshold).",
            ),
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
    "Edit an eval suite's settings: name, description, environment servers, computer image, execution config (model/system prompt/temperature), hosts, minimum accuracy, minimum iterations, match options, checks, and LLM-as-judge (enabled/model/autoRun/threshold — autoRun is what makes grading happen; enabled alone only makes the judge available). Only the fields you pass change.",
  readOnly: false,
  inputSchema: updateEvalSuiteInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
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
      { signal },
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
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.deleteEvalSuite(
      { projectId: project.id, suiteId: suite.id },
      { signal },
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
      "Run interval in minutes (5–10080). Required only when enabling a suite with no saved interval; on re-enable it is reused when omitted.",
    ),
  environment: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Project environment name or ID the scheduled runs launch. A schedule fires exactly one run, so an environment-based suite pins exactly one of its attached environments — required when several are attached, defaulted when one is. Only valid with enabled: true.",
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
    "Enable or disable automatic scheduled runs for a suite, and set the interval. Disabling preserves the stored interval and environment pin. For an environment-based suite, environment pins which single environment the scheduled runs launch.",
  readOnly: false,
  inputSchema: setEvalSuiteScheduleInput,
  async execute(input, { client, signal }) {
    // Disabling returns early server-side and would silently drop a pin, so an
    // environment sent with `enabled: false` never takes effect. Fail instead
    // of letting the caller believe they repointed the schedule.
    if (input.environment && !input.enabled) {
      throw operationInputError(
        "environment only applies when enabling a schedule — disabling preserves the existing pin. Re-send with enabled: true to repoint it.",
      );
    }
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const environment = input.environment
      ? await resolveEnvironmentSelector(
          client,
          project,
          input.environment,
          signal,
        )
      : undefined;
    return client.setEvalSuiteSchedule(
      {
        projectId: project.id,
        suiteId: suite.id,
        body: {
          enabled: input.enabled,
          ...(input.intervalMinutes !== undefined
            ? { intervalMinutes: input.intervalMinutes }
            : {}),
          ...(environment ? { environmentId: environment.id } : {}),
        },
      },
      { signal },
    );
  },
};

const setEvalSuiteEnvironmentsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  environments: z
    .union([z.array(z.string().trim().min(1)).min(1), z.null()])
    .describe(
      "Project environment names or IDs to attach, in the order they should appear. Replaces the current attachments outright (this is a set, not an append). Pass null to detach every environment and revert the suite to its saved server selection. An empty array is rejected — use null.",
    ),
});
export type SetEvalSuiteEnvironmentsInput = z.infer<
  typeof setEvalSuiteEnvironmentsInput
>;

export const setEvalSuiteEnvironmentsOperation: PlatformOperation<
  SetEvalSuiteEnvironmentsInput,
  PlatformEvalSuiteDetail
> = {
  name: "set_eval_suite_environments",
  title: "Set MCPJam eval suite environments",
  description:
    "Attach project environments to an eval suite, replacing whatever it had. Once a suite has environments, its runs execute against one of them (resolved host config, closed server set, pinned plugin versions) instead of its saved server selection — that is what makes run_eval_suite's environment argument available. Pass null to detach them all. Rejected if it would strand an enabled schedule pinned to an environment being removed.",
  readOnly: false,
  inputSchema: setEvalSuiteEnvironmentsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    let environmentIds: string[] | null = null;
    if (input.environments !== null) {
      // ONE listing for every selector, not one lookup each: this is a set
      // operation over a list that can hold up to ten environments, and N
      // round trips would also give each selector a different view of the
      // project if an edit landed mid-loop. Live environments only — an
      // archived one cannot be attached, so surfacing it as a candidate would
      // only turn a clear "not found, here are the choices" into a backend
      // rejection.
      const page = await client.listEnvironments(
        { projectId: project.id },
        { signal },
      );
      const resolved = input.environments.map((selector) =>
        resolveByIdOrName(
          page.items,
          selector,
          "Project environment",
          `project "${project.name}"`,
        ),
      );
      // Duplicates are detected AFTER resolution, because two DIFFERENT
      // selectors (an id and its name) can name the same environment — a
      // pre-resolution string comparison would wave that through and let the
      // backend reject it with a message that doesn't say which inputs collided.
      const seen = new Map<string, string>();
      resolved.forEach((environment, index) => {
        const previous = seen.get(environment.id);
        const selector = input.environments![index]!;
        if (previous !== undefined) {
          throw operationInputError(
            `"${previous}" and "${selector}" both refer to the environment "${environment.name}" (id: ${environment.id}). List each environment once.`,
          );
        }
        seen.set(environment.id, selector);
      });
      environmentIds = resolved.map((environment) => environment.id);
    }
    return client.updateEvalSuite(
      {
        projectId: project.id,
        suiteId: suite.id,
        body: { environmentIds },
      },
      { signal },
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
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.listEvalCases(
      { projectId: project.id, suiteId: suite.id },
      { signal },
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
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const testCase = await resolveCase(
      client,
      project,
      suite,
      input.case,
      signal,
    );
    return client.getEvalCase(
      { projectId: project.id, suiteId: suite.id, caseId: testCase.id },
      { signal },
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
  id: declaredCaseIdField,
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
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.createEvalCase(
      {
        projectId: project.id,
        suiteId: suite.id,
        body: buildCreateCaseBody(input),
      },
      { signal },
    );
  },
};

const createEvalCasesInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  cases: z
    .array(
      z.object({
        ...caseFieldsShape,
        title: z.string().trim().min(1).describe("Short case label."),
        id: declaredCaseIdField,
      }),
    )
    .min(1)
    .max(MAX_BATCH_CREATE_CASES)
    .describe(
      `The cases to author, up to ${MAX_BATCH_CREATE_CASES} per call. Split a larger set into several calls.`,
    ),
  duplicatePolicy: z
    .enum(["block", "warn", "create_anyway"])
    .optional()
    .describe(
      "What to do with a case whose definition already exists in the suite. Defaults to `block`. `warn` and `create_anyway` require `overrideReason`.",
    ),
  overrideReason: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Why authoring a duplicate is intended. Recorded on the case's revision.",
    ),
});
export type CreateEvalCasesInput = z.infer<typeof createEvalCasesInput>;

export const createEvalCasesOperation: PlatformOperation<
  CreateEvalCasesInput,
  PlatformEvalCaseBatchResult
> = {
  name: "create_eval_cases",
  title: "Create MCPJam eval cases",
  description:
    "Add several test cases to an eval suite in one call — the bulk form of `create_eval_case`, and the way to convert a repo's test files or import a suite without a round trip per case. Each case takes the same fields as `create_eval_case`. Cases are validated together and reported individually: `created` and `failed` both carry the `index` of the case they describe, so a partial result lines up against the list you sent.",
  readOnly: false,
  // Authoring cases persists, but each one is individually deletable and
  // nothing is spent until a run is started. (`create_eval_case` predates this
  // field and is pinned as legacy-unclassified; it means the same thing.)
  risk: "none",
  inputSchema: createEvalCasesInput,
  async execute(input, { client, signal }) {
    // Checked HERE rather than as a schema `.refine`: an operation's
    // `inputSchema` is handed to the agent tool surface, which needs a plain
    // object schema — a refinement wraps it in `ZodEffects` and the toolset
    // stops building. The platform refuses these two policies without a reason
    // per case, so without this the caller spends a round trip to get N
    // identical OVERRIDE_REASON_REQUIRED failures back.
    if (
      input.duplicatePolicy !== undefined &&
      input.duplicatePolicy !== "block" &&
      !input.overrideReason
    ) {
      throw new PlatformApiError(
        `duplicatePolicy \`${input.duplicatePolicy}\` authors a case that duplicates ` +
          "an existing one, so it requires an overrideReason — the reason is what " +
          "gets recorded on the case's revision.",
        "VALIDATION_ERROR",
        // Client-synthesized: no request was made, so quoting a server status
        // would misreport what happened.
        { status: 0 },
      );
    }
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.createEvalCases(
      {
        projectId: project.id,
        suiteId: suite.id,
        body: {
          cases: input.cases.map((testCase) =>
            buildCreateCaseBody(testCase as Record<string, unknown>),
          ),
          ...(input.duplicatePolicy
            ? { duplicatePolicy: input.duplicatePolicy }
            : {}),
          ...(input.overrideReason
            ? { overrideReason: input.overrideReason }
            : {}),
        },
      },
      { signal },
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
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const testCase = await resolveCase(
      client,
      project,
      suite,
      input.case,
      signal,
    );
    return client.updateEvalCase(
      {
        projectId: project.id,
        suiteId: suite.id,
        caseId: testCase.id,
        body: buildCaseBody(input),
      },
      { signal },
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
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const testCase = await resolveCase(
      client,
      project,
      suite,
      input.case,
      signal,
    );
    return client.deleteEvalCase(
      { projectId: project.id, suiteId: suite.id, caseId: testCase.id },
      { signal },
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
      "normal = mixed positive/negative cases; negative = only negative. Defaults to normal.",
    ),
  servers: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      "Server names/IDs to discover tools from; defaults to the suite's selection.",
    ),
  environment: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(SUITE_ENVIRONMENT_SELECTOR_DESCRIPTION),
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
      "Per-bucket case counts. Omitted buckets inherit the default mix; supersedes `mode`. Each bucket and the total are bounded server-side.",
    ),
  varyUserStyles: z
    .boolean()
    .optional()
    .describe(
      "Condition generated cases on a realistic range of user styles so the queries read like different users wrote them.",
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Retry-safety key: pass one, because generating spends model credits and a retry must not pay for a second generation. Repeating a call with the same key replays the first attempt's drafts and returns the cases it already created.",
    ),
});
export type GenerateEvalCasesInput = z.infer<typeof generateEvalCasesInput>;

export const generateEvalCasesOperation: PlatformOperation<
  GenerateEvalCasesInput,
  PlatformEvalCasesGenerated
> = {
  name: "generate_eval_cases",
  risk: "spend",
  title: "Generate MCPJam eval cases",
  description:
    "AI-generate test cases from the suite's server tools and persist them into the suite. Connects the servers to discover tools and spends the organization's credits. For a suite with attached project environments, tools are discovered from the environment's closed server set — pass environment to choose which one. The authoring model is platform-controlled; set caseModels to choose the generated cases' execution models. IDEMPOTENT on idempotencyKey: pass one, because generating spends model credits and a retry must not pay for a second generation.",
  readOnly: false,
  inputSchema: generateEvalCasesInput,
  async execute(input, { client, signal }) {
    assertNoServerOverrideWithEnvironment(input);
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    // Resolve server name/id selectors to project server IDs before sending —
    // the route hands `servers` straight to batch authorization, which expects
    // IDs. Mirrors run_eval_suite so a `--server <name>` override works.
    const overrideServers = input.servers
      ? await resolveRunServers(client, project, input.servers, signal)
      : undefined;
    const environment = input.environment
      ? await resolveEnvironmentSelector(
          client,
          project,
          input.environment,
          signal,
        )
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
          ...(environment ? { environmentId: environment.id } : {}),
          ...(input.caseModels ? { caseModels: input.caseModels } : {}),
          ...(input.caseMix ? { caseMix: input.caseMix } : {}),
          ...(input.varyUserStyles ? { varyUserStyles: true } : {}),
          // In the BODY, like run_eval_suite and run_eval_case — the two
          // closest siblings, which also spend. The route merges a header key
          // over this one, so the agent surfaces keep their precedence.
          ...(input.idempotencyKey
            ? { idempotencyKey: input.idempotencyKey }
            : {}),
        },
      },
      {
        signal,
        // Also on the transport header the client already speaks, so a caller
        // reading the wire sees one key rather than two channels that could
        // disagree. The route accepts either spelling.
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      },
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
      "Eval run ID, as returned by run_eval_suite or list_eval_suite_runs.",
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
    "Get the status, pass/fail result, and summary counts of an eval run. Poll this until status is completed, failed, or cancelled. The detail carries an `insights` envelope with findings AGGREGATED across iterations (exemplar evidence attached); only a finding with actionTarget mcp_server AND actionability ready authorizes proposing a server change — other action targets name agent/test/environment work and must not be 'fixed' in server code.",
  readOnly: true,
  inputSchema: evalRunScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const run = await client.getEvalRun(
      { projectId: project.id, runId: input.runId },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

const compareEvalRunInput = evalRunScopedInput.extend({
  baseRunId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Run ID to compare against. Omit to use the nearest earlier COMPLETED run in the same suite.",
    ),
});

export type CompareEvalRunInput = z.infer<typeof compareEvalRunInput>;

export type CompareEvalRunResult = {
  project: SelectedProjectInfo;
  compare: PlatformRunCompare;
};

export const compareEvalRunOperation: PlatformOperation<
  CompareEvalRunInput,
  CompareEvalRunResult
> = {
  name: "compare_eval_run",
  title: "Compare MCPJam eval runs",
  description:
    "Compare an eval run against a baseline run: per-case status (one of regressed, fixed, new_case, removed_case, changed, unchanged_passed, unchanged_failed), per-scorer pass-rate and mean deltas from the evaluation contract, and whether the evaluation config changed between them. Omit baseRunId to compare against the nearest earlier completed run in the same suite. A case whose scoreDeltas show definitionChanged was graded by a DIFFERENT scorer definition on each side — its delta is not a regression. Returns HTTP 404 NOT_FOUND with details.reason = BASELINE_NOT_FOUND when the run has no comparable predecessor; that means the comparison is incomplete, not that anything regressed.",
  readOnly: true,
  inputSchema: compareEvalRunInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const compare = await client.compareEvalRun(
      {
        projectId: project.id,
        runId: input.runId,
        baseRunId: input.baseRunId,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), compare };
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
      signal,
    );
    const page = await client.listEvalRunIterations(
      {
        projectId: project.id,
        runId: input.runId,
        cursor: input.cursor,
        limit: input.limit,
      },
      { signal },
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
      signal,
    );
    const trace = await client.getEvalIterationTrace(
      {
        projectId: project.id,
        runId: input.runId,
        iterationId: input.iterationId,
      },
      { signal },
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
      signal,
    );
    const run = await client.cancelEvalRun(
      { projectId: project.id, runId: input.runId },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

const requestEvalRunJudgeInput = evalRunScopedInput.extend({
  force: z
    .boolean()
    .optional()
    .describe("Re-grade a run that already has a judge result."),
  enable: z
    .boolean()
    .optional()
    .describe(
      "Grade this run even though the judge was off when it ran. A per-RUN answer, not a suite edit: grading reads the config pinned when the run was created, so turning the judge on for the suite does not reach an already-recorded run.",
    ),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Judge model for this run only; defaults to the suite's."),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Pass threshold for this run only, 0–1."),
});

export type RequestEvalRunJudgeInput = z.infer<typeof requestEvalRunJudgeInput>;

export type RequestEvalRunJudgeResult = {
  project: SelectedProjectInfo;
  judge: PlatformEvalRunJudgeRequested;
};

export const requestEvalRunJudgeOperation: PlatformOperation<
  RequestEvalRunJudgeInput,
  RequestEvalRunJudgeResult
> = {
  name: "request_eval_run_judge",
  title: "Request MCPJam eval run grading",
  description:
    "Run LLM-as-judge grading over a finished eval run: each case's final answer is scored against its expected output. SPENDS the organization's model budget. Returns immediately with a pending receipt — read the results from get_eval_run's `judges.goalCompletion`, do not re-request. Pass `enable: true` to grade a run recorded while the judge was off; a run's grading config is pinned when it starts, so enabling the judge on the suite does not reach it.",
  readOnly: false,
  risk: "spend",
  inputSchema: requestEvalRunJudgeInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const judge = await client.requestEvalRunJudge(
      {
        projectId: project.id,
        runId: input.runId,
        ...(input.force !== undefined ? { force: input.force } : {}),
        ...(input.enable !== undefined ? { enable: input.enable } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.threshold !== undefined
          ? { threshold: input.threshold }
          : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), judge };
  },
};

/**
 * The organization a GitHub Checks connection belongs to.
 *
 * `PlatformProject.organizationId` is nullable — a personal project belongs to
 * no organization — and GitHub Checks is an organization's App installation.
 * Refused with the reason rather than sent as an empty string, which would
 * reach the platform as an unparseable id and come back as a flat not-found.
 */
function checkRepoOrganizationOrThrow(project: PlatformProject): string {
  const organizationId = project.organizationId;
  if (!organizationId) {
    throw operationInputError(
      `Project "${project.name}" does not belong to an organization, and GitHub Checks is configured per organization. Move the suite to a project in an organization, or connect the repository from the app.`,
    );
  }
  return organizationId;
}

// ── GitHub Checks: run a suite on every pull request ──────────────────────
//
// Two operations rather than fields on `update_eval_suite`, because the
// resource is ORG-scoped: a connection binds the organization's GitHub App
// installation to a repository, and the suite is only which suite that
// repository answers for.
//
// Deliberately NARROW, mirroring the suite-side section in the app: connect,
// and see what is connected. Pausing, retargeting and disconnecting are
// repo-level decisions that want every repository visible at once — offering
// them here would let a caller retarget a repository away from the suite it is
// standing on.

const listEvalCheckReposInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Project name or ID. Only used to select the ORGANIZATION whose connected repositories are listed.",
    ),
});
export type ListEvalCheckReposInput = z.infer<typeof listEvalCheckReposInput>;

export type ListEvalCheckReposResult = {
  project: SelectedProjectInfo;
  checks: PlatformEvalCheckRepos;
};

export const listEvalCheckReposOperation: PlatformOperation<
  ListEvalCheckReposInput,
  ListEvalCheckReposResult
> = {
  name: "list_eval_check_repos",
  title: "List MCPJam GitHub Checks repositories",
  description:
    "List the repositories in this organization whose pull requests run an eval suite, and the repositories the MCPJam GitHub App can reach (the choices a connect has). `available: false` means GitHub Checks is not enabled for the organization at all — connecting a repository will not help. `connectable: null` means the lookup failed, so the choices are unknown; an EMPTY connectable list means the App was asked and reaches nothing, which also covers a deployment with no App installed — check that before assuming a permissions problem.",
  readOnly: true,
  inputSchema: listEvalCheckReposInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const checks = await client.listEvalCheckRepos(
      { organizationId: checkRepoOrganizationOrThrow(project) },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), checks };
  },
};

const connectEvalCheckRepoInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  repo: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Repository as owner/repo. Must be one list_eval_check_repos reports as connectable — the MCPJam GitHub App has to be installed on it.",
    ),
  outagePolicy: z
    .enum(["fail_open", "fail_closed"])
    .describe(
      "What the pull-request check reports when MCPJam cannot conclude: fail_open passes it, fail_closed fails it. Required — ask the user which they want rather than choosing for them; fail_closed blocks merges during an MCPJam outage, fail_open lets an unverified change through.",
    ),
});
export type ConnectEvalCheckRepoInput = z.infer<
  typeof connectEvalCheckRepoInput
>;

export type ConnectEvalCheckRepoResult = {
  project: SelectedProjectInfo;
  check: PlatformEvalCheckRepoConnected;
};

export const connectEvalCheckRepoOperation: PlatformOperation<
  ConnectEvalCheckRepoInput,
  ConnectEvalCheckRepoResult
> = {
  name: "connect_eval_check_repo",
  title: "Run an MCPJam eval suite on a repository's pull requests",
  description:
    "Connect a repository so every pull request to it runs one eval suite and reports a GitHub check. Affects everyone who opens a pull request on that repository, and can block merges depending on outagePolicy. Retargeting, pausing and disconnecting are not on this surface — they live in the app's Settings → Integrations, where every connected repository is visible at once.",
  readOnly: false,
  // Not `spend`: it costs an eval run per pull request, but the hazard a
  // surface needs to warn about here is REACH — it changes what happens in a
  // shared repository for everyone who opens a PR against it.
  risk: "exposure",
  inputSchema: connectEvalCheckRepoInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    // BEFORE the suite lookup: a project with no organization can never
    // connect, so spending a round trip to resolve a suite first only delays
    // the same refusal — and makes the failure look like a suite problem.
    const organizationId = checkRepoOrganizationOrThrow(project);
    const suite = await resolveSuite(client, project, input.suite, signal);
    const check = await client.connectEvalCheckRepo(
      {
        organizationId,
        projectId: project.id,
        suiteId: suite.id,
        repo: input.repo,
        outagePolicy: input.outagePolicy,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), check };
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
      signal,
    );
    const page = await client.getEvalRunSteps(
      {
        projectId: project.id,
        runId: input.runId,
        iterationId: input.iterationId,
      },
      { signal },
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
  signal: AbortSignal | undefined,
): Promise<PlatformEvalSuite> {
  const page = await client.listEvalSuites(
    { projectId: project.id },
    { signal },
  );
  return resolveByIdOrName(
    page.items,
    selector,
    "Eval suite",
    `project "${project.name}"`,
  );
}

/**
 * Resolve several test cases within a suite by id or (case-insensitive) title,
 * over ONE listing. Cases expose `title`, so map it onto the `name` field
 * `resolveByIdOrName` matches.
 *
 * Deduplicated by resolved id: naming a case twice is one case, not two — and
 * on a run selector, two entries for one case would narrow the run to a list
 * with a duplicate in it.
 */
async function resolveCases(
  client: PlatformApiClient,
  project: PlatformProject,
  suite: PlatformEvalSuite,
  selectors: string[],
  signal: AbortSignal | undefined,
): Promise<PlatformEvalCase[]> {
  const page = await client.listEvalCases(
    { projectId: project.id, suiteId: suite.id },
    { signal },
  );
  const items = page.items.map((testCase) => ({
    ...testCase,
    name: testCase.title,
  }));
  const resolved = new Map<string, PlatformEvalCase>();
  for (const selector of selectors) {
    const testCase = resolveByIdOrName(
      items,
      selector,
      "Eval case",
      `suite "${suite.name ?? suite.id}"`,
    );
    resolved.set(testCase.id, testCase);
  }
  return [...resolved.values()];
}

/** One case, by id or title. Thin wrapper over {@link resolveCases} so the
 *  single-case callers keep their ergonomics without a second listing path. */
async function resolveCase(
  client: PlatformApiClient,
  project: PlatformProject,
  suite: PlatformEvalSuite,
  selector: string,
  signal: AbortSignal | undefined,
): Promise<PlatformEvalCase> {
  const [testCase] = await resolveCases(
    client,
    project,
    suite,
    [selector],
    signal,
  );
  return testCase!;
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
  signal: AbortSignal | undefined,
): Promise<PlatformProjectServer[]> {
  const page = await client.listProjectServers(
    { projectId: project.id },
    { signal },
  );

  const resolved = new Map<string, PlatformProjectServer>();
  for (const selector of selectors) {
    const server = resolveByIdOrName(
      page.items,
      selector,
      "Server",
      `project "${project.name}"`,
    );
    // Fail deterministically here rather than downstream at run creation:
    // the hosted runner can never connect to these.
    if (server.transportType === "stdio" || !server.url) {
      throw resolutionError(
        `Server "${selector.trim()}" can't run hosted evals: ${
          server.transportType === "stdio"
            ? "stdio servers are not supported on the hosted platform"
            : "it has no URL"
        }. Select an HTTP server instead.`,
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
      "Server name to register the tunnel under. Reusing an existing server's name points that record at the tunnel (its URL is overwritten and stdio records are converted to HTTP).",
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
      signal,
    );
    const grant = await client.createTunnel(
      { projectId: project.id, name: input.name },
      { signal },
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
      "Server ID whose tunnel to revoke, as returned by create_tunnel.",
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
      signal,
    );
    const result = await client.closeTunnel(
      { projectId: project.id, serverId: input.serverId },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      serverId: result.serverId,
      status: result.status,
    };
  },
};

// ── Chat operations ──────────────────────────────────────────────────

export type ListScenariosResult = {
  project: SelectedProjectInfo;
  items: PlatformScenarioSummary[];
  otherProjects: ProjectInfo[];
};

export const listScenariosOperation: PlatformOperation<
  ProjectScopedInput,
  ListScenariosResult
> = {
  name: "list_scenarios",
  title: "List MCPJam scenarios",
  description:
    "List the scenarios published from an MCPJam project: name, access mode, attached servers, and share link. If no project is specified, uses the most recently updated accessible project and returns other project names for switching.",
  readOnly: true,
  inputSchema: projectScopedInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listScenarios(
      { projectId: project.id },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

const scenarioScopedInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  scenario: z.string().trim().min(1).describe("Scenario name or ID."),
});

export type GetScenarioInput = z.infer<typeof scenarioScopedInput>;

export type GetScenarioResult = {
  project: SelectedProjectInfo;
  scenario: PlatformScenarioDetail;
};

export const getScenarioOperation: PlatformOperation<
  GetScenarioInput,
  GetScenarioResult
> = {
  name: "get_scenario",
  title: "Get MCPJam scenario",
  description:
    "Get one scenario's read-only settings: model, system prompt, temperature, tool-approval policy, and resolved servers. The scenario is matched by name or ID within the project.",
  readOnly: true,
  inputSchema: scenarioScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listScenarios(
      { projectId: project.id },
      { signal },
    );
    const match = resolveByIdOrName(
      page.items,
      input.scenario,
      "Scenario",
      `project "${project.name}"`,
    );
    const scenario = await client.getScenario(
      { projectId: project.id, scenarioId: match.id },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), scenario };
  },
};

const listChatSessionsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional project filter (name or ID). When omitted, lists sessions across all accessible projects.",
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
      { signal },
    );
    return {
      ...(project ? { project: toSelectedProjectInfo(project) } : {}),
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  },
};

const SESSION_SOURCE_TYPES = ["direct", "scenario", "eval", "swarm"] as const;

const searchSessionsInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .describe("Search terms. Required — this operation does not list."),
  scope: z
    .enum(["titles", "transcripts"])
    .optional()
    .describe(
      "What to search. 'titles' (default) matches session titles and first messages across the whole corpus; 'transcripts' matches what was actually said inside conversations.",
    ),
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  sourceTypes: z
    .array(z.enum(SESSION_SOURCE_TYPES))
    .min(1)
    .optional()
    .describe(
      "Restrict to these session surfaces. Omit to search all available surfaces.",
    ),
  status: z
    .enum(["active", "archived"])
    .optional()
    .describe("Filter by session status. Defaults to active."),
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
    .describe(
      "Opaque pagination cursor from a previous response. Page with the same query and scope you opened with.",
    ),
});

export type SearchSessionsInput = z.infer<typeof searchSessionsInput>;

export type SearchSessionsResult = {
  project: SelectedProjectInfo;
  scope: "titles" | "transcripts";
  items: PlatformSessionSummary[];
  nextCursor?: string;
};

export const searchSessionsOperation: PlatformOperation<
  SearchSessionsInput,
  SearchSessionsResult
> = {
  name: "search_sessions",
  title: "Search MCPJam sessions",
  description:
    "Search conversation sessions in a project across every surface (Playground, user testing, evals, swarms), ranked by relevance. " +
    "scope=titles (default) searches session titles and opening messages; scope=transcripts searches what was said inside the conversations. " +
    "Older sessions (created before 2026-08-14) are EXCLUDED from transcript search — they cannot match at all; use scope=titles to find them. " +
    "Every result carries a link to open the session.",
  readOnly: true,
  inputSchema: searchSessionsInput,
  async execute(input, { client, signal }) {
    // Re-checked here, not just in the schema: `execute()` is called directly
    // by surfaces that never parse the schema (the CLI binding, raw callers).
    // The endpoint treats a blank `q` as an EMPTY SEARCH — so a blank query
    // reaching it would return the project's recency feed, which this
    // operation promises never to do.
    const query = input.query?.trim() ?? "";
    if (query.length === 0) {
      throw operationInputError(
        "query is required — search_sessions searches, it does not list.",
      );
    }

    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const requestedScope = input.scope ?? "titles";
    const page = await client.listSessions(
      {
        projectId: project.id,
        q: query,
        scope: requestedScope,
        sourceTypes: input.sourceTypes,
        status: input.status,
        limit: input.limit,
        cursor: input.cursor,
      },
      { signal },
    );

    // FAIL CLOSED on version skew. A backend that predates `scope` ignores the
    // unknown query param, runs a title search, and answers without the echo.
    // Returning those rows would label title matches as transcript matches —
    // an answer the caller cannot detect is wrong. Only checked for a
    // non-default scope: `titles` is what an old backend does anyway, so its
    // results are correct with or without the marker.
    if (requestedScope !== "titles" && page.scope !== requestedScope) {
      throw new PlatformApiError(
        "this backend does not support transcript search; retry with scope=titles",
        "UNSUPPORTED",
        // `status: 0` like every other client-synthesized error: the request
        // itself returned 200, so quoting a server status would misreport
        // what happened.
        { status: 0 },
      );
    }

    return {
      project: toSelectedProjectInfo(project),
      scope: requestedScope,
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
  signal: AbortSignal | undefined,
): Promise<PlatformHost> {
  const page = await client.listHosts({ projectId: project.id }, { signal });
  return resolveByIdOrName(
    page.items,
    selector,
    "Host",
    `project "${project.name}"`,
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
      signal,
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
      signal,
    );
    const host = await resolveHost(client, project, input.host, signal);
    return client.getHost(
      { projectId: project.id, hostId: host.id },
      { signal },
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
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Built-in template to seed the host config from (e.g. claude, chatgpt, cursor).",
      ),
    theme: z
      .enum(["light", "dark"])
      .optional()
      .describe("Theme stamped into the seeded host config (template only)."),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Full host config v2 to use verbatim (alternative to template). Must pin a non-empty `modelId`.",
      ),
  })
  // ONE `superRefine`, shaped exactly like the route's, because the route's 400
  // is the error the caller actually receives and the schema must not predict a
  // different one. A field-level `.refine` on `config` cannot do that: it fails
  // before object-level checks run, so a degenerate `config: {}` would be
  // reported here as "config must be non-empty" while the route reports the XOR.
  // Counting the branch from a NON-EMPTY config makes `{}` read as "you picked
  // neither branch", and the early return keeps the model check off a request
  // that has no config branch to pin a model on.
  .superRefine((value, ctx) => {
    const hasConfig =
      value.config !== undefined && Object.keys(value.config).length > 0;
    if ((value.template ? 1 : 0) + (hasConfig ? 1 : 0) !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of `template` or a non-empty `config`.",
      });
      return;
    }
    // Mirrors the v1 route's forward-client invariant. Enforced here too so an
    // SDK/agent caller is told by the schema rather than by a 400 the published
    // contract never predicted.
    const modelId = hasConfig ? value.config!.modelId : undefined;
    if (hasConfig && !(typeof modelId === "string" && modelId.trim())) {
      ctx.addIssue({
        code: "custom",
        path: ["config", "modelId"],
        message:
          '`config.modelId` is required and must be a non-empty model id (e.g. "anthropic/claude-sonnet-4-5").',
      });
    }
  });
export type CreateHostInput = z.infer<typeof createHostInput>;

export const createHostOperation: PlatformOperation<
  CreateHostInput,
  PlatformHostDetail
> = {
  name: "create_host",
  title: "Create an MCPJam host",
  description:
    "Create a host in a project, either from a built-in template (`template`, optional `theme`) or from a full host config (`config`, which must pin a non-empty `modelId`). Returns the created host.",
  readOnly: false,
  inputSchema: createHostInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
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
      signal,
    );
    const host = await resolveHost(client, project, input.host, signal);
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.config !== undefined) body.config = input.config;
    return client.updateHost(
      { projectId: project.id, hostId: host.id, body },
      { signal },
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
      signal,
    );
    const host = await resolveHost(client, project, input.host, signal);
    return client.deleteHost(
      {
        projectId: project.id,
        hostId: host.id,
        // The v1 delete contract is bodyless — the route rejects any field.
        body: {},
      },
      { signal },
    );
  },
};

const setHostServersInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  host: z.string().trim().min(1).describe(HOST_SELECTOR_DESCRIPTION),
  serverIds: z.array(z.string().trim().min(1)).describe("Required server IDs."),
  optionalServerIds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("Optional server IDs enabled for this host."),
});
export type SetHostServersInput = z.infer<typeof setHostServersInput>;

export const setHostServersOperation: PlatformOperation<
  SetHostServersInput,
  PlatformHostDetail
> = {
  name: "set_host_servers",
  title: "Set an MCPJam host's servers",
  description:
    "Replace the required and optional saved-server attachments for a host.",
  readOnly: false,
  inputSchema: setHostServersInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const host = await resolveHost(client, project, input.host, signal);
    await client.setHostServers(
      {
        projectId: project.id,
        hostId: host.id,
        serverIds: input.serverIds,
        optionalServerIds: input.optionalServerIds,
      },
      { signal },
    );
    return client.getHost(
      { projectId: project.id, hostId: host.id },
      { signal },
    );
  },
};

const duplicateHostInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  host: z.string().trim().min(1).describe(HOST_SELECTOR_DESCRIPTION),
  name: z.string().trim().min(1).optional().describe("Name for the copy."),
});
export type DuplicateHostInput = z.infer<typeof duplicateHostInput>;

export const duplicateHostOperation: PlatformOperation<
  DuplicateHostInput,
  PlatformHostDetail
> = {
  name: "duplicate_host",
  title: "Duplicate an MCPJam host",
  description: "Create a new host with the selected host's current config.",
  readOnly: false,
  inputSchema: duplicateHostInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const host = await resolveHost(client, project, input.host, signal);
    return client.duplicateHost(
      { projectId: project.id, hostId: host.id, name: input.name },
      { signal },
    );
  },
};

// ── Project Environments ─────────────────────────────────────────────────────
//
// Named execution bundles (one host + optional server group + optional pinned
// skills/plugins) that eval suites and journeys run against. Distinct from the
// sandbox images below.
//
// Every mutation takes `expectedRevision`, the revision last read via
// get_project_environment / list_project_environments. That is deliberate: it
// is what stops two concurrent edits from silently clobbering each other.

// `ENVIRONMENT_SELECTOR_DESCRIPTION` is declared up in the eval section (see
// the note there); it is shared by both surfaces.
const EXPECTED_REVISION_DESCRIPTION =
  "The `revision` you last read for this environment (from get_project_environment). If the environment changed since, the write is rejected with a conflict instead of overwriting the other edit — re-read and retry.";

/**
 * Resolves by id or name across LIVE **and** archived environments: restore
 * necessarily targets an archived one, and a name-based selector has to be
 * able to find it.
 *
 * Archiving frees the name, so a project can legitimately hold an archived
 * `Staging` and a live `Staging` at once — a flat lookup would call that name
 * ambiguous and break every name-based operation. So a name match is resolved
 * against the side the operation is actually for first (`prefer`: live for
 * everything except restore), and only falls back to the whole listing when
 * that side has no match — which keeps "get an archived env by name" working
 * and keeps the not-found message enumerating every environment.
 *
 * An exact ID still wins over both, and a name that is ambiguous *within* the
 * preferred side (two archived `Staging`s for a restore) still reports as
 * ambiguous, because there it genuinely is.
 */
async function resolveEnvironmentSelector(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined,
  prefer: "live" | "archived" = "live",
): Promise<PlatformEnvironment> {
  const page = await client.listEnvironments(
    { projectId: project.id, includeArchived: true },
    { signal },
  );
  const trimmedSelector = selector.trim();
  const idMatch = page.items.find((item) => item.id === trimmedSelector);
  if (idMatch) {
    return idMatch;
  }
  const preferred = page.items.filter(
    (item) => item.archived === (prefer === "archived"),
  );
  const normalizedSelector = trimmedSelector.toLocaleLowerCase();
  const preferredHasName = preferred.some(
    (item) => item.name?.toLocaleLowerCase() === normalizedSelector,
  );
  return resolveByIdOrName(
    preferredHasName ? preferred : page.items,
    selector,
    "Project environment",
    `project "${project.name}"`,
  );
}

const listEnvironmentsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  includeArchived: z
    .boolean()
    .optional()
    .describe(
      "Include archived environments. Off by default; turn it on to find an environment to restore.",
    ),
});
export type ListEnvironmentsInput = z.infer<typeof listEnvironmentsInput>;

export type ListEnvironmentsResult = {
  project: SelectedProjectInfo;
  items: PlatformEnvironment[];
  otherProjects: ProjectInfo[];
};

export const listEnvironmentsOperation: PlatformOperation<
  ListEnvironmentsInput,
  ListEnvironmentsResult
> = {
  name: "list_project_environments",
  title: "List MCPJam project environments",
  description:
    "List the project environments in an MCPJam project. An environment is a named execution bundle (one host, optionally a standalone server group, pinned skills, and pinned plugin versions) that eval suites and journeys run against. Not a Computer sandbox image.",
  readOnly: true,
  inputSchema: listEnvironmentsInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listEnvironments(
      {
        projectId: project.id,
        ...(input.includeArchived !== undefined
          ? { includeArchived: input.includeArchived }
          : {}),
      },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

const environmentCapabilitiesInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
});
export type EnvironmentCapabilitiesInput = z.infer<
  typeof environmentCapabilitiesInput
>;

export type EnvironmentCapabilitiesResult = {
  project: SelectedProjectInfo;
  capabilities: PlatformEnvironmentCapabilities;
};

export const getEnvironmentCapabilitiesOperation: PlatformOperation<
  EnvironmentCapabilitiesInput,
  EnvironmentCapabilitiesResult
> = {
  name: "get_project_environment_capabilities",
  title: "Check what an MCPJam deployment's environment surface supports",
  description:
    "Report which environment features this MCPJam deployment accepts. Call it before sending a model override: this SDK ships independently of the platform, and a field an older deployment does not know is a hard validation error there rather than a silently ignored one. A deployment too old to answer reports false for everything, which is the correct assumption.",
  readOnly: true,
  inputSchema: environmentCapabilitiesInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return {
      project: toSelectedProjectInfo(project),
      capabilities: await client.getEnvironmentCapabilities(
        { projectId: project.id },
        { signal },
      ),
    };
  },
};

const environmentSelectorInput = z.object({
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
});
export type EnvironmentSelectorInput = z.infer<typeof environmentSelectorInput>;

export const getEnvironmentOperation: PlatformOperation<
  EnvironmentSelectorInput,
  PlatformEnvironment
> = {
  name: "get_project_environment",
  title: "Show an MCPJam project environment",
  description:
    "Show one project environment: its host, optional standalone server group, pinned skill selection, pinned plugin versions, and its current `revision` (which you pass as `expectedRevision` when updating it).",
  readOnly: true,
  inputSchema: environmentSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      input.environment,
      signal,
    );
    return client.getEnvironment(
      { projectId: project.id, environmentId: environment.id },
      { signal },
    );
  },
};

export const resolveEnvironmentOperation: PlatformOperation<
  EnvironmentSelectorInput,
  PlatformEnvironmentResolved
> = {
  name: "resolve_project_environment",
  title: "Preview what an MCPJam project environment resolves to",
  description:
    "Resolve a project environment to the exact execution inputs a run would use right now: the host's current config, the closed server set (including servers contributed by pinned plugin versions), and the resolved plugin versions. Fails with a conflict if the environment cannot currently produce a runnable configuration — for example a pinned plugin was disabled.",
  readOnly: true,
  inputSchema: environmentSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      input.environment,
      signal,
    );
    return client.resolveEnvironment(
      { projectId: project.id, environmentId: environment.id },
      { signal },
    );
  },
};

const skillSelectionInput = z
  .object({
    mode: z.literal("explicit"),
    skillIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .describe(
        "Project-shared skill IDs to pin. Skills with supporting files or extra frontmatter, and plugin-component skills, cannot be pinned.",
      ),
  })
  .describe(
    "Explicit pinned skill selection. Cannot be empty — omit the field entirely, or pass null when updating, to mean 'no pinned skills'.",
  );

const pluginVersionIdsInput = z
  .array(z.string().trim().min(1))
  .min(1)
  .describe(
    "Plugin VERSION IDs to pin. Narrow by design: the plugin must be installed and enabled, the version must be ready, at most one version per plugin, and none of its skills may carry supporting files.",
  );

const createEnvironmentInput = z.object({
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
      "Display name for the new environment. Must be unique among the project's live (non-archived) environments.",
    ),
  description: z
    .string()
    .optional()
    .describe("Optional free-text description."),
  hostId: z
    .string()
    .trim()
    .min(1)
    .describe("ID of the host this environment runs against. Required."),
  serverAttachmentId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional standalone server group to pin. Omit to fall back to the host config's own servers.",
    ),
  modelId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Model this environment runs, overriding the model pinned on its host. Omit to inherit the host\'s. The id is stored verbatim — no alias canonicalization — so pass exactly the id you want the provider request to carry (e.g. "anthropic/claude-sonnet-4-5").',
    ),
  skillSelection: skillSelectionInput.optional(),
  pluginVersionIds: pluginVersionIdsInput.optional(),
  sandboxImageId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional sandbox image (see the images operations) to pin: eval runs in this environment boot a fresh sandbox from it. Must be project-shared; personal drafts are rejected — promote first.",
    ),
});
export type CreateEnvironmentInput = z.infer<typeof createEnvironmentInput>;

export const createEnvironmentOperation: PlatformOperation<
  CreateEnvironmentInput,
  PlatformEnvironment
> = {
  name: "create_project_environment",
  title: "Create an MCPJam project environment",
  description:
    "Create a project environment: a named execution bundle of one host plus an optional standalone server group, pinned skills, and pinned plugin versions. Requires project admin.",
  readOnly: false,
  inputSchema: createEnvironmentInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return client.createEnvironment(
      {
        projectId: project.id,
        body: {
          name: input.name,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          hostId: input.hostId,
          ...(input.serverAttachmentId !== undefined
            ? { serverAttachmentId: input.serverAttachmentId }
            : {}),
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.skillSelection !== undefined
            ? { skillSelection: input.skillSelection }
            : {}),
          ...(input.pluginVersionIds !== undefined
            ? { pluginVersionIds: input.pluginVersionIds }
            : {}),
          ...(input.sandboxImageId !== undefined
            ? { sandboxImageId: input.sandboxImageId }
            : {}),
        },
      },
      { signal },
    );
  },
};

// ── Composed (ad-hoc) environments ───────────────────────────────────────────
//
// A composed stack is the same thing as a saved environment MINUS the name:
// one host, an optional server group, an optional model override, an optional
// computer image, an optional skill selection. It exists so a caller can run a
// specific combination WITHOUT adding a permanent entry to the project's
// environment list that someone else then has to reason about — which is
// exactly what `create_project_environment` would do.
//
// Everything downstream still goes through the ENVIRONMENT path: an ad-hoc row
// is an environment, so it resolves, snapshots and pins identically. There is
// deliberately no "override the model for this run" field anywhere — that
// would be a second, weaker execution-context channel with none of the
// environment's resolution or immutability guarantees.

/** The composed stack, in SELECTOR vocabulary (names or IDs). */
const composeStackFields = {
  host: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Host (name or ID) the composed stack runs as — the client whose configuration the run is stamped with.",
    ),
  serverGroup: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Standalone server group to pin (by ID). Omit to use the host's own servers.",
    ),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Model to run instead of the host's pinned one. Stored verbatim — pass exactly the id the provider request should carry.",
    ),
  computer: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Sandbox image (name or ID) to pin, so runs boot a fresh computer from it. Must be project-shared; promote a personal draft first.",
    ),
  skills: skillSelectionInput.optional(),
  pluginVersionIds: pluginVersionIdsInput.optional(),
} as const;

const ensureAdhocEnvironmentInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  ...composeStackFields,
});
export type EnsureAdhocEnvironmentInput = z.infer<
  typeof ensureAdhocEnvironmentInput
>;

export type EnsureAdhocEnvironmentResult = {
  project: SelectedProjectInfo;
  environment: PlatformAdhocEnvironment;
  /** False when this stack had already been composed — see the op description. */
  created: boolean;
};

/**
 * Resolve a composed stack's selectors to the ids the platform stores.
 *
 * Shared by the standalone op and the run ops' `compose` field, so a stack
 * means the same thing wherever it is written — a second resolver would be a
 * second set of rules for one vocabulary.
 */
async function resolveComposeStack(
  client: PlatformApiClient,
  project: PlatformProject,
  stack: {
    host: string;
    serverGroup?: string;
    model?: string;
    computer?: string;
    skills?: { mode: "explicit"; skillIds: string[] };
    pluginVersionIds?: string[];
  },
  signal: AbortSignal | undefined,
): Promise<PlatformAdhocEnvironmentBody> {
  const host = await resolveHost(client, project, stack.host, signal);
  const image = stack.computer
    ? await resolveImage(client, project, stack.computer, signal)
    : undefined;
  return {
    hostId: host.id,
    ...(stack.serverGroup ? { serverAttachmentId: stack.serverGroup } : {}),
    ...(stack.model ? { modelId: stack.model } : {}),
    ...(image ? { sandboxImageId: image.id } : {}),
    ...(stack.skills ? { skillSelection: stack.skills } : {}),
    ...(stack.pluginVersionIds
      ? { pluginVersionIds: stack.pluginVersionIds }
      : {}),
  };
}

export const ensureAdhocEnvironmentOperation: PlatformOperation<
  EnsureAdhocEnvironmentInput,
  EnsureAdhocEnvironmentResult
> = {
  name: "ensure_adhoc_environment",
  title: "Compose an MCPJam environment without naming it",
  description:
    "Get or create an UNNAMED environment for a composed stack — a host plus an optional server group, model, computer image and pinned skills. Deduplicated by CONTENT: the same stack always returns the same environment, and `created` is false on every call after the first. Use this instead of create_project_environment when you want to RUN a combination rather than add a permanent entry to the project's environment list. Promote one to a named environment later with name_environment.",
  readOnly: false,
  risk: "none",
  inputSchema: ensureAdhocEnvironmentInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const body = await resolveComposeStack(client, project, input, signal);
    const ensured = await client.ensureAdhocEnvironment(
      { projectId: project.id, body },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      environment: ensured.environment,
      created: ensured.created === true,
    };
  },
};

const nameEnvironmentInput = z.object({
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
    .describe(
      "The ad-hoc environment to promote, by ID (an unnamed environment has no name to select it by).",
    ),
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .describe(EXPECTED_REVISION_DESCRIPTION),
  name: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Display name for the promoted environment. Must be unique among the project's live environments.",
    ),
  description: z
    .string()
    .optional()
    .describe("Optional free-text description."),
});
export type NameEnvironmentInput = z.infer<typeof nameEnvironmentInput>;

export const nameEnvironmentOperation: PlatformOperation<
  NameEnvironmentInput,
  PlatformEnvironment
> = {
  name: "name_environment",
  title: "Promote an ad-hoc MCPJam environment",
  description:
    "Give an UNNAMED (ad-hoc) environment a name, promoting it in place — the same environment, now a permanent entry in the project's environment list, with the same id every existing run still points at. This is the ONLY way to promote one: update_project_environment renames an already-named environment and refuses an unnamed one. Promotion also drops the content fingerprint, so a later identical composition gets a fresh ad-hoc row rather than deduplicating onto this one, which is now independently editable.",
  readOnly: false,
  risk: "none",
  inputSchema: nameEnvironmentInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return client.nameEnvironment(
      {
        projectId: project.id,
        // By ID only: an unnamed row has no name to resolve against, and the
        // name-or-id resolver would report it as "not found" rather than as
        // the unnameable thing it is.
        environmentId: input.environment.trim(),
        body: {
          expectedRevision: input.expectedRevision,
          name: input.name,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
        },
      },
      { signal },
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
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .describe(EXPECTED_REVISION_DESCRIPTION),
    name: z.string().trim().min(1).optional().describe("New display name."),
    description: z
      .string()
      .optional()
      .describe("New description. Pass an empty string to clear it."),
    hostId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("New host for this environment."),
    serverAttachmentId: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "New standalone server group, or null to clear the pin and fall back to the host config's servers. Omit to leave unchanged.",
      ),
    modelId: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "New model override, or null to CLEAR it and fall back to the host's model. Omit to leave unchanged. An empty string is rejected — it is not a way to clear.",
      ),
    skillSelection: skillSelectionInput
      .nullable()
      .optional()
      .describe(
        "New pinned skill selection, or null to clear it. Omit to leave unchanged.",
      ),
    pluginVersionIds: pluginVersionIdsInput
      .nullable()
      .optional()
      .describe(
        "New pinned plugin versions, or null to clear them. Omit to leave unchanged.",
      ),
    sandboxImageId: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "New sandbox-image pin (project-shared image id), or null to clear it and use the default image. Omit to leave unchanged.",
      ),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.hostId !== undefined ||
      value.serverAttachmentId !== undefined ||
      value.modelId !== undefined ||
      value.skillSelection !== undefined ||
      value.pluginVersionIds !== undefined ||
      value.sandboxImageId !== undefined,
    {
      message:
        "Provide at least one of `name`, `description`, `hostId`, `serverAttachmentId`, `modelId`, `skillSelection`, `pluginVersionIds`, or `sandboxImageId` to update.",
    },
  );
export type UpdateEnvironmentInput = z.infer<typeof updateEnvironmentInput>;

export const updateEnvironmentOperation: PlatformOperation<
  UpdateEnvironmentInput,
  PlatformEnvironment
> = {
  name: "update_project_environment",
  title: "Update an MCPJam project environment",
  description:
    "Edit a project environment. Only the fields you pass change; pass null for serverAttachmentId, modelId, skillSelection, or pluginVersionIds to clear them. Requires `expectedRevision` (read it first with get_project_environment) and project admin.",
  readOnly: false,
  inputSchema: updateEnvironmentInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      input.environment,
      signal,
    );
    // `!== undefined` (never truthiness) so an explicit null is forwarded as a
    // CLEAR while an omitted field stays absent and is left unchanged.
    const body: PlatformEnvironmentUpdateBody = {
      expectedRevision: input.expectedRevision,
    };
    if (input.name !== undefined) body.name = input.name;
    if (input.description !== undefined) body.description = input.description;
    if (input.hostId !== undefined) body.hostId = input.hostId;
    if (input.serverAttachmentId !== undefined)
      body.serverAttachmentId = input.serverAttachmentId;
    if (input.modelId !== undefined) body.modelId = input.modelId;
    if (input.skillSelection !== undefined)
      body.skillSelection = input.skillSelection;
    if (input.pluginVersionIds !== undefined)
      body.pluginVersionIds = input.pluginVersionIds;
    if (input.sandboxImageId !== undefined)
      body.sandboxImageId = input.sandboxImageId;
    return client.updateEnvironment(
      { projectId: project.id, environmentId: environment.id, body },
      { signal },
    );
  },
};

const environmentRevisionInput = z.object({
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
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .describe(EXPECTED_REVISION_DESCRIPTION),
});
export type EnvironmentRevisionInput = z.infer<typeof environmentRevisionInput>;

export const archiveEnvironmentOperation: PlatformOperation<
  EnvironmentRevisionInput,
  PlatformEnvironment
> = {
  name: "archive_project_environment",
  title: "Archive an MCPJam project environment",
  description:
    "Archive a project environment. It stops being selectable for runs and frees its name for a new one, but the row is kept and can be restored. Requires project admin.",
  readOnly: false,
  mayBeDestructive: true,
  inputSchema: environmentRevisionInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      input.environment,
      signal,
    );
    return client.archiveEnvironment(
      {
        projectId: project.id,
        environmentId: environment.id,
        expectedRevision: input.expectedRevision,
      },
      { signal },
    );
  },
};

export const restoreEnvironmentOperation: PlatformOperation<
  EnvironmentRevisionInput,
  PlatformEnvironment
> = {
  name: "restore_project_environment",
  title: "Restore an archived MCPJam project environment",
  description:
    "Restore an archived project environment. Fails with a conflict if another live environment took its name in the meantime. Plugin pins whose version no longer exists at all are dropped — compare the returned pluginVersionIds against what you archived. Requires project admin.",
  readOnly: false,
  inputSchema: environmentRevisionInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    // Restore is the one operation whose target is archived by definition, so
    // a name shared with a live environment must resolve to the archived one.
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      input.environment,
      signal,
      "archived",
    );
    return client.restoreEnvironment(
      {
        projectId: project.id,
        environmentId: environment.id,
        expectedRevision: input.expectedRevision,
      },
      { signal },
    );
  },
};

// ── Agent Plugins ────────────────────────────────────────────────────────────
//
// Read-only. Import, activate, enable/disable and uninstall stay in the app —
// no plugin write belongs on an unattended surface.

const listProjectPluginsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
});
export type ListProjectPluginsInput = z.infer<typeof listProjectPluginsInput>;

export type ListProjectPluginsResult = {
  project: SelectedProjectInfo;
  items: PlatformPlugin[];
  otherProjects: ProjectInfo[];
};

export const listProjectPluginsOperation: PlatformOperation<
  ListProjectPluginsInput,
  ListProjectPluginsResult
> = {
  name: "list_project_plugins",
  title: "List MCPJam project plugins",
  description:
    "List the live (installed, non-uninstalled) Agent Plugins in an MCPJam project. Each plugin names its active version id — pass that to get_plugin_version for the version's servers and skills. Disabled plugins are listed too, marked `enabled: false`.",
  readOnly: true,
  inputSchema: listProjectPluginsInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listProjectPlugins(
      { projectId: project.id },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

const getPluginVersionInput = z.object({
  pluginVersionId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Plugin version ID — a plugin's `activeVersionId` from list_project_plugins, or a pinned id from an environment's `pluginVersionIds`.",
    ),
});
export type GetPluginVersionInput = z.infer<typeof getPluginVersionInput>;

export const getPluginVersionOperation: PlatformOperation<
  GetPluginVersionInput,
  PlatformPluginVersion
> = {
  name: "get_plugin_version",
  title: "Show an MCPJam plugin version",
  description:
    "Show one imported Agent Plugin version: its status, component counts, and per-component summaries (declared MCP servers with placement and auth timing, declared skills with their namespaced model refs). Requires membership of the version's project; historical versions of uninstalled plugins stay readable.",
  readOnly: true,
  inputSchema: getPluginVersionInput,
  async execute(input, { client, signal }) {
    return client.getPluginVersion(
      { pluginVersionId: input.pluginVersionId },
      { signal },
    );
  },
};

// ── Sandbox images ───────────────────────────────────────────────────────────

const IMAGE_SELECTOR_DESCRIPTION = "Sandbox image name or ID.";

async function resolveImage(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined,
): Promise<PlatformImage> {
  const page = await client.listImages({ projectId: project.id }, { signal });
  return resolveByIdOrName(
    page.items,
    selector,
    "Sandbox image",
    `project "${project.name}"`,
  );
}

const imageSelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  image: z.string().trim().min(1).describe(IMAGE_SELECTOR_DESCRIPTION),
});
export type ImageSelectorInput = z.infer<typeof imageSelectorInput>;

export type ListImagesResult = {
  project: SelectedProjectInfo;
  items: PlatformImage[];
  otherProjects: ProjectInfo[];
};

export const listImagesOperation: PlatformOperation<
  ProjectScopedInput,
  ListImagesResult
> = {
  name: "list_sandbox_images",
  title: "List sandbox images",
  description:
    "List the custom Computer sandbox images (blueprints) in an MCPJam project. If no project is specified, uses the most recently updated accessible project.",
  readOnly: true,
  inputSchema: projectScopedInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listImages({ projectId: project.id }, { signal });
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

export const getImageOperation: PlatformOperation<
  ImageSelectorInput,
  PlatformImage
> = {
  name: "get_sandbox_image",
  title: "Show a sandbox image",
  description:
    "Show one sandbox image's blueprint, sharing, and latest build status.",
  readOnly: true,
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const image = await resolveImage(client, project, input.image, signal);
    return client.getImage(
      { projectId: project.id, imageId: image.id },
      { signal },
    );
  },
};

const createImageInput = z.object({
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
    .describe("Display name for the new sandbox image."),
  blueprint: z
    .string()
    .min(1)
    .describe(
      "Blueprint YAML (base / initialize / maintenance / knowledge). `base` must be an allowlisted official image pinned by @sha256 digest.",
    ),
});
export type CreateImageInput = z.infer<typeof createImageInput>;

export const createImageOperation: PlatformOperation<
  CreateImageInput,
  PlatformImage
> = {
  name: "create_sandbox_image",
  title: "Create a sandbox image",
  description:
    "Create a custom Computer sandbox image from a blueprint. Build it (build_sandbox_image) before a computer can boot from it.",
  readOnly: false,
  inputSchema: createImageInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return client.createImage(
      {
        projectId: project.id,
        body: { name: input.name, blueprint: input.blueprint },
      },
      { signal },
    );
  },
};

const updateImageInput = z
  .object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    image: z.string().trim().min(1).describe(IMAGE_SELECTOR_DESCRIPTION),
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("New display name for the sandbox image."),
    blueprint: z
      .string()
      .min(1)
      .optional()
      .describe("Replacement blueprint YAML."),
  })
  .refine(
    (value) => value.name !== undefined || value.blueprint !== undefined,
    {
      message: "Provide at least one of `name` or `blueprint` to update.",
    },
  );
export type UpdateImageInput = z.infer<typeof updateImageInput>;

export const updateImageOperation: PlatformOperation<
  UpdateImageInput,
  PlatformImage
> = {
  name: "update_sandbox_image",
  title: "Update a sandbox image",
  description:
    "Edit a sandbox image's name and/or blueprint. Base/initialize edits need a re-build; maintenance/knowledge edits apply at the next chat turn without one.",
  readOnly: false,
  inputSchema: updateImageInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const image = await resolveImage(client, project, input.image, signal);
    const body: { name?: string; blueprint?: string } = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.blueprint !== undefined) body.blueprint = input.blueprint;
    return client.updateImage(
      { projectId: project.id, imageId: image.id, body },
      { signal },
    );
  },
};

const validateImageBlueprintInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  blueprint: z.string().min(1).describe("Blueprint YAML to lint."),
});
export type ValidateImageBlueprintInput = z.infer<
  typeof validateImageBlueprintInput
>;

export const validateImageBlueprintOperation: PlatformOperation<
  ValidateImageBlueprintInput,
  PlatformImageBlueprintValidation
> = {
  name: "validate_sandbox_image_blueprint",
  title: "Validate a blueprint",
  description:
    "Lint sandbox-image blueprint YAML without saving it. Returns ok + the resolved base digest, or structured errors.",
  readOnly: true,
  inputSchema: validateImageBlueprintInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return client.validateImageBlueprint(
      { projectId: project.id, body: { blueprint: input.blueprint } },
      { signal },
    );
  },
};

export const buildImageOperation: PlatformOperation<
  ImageSelectorInput,
  PlatformImageBuildStarted
> = {
  name: "build_sandbox_image",
  title: "Build a sandbox image",
  description:
    "Trigger a build of the sandbox image. Async — poll list_sandbox_image_builds for status.",
  readOnly: false,
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const image = await resolveImage(client, project, input.image, signal);
    return client.buildImage(
      { projectId: project.id, imageId: image.id },
      { signal },
    );
  },
};

export type ListImageBuildsResult = {
  project: SelectedProjectInfo;
  imageId: string;
  items: PlatformImageBuild[];
};

export const listImageBuildsOperation: PlatformOperation<
  ImageSelectorInput,
  ListImageBuildsResult
> = {
  name: "list_sandbox_image_builds",
  title: "List sandbox image builds",
  description:
    "List a sandbox image's builds (newest first) with their status and log preview.",
  readOnly: true,
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const image = await resolveImage(client, project, input.image, signal);
    const page = await client.listImageBuilds(
      { projectId: project.id, imageId: image.id },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      imageId: image.id,
      items: page.items,
    };
  },
};

export const promoteImageOperation: PlatformOperation<
  ImageSelectorInput,
  PlatformImage
> = {
  name: "promote_sandbox_image",
  title: "Share a sandbox image with the project",
  description:
    "Promote a personal-draft sandbox image to a project-shared one (requires project admin).",
  readOnly: false,
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const image = await resolveImage(client, project, input.image, signal);
    return client.promoteImage(
      { projectId: project.id, imageId: image.id },
      { signal },
    );
  },
};

export const useImageOperation: PlatformOperation<
  ImageSelectorInput,
  PlatformComputerAttached
> = {
  name: "use_sandbox_image",
  title: "Use a sandbox image",
  description:
    "Attach the sandbox image to your computer, which rebuilds it from the pinned image (installed files are wiped). The sandbox image must have a ready build.",
  readOnly: false,
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const image = await resolveImage(client, project, input.image, signal);
    return client.useImage(
      { projectId: project.id, imageId: image.id },
      { signal },
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
      signal,
    );
    return client.resetComputer({ projectId: project.id }, { signal });
  },
};

export const deleteImageOperation: PlatformOperation<
  ImageSelectorInput,
  PlatformImageDeleted
> = {
  name: "delete_sandbox_image",
  title: "Delete a sandbox image",
  description:
    "Permanently delete a sandbox image. Computers booted from it fall back to the base image. This cannot be undone.",
  readOnly: false,
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const image = await resolveImage(client, project, input.image, signal);
    return client.deleteImage(
      { projectId: project.id, imageId: image.id },
      { signal },
    );
  },
};

const serverWriteBody = z
  .object({
    name: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    transportType: z.enum(["stdio", "http"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().positive().finite().optional(),
    useOAuth: z.boolean().optional(),
    oauthScopes: z.array(z.string()).optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    clearClientSecret: z.boolean().optional(),
    clearXaaConfig: z.boolean().optional(),
  })
  .passthrough();

export type CreateProjectServerInput = {
  project?: string;
  body: z.infer<typeof serverWriteBody> & {
    name: string;
    enabled: boolean;
    transportType: "stdio" | "http";
  };
};

export const createProjectServerOperation: PlatformOperation<
  CreateProjectServerInput,
  PlatformProjectServer
> = {
  name: "create_project_server",
  title: "Create a project MCP server",
  description:
    "Save a new MCP server in a project, including optional credentials.",
  readOnly: false,
  inputSchema: z.object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    body: serverWriteBody.extend({
      name: z.string().trim().min(1),
      enabled: z.boolean(),
      transportType: z.enum(["stdio", "http"]),
    }),
  }),
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return client.createProjectServer(
      { projectId: project.id, body: input.body },
      { signal },
    );
  },
};

export type GetProjectServerInput = ProjectScopedInput & { serverId: string };
const projectServerSelectorInput = projectScopedInput.extend({
  serverId: z.string().trim().min(1),
});

export const getProjectServerOperation: PlatformOperation<
  GetProjectServerInput,
  PlatformProjectServer
> = {
  name: "get_project_server",
  title: "Get a project MCP server",
  description: "Read one saved MCP server by project and server id.",
  readOnly: true,
  inputSchema: projectServerSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return client.getProjectServer(
      { projectId: project.id, serverId: input.serverId },
      { signal },
    );
  },
};

export type UpdateProjectServerInput = GetProjectServerInput & {
  body: z.infer<typeof serverWriteBody>;
};
export const updateProjectServerOperation: PlatformOperation<
  UpdateProjectServerInput,
  PlatformProjectServer
> = {
  name: "update_project_server",
  title: "Update a project MCP server",
  description: "Update saved MCP server metadata or rotate/clear credentials.",
  readOnly: false,
  inputSchema: projectServerSelectorInput.extend({ body: serverWriteBody }),
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return client.updateProjectServer(
      { projectId: project.id, serverId: input.serverId, body: input.body },
      { signal },
    );
  },
};

export const deleteProjectServerOperation: PlatformOperation<
  GetProjectServerInput,
  { id: string; deleted: boolean }
> = {
  name: "delete_project_server",
  title: "Delete a project MCP server",
  description: "Soft-delete a saved MCP server from a project.",
  readOnly: false,
  inputSchema: projectServerSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return client.deleteProjectServer(
      { projectId: project.id, serverId: input.serverId },
      { signal },
    );
  },
};

/** Any catalog operation with its input/output types erased. */
export type AnyPlatformOperation = PlatformOperation<any, unknown>;

// ── Journeys (the Swarms product) ───────────────────────────────────────────
//
// "Swarm" is not a resource noun in this API. A swarm is a container users
// author in the UI; a JOURNEY (a persona pursuing a goal against one or more
// environments) is what executes, and a JOURNEY RUN is what it produces. The
// marketing name appears in help text, where it belongs.
//
// BETA (`sandboxes-enabled`), gated server-side per organization — but only on
// the exposure-CREATING writes: launch and authoring. Those answer a structured
// FEATURE_UNAVAILABLE to an unflagged caller.
//
// The reads here need project membership and nothing more, and
// `cancel_journey_run` is ungated for the same reason: an organization that has
// lost the flag with a run already in flight must still be able to see it and
// stop it. Losing the feature is when stopping it matters most.

const listJourneysInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
});
export type ListJourneysInput = z.infer<typeof listJourneysInput>;

export type ListJourneysResult = {
  project: SelectedProjectInfo;
  items: PlatformJourney[];
  otherProjects: ProjectInfo[];
};

export const listJourneysOperation: PlatformOperation<
  ListJourneysInput,
  ListJourneysResult
> = {
  name: "list_journeys",
  title: "List MCPJam journeys",
  description:
    "List the journeys in an MCPJam project. A journey is one persona pursuing a goal against one or more environments — the unit that Swarms actually executes. Use the returned id with list_journey_runs.",
  readOnly: true,
  inputSchema: listJourneysInput,
  async execute(input, { client, signal }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listJourneys(
      { projectId: project.id },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

const journeyRunsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  journey: z.string().trim().min(1).describe("Journey id, from list_journeys."),
  cursor: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Pass the previous response's nextCursor to get the next page."),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListJourneyRunsInput = z.infer<typeof journeyRunsInput>;

export type ListJourneyRunsResult = {
  project: SelectedProjectInfo;
  items: PlatformJourneyRun[];
  nextCursor?: string;
};

export const listJourneyRunsOperation: PlatformOperation<
  ListJourneyRunsInput,
  ListJourneyRunsResult
> = {
  name: "list_journey_runs",
  title: "List runs of an MCPJam journey",
  description:
    "List a journey's runs, newest first, with each run's status and pass/fail rollup. A run someone STOPPED reports status 'failed' with canceled: true — check that flag before calling a run a failure.",
  readOnly: true,
  inputSchema: journeyRunsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listJourneyRuns(
      {
        projectId: project.id,
        journeyId: input.journey,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  },
};

const journeyRunSelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  run: z.string().trim().min(1).describe("Journey run id."),
});
export type GetJourneyRunInput = z.infer<typeof journeyRunSelectorInput>;

export type GetJourneyRunResult = {
  project: SelectedProjectInfo;
  run: PlatformJourneyRun;
};

export const getJourneyRunOperation: PlatformOperation<
  GetJourneyRunInput,
  GetJourneyRunResult
> = {
  name: "get_journey_run",
  title: "Get one MCPJam journey run",
  description:
    "One journey run in full: status, per-target rollups, and the per-session attempt records. This is what to poll after launching a run — status leaves 'running' once every attempt has settled. The detail carries an `insights` envelope: findings AGGREGATED over the run's wave with exemplar sessions, plus runHealth for launch outcomes (which are never findings — a rate-limited target is not a broken server). Only actionTarget mcp_server with actionability ready authorizes proposing a server change.",
  readOnly: true,
  inputSchema: journeyRunSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const run = await client.getJourneyRun(
      { projectId: project.id, runId: input.run },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

const journeyRunSessionsInput = journeyRunSelectorInput.extend({
  cursor: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Pass the previous response's nextCursor to get the next page."),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ListJourneyRunSessionsInput = z.infer<
  typeof journeyRunSessionsInput
>;

export type ListJourneyRunSessionsResult = {
  project: SelectedProjectInfo;
  items: PlatformJourneyRunSession[];
  nextCursor?: string;
};

export const listJourneyRunSessionsOperation: PlatformOperation<
  ListJourneyRunSessionsInput,
  ListJourneyRunSessionsResult
> = {
  name: "list_journey_run_sessions",
  title: "List the sessions a journey run produced",
  description:
    "The chat sessions a journey run produced — one per persona attempt against each target — with readiness, goal scores and a first-message preview. Transcript bodies are not on this API yet; use the returned `id` in the app to open a session.",
  readOnly: true,
  inputSchema: journeyRunSessionsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listJourneyRunSessions(
      {
        projectId: project.id,
        runId: input.run,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  },
};

export type CancelJourneyRunInput = z.infer<typeof journeyRunSelectorInput>;

export type CancelJourneyRunResult = {
  project: SelectedProjectInfo;
  run: PlatformJourneyRunCanceled;
};

const launchJourneyRunInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  journey: z.string().trim().min(1).describe("Journey id to launch."),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Retry key. A launch spends model credits, so a retry after a dropped response must not run the journey twice — replaying a key returns the ORIGINAL run with deduped: true. Omit it and every call starts a new run.",
    ),
  waveId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe("Opaque id linking the sibling runs of one co-launched batch."),
  environmentIds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      "Fan out across these project environments instead of the journey's authored targets.",
    ),
});
export type LaunchJourneyRunInput = z.infer<typeof launchJourneyRunInput>;

export type LaunchJourneyRunResult = {
  project: SelectedProjectInfo;
  run: PlatformJourneyRunLaunched;
};

export const launchJourneyRunOperation: PlatformOperation<
  LaunchJourneyRunInput,
  LaunchJourneyRunResult
> = {
  name: "launch_journey_run",
  risk: "spend",
  title: "Launch an MCPJam journey run",
  description:
    "Start a journey run and return immediately with its id — a fan-out can take hours, so nothing here waits for it. Poll get_journey_run, or list_journey_run_sessions for per-session detail. IDEMPOTENT on idempotencyKey: pass one, because a launch spends model credits and a retry must not run the journey twice. Behind the sandboxes-enabled beta.",
  readOnly: false,
  inputSchema: launchJourneyRunInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const run = await client.launchJourneyRun(
      {
        projectId: project.id,
        journeyId: input.journey,
        ...(input.waveId ? { waveId: input.waveId } : {}),
        ...(input.environmentIds?.length
          ? { environmentIds: input.environmentIds }
          : {}),
      },
      {
        signal,
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      },
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

export const cancelJourneyRunOperation: PlatformOperation<
  CancelJourneyRunInput,
  CancelJourneyRunResult
> = {
  name: "cancel_journey_run",
  risk: "destructive",
  title: "Stop a running MCPJam journey run",
  description:
    "Stop a journey run that is still running, settling its in-flight and pending sessions. Idempotent — cancelling an already-cancelled run succeeds with alreadyCanceled: true. A run that finished on its own conflicts instead, so you cannot be told you stopped something that had already completed.",
  readOnly: false,
  inputSchema: journeyRunSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const run = await client.cancelJourneyRun(
      { projectId: project.id, runId: input.run },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

// ── Scenarios (user testing) ────────────────────────────────────────────────
//
// A scenario is a project environment published for people outside the project
// to talk to. Internally these are `scenarios` rows and will stay that way;
// "scenario" is the public noun. The older `list_scenarios` / `get_scenario`
// operations still work and still point at the old routes until GA.
//
// Both operations need project ADMIN. Publishing is additionally behind the
// `sandboxes-enabled` beta flag; unpublishing deliberately is not.

const scenarioSelectorInput = z.object({
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
    .describe(
      "Project environment id to publish (or unpublish). One scenario per environment.",
    ),
});
// Create-time overrides, forwarded to the publish IN THE SAME CALL — without
// them, "publish this restricted to invited people only" is two operations
// with a window between them where the scenario is live in the default mode.
const publishScenarioInput = scenarioSelectorInput.extend({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Scenario name. CREATE-TIME ONLY — ignored on a republish of an already-published environment (rename with update_user_testing_scenario).",
    ),
  description: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "Scenario description. CREATE-TIME ONLY — ignored on a republish.",
    ),
  mode: z
    .enum(["project_members", "invited_only", "anyone_with_link"])
    .optional()
    .describe(
      "Who may open the share link: project_members (signed-in project members only), invited_only (named members, invited individually), anyone_with_link (anyone holding the URL). CREATE-TIME ONLY — ignored on a republish; change an existing scenario's mode with update_user_testing_scenario.",
    ),
});
export type PublishScenarioInput = z.infer<typeof publishScenarioInput>;

export type PublishScenarioResult = {
  project: SelectedProjectInfo;
  scenario: PlatformScenario;
  /**
   * True when overrides were sent but the environment was ALREADY published,
   * so they were ignored upstream. The scenario in the result carries the real
   * name and mode — a caller who asked for `invited_only` must not conclude
   * the link is restricted when it is not.
   */
  overridesIgnored?: boolean;
};

export const publishScenarioOperation: PlatformOperation<
  PublishScenarioInput,
  PublishScenarioResult
> = {
  name: "publish_scenario",
  risk: "exposure",
  title: "Publish a project environment as a user-testing scenario",
  description:
    "Publish a project environment so people outside the project can talk to it through a share link. Optional name, description and mode apply atomically at CREATE TIME, so the scenario is never briefly live in a wider mode than asked for. IDEMPOTENT — publishing an already-published environment returns the existing scenario rather than creating a second one; `created` tells you which happened, and `overridesIgnored: true` means the overrides were discarded because the scenario already existed. Requires project admin.",
  readOnly: false,
  inputSchema: publishScenarioInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const { overridesIgnored, ...scenario } = await client.publishScenario(
      {
        projectId: project.id,
        environmentId: input.environment,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
      },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      scenario,
      ...(overridesIgnored ? { overridesIgnored: true } : {}),
    };
  },
};

export type UnpublishScenarioInput = z.infer<typeof scenarioSelectorInput>;

export type UnpublishScenarioResult = {
  project: SelectedProjectInfo;
  result: PlatformScenarioDeleted;
};

export const unpublishScenarioOperation: PlatformOperation<
  UnpublishScenarioInput,
  UnpublishScenarioResult
> = {
  name: "unpublish_scenario",
  risk: "destructive",
  title: "Take a user-testing scenario down",
  description:
    "Unpublish an environment's scenario, invalidating its share link and any live guest sessions. Idempotent — an environment with no scenario reports `deleted: false` rather than failing. Requires project admin.",
  readOnly: false,
  inputSchema: scenarioSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const result = await client.unpublishScenario(
      { projectId: project.id, environmentId: input.environment },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), result };
  },
};

/**
 * The complete operation catalog, in append order.
 *
 * Every new operation must be appended here. Surface adapters (MCP, CLI,
 * agent, and in-app chat) partition this list and their tests fail when an
 * operation is neither exposed nor explicitly excluded.
 */
/**
 * Cross-field rules the ROUTES enforce, checked here so a caller is told by the
 * operation that validated their input rather than by a 400 two hops later.
 *
 * Deliberately NOT `.refine()` on the input schemas. Every surface that builds
 * a tool from the catalog extends those schemas — Zod 4 refuses to overwrite
 * keys on a refined object, so a refinement here silently breaks the agent and
 * MCP tool builders for the whole catalog, not just the refined operation.
 */
function requireExactlyOneGrounding(input: {
  environmentId?: string;
  serverAttachmentId?: string;
}): void {
  if (
    (input.environmentId === undefined) ===
    (input.serverAttachmentId === undefined)
  ) {
    throw operationInputError(
      "Provide exactly one of environmentId or serverAttachmentId to ground the drafts.",
    );
  }
}

function requireConfigPair(input: {
  sessionsPerTarget?: number;
  maxTurns?: number;
}): void {
  if (
    (input.sessionsPerTarget === undefined) !==
    (input.maxTurns === undefined)
  ) {
    throw operationInputError(
      "sessionsPerTarget and maxTurns must be sent together — they are one execution config upstream.",
    );
  }
}

// ── Swarms authoring ────────────────────────────────────────────────────────
//
// The half of the loop that did not exist. Everything below resolves the
// project by NAME OR ID through `resolveProjectOrThrow`, like the rest of the
// catalog, so an agent that was told "my checkout project" does not have to go
// and find an id first.

const personaSelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  persona: z.string().trim().min(1).describe("Persona id."),
});

const listPersonasInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
});

export type ListPersonasInput = z.infer<typeof listPersonasInput>;
export type ListPersonasResult = {
  project: SelectedProjectInfo;
  items: PlatformPersona[];
};

export const listPersonasOperation: PlatformOperation<
  ListPersonasInput,
  ListPersonasResult
> = {
  name: "list_personas",
  title: "List MCPJam personas",
  description:
    "The project's reusable synthetic characters — the cast Swarms journeys run as. A persona carries a name, a role and notes; the GOAL lives on each journey, so one persona can be pointed at many different things to try. Start here before creating a journey.",
  readOnly: true,
  inputSchema: listPersonasInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listPersonas(
      { projectId: project.id },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), items: page.items };
  },
};

export type GetPersonaInput = z.infer<typeof personaSelectorInput>;
export type GetPersonaResult = {
  project: SelectedProjectInfo;
  persona: PlatformPersona;
};

export const getPersonaOperation: PlatformOperation<
  GetPersonaInput,
  GetPersonaResult
> = {
  name: "get_persona",
  title: "Get one MCPJam persona",
  description: "One persona in full, including its notes.",
  readOnly: true,
  inputSchema: personaSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const persona = await client.getPersona(
      { projectId: project.id, personaId: input.persona },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), persona };
  },
};

const createPersonaInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  name: z.string().trim().min(1).max(120).describe("Display name."),
  role: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Who they are, in a few words — 'enterprise procurement lead'."),
  notes: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "How they behave: what they know, what they will not tolerate, how they phrase things. This is what makes a persona produce a realistic session rather than a compliant one.",
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Retry key. Pass one: the server replays it BEFORE uniquifying the slug, so a retry without it leaves a second near-identical persona named '…-2' rather than the one you already made.",
    ),
});

export type CreatePersonaInput = z.infer<typeof createPersonaInput>;
export type CreatePersonaResult = {
  project: SelectedProjectInfo;
  persona: PlatformPersona;
};

export const createPersonaOperation: PlatformOperation<
  CreatePersonaInput,
  CreatePersonaResult
> = {
  name: "create_persona",
  title: "Create an MCPJam persona",
  description:
    "Create a reusable synthetic character for Swarms to run as. Behind the sandboxes-enabled beta. Check get_capabilities first if you are unsure the organization has it.",
  readOnly: false,
  risk: "none",
  inputSchema: createPersonaInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const persona = await client.createPersona(
      {
        projectId: project.id,
        name: input.name,
        role: input.role,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      {
        signal,
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      },
    );
    return { project: toSelectedProjectInfo(project), persona };
  },
};

const updatePersonaInput = personaSelectorInput.extend({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.string().trim().min(1).max(120).optional(),
  notes: z.string().max(2000).optional(),
});

export type UpdatePersonaInput = z.infer<typeof updatePersonaInput>;
export type UpdatePersonaResult = CreatePersonaResult;

export const updatePersonaOperation: PlatformOperation<
  UpdatePersonaInput,
  UpdatePersonaResult
> = {
  name: "update_persona",
  title: "Update an MCPJam persona",
  description:
    "Edit a persona's name, role or notes. Runs already finished keep the persona they ran as — editing does not rewrite history.",
  readOnly: false,
  risk: "none",
  inputSchema: updatePersonaInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const persona = await client.updatePersona(
      {
        projectId: project.id,
        personaId: input.persona,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), persona };
  },
};

export type DeletePersonaInput = z.infer<typeof personaSelectorInput>;
export type DeletePersonaResult = {
  project: SelectedProjectInfo;
  persona: PlatformPersonaDeleted;
};

export const deletePersonaOperation: PlatformOperation<
  DeletePersonaInput,
  DeletePersonaResult
> = {
  name: "delete_persona",
  title: "Delete an MCPJam persona",
  description:
    "Remove a persona from the project's roster. SOFT: finished runs and sessions keep resolving it, so history stays intact, but the persona cannot be used for new journeys and a second delete answers not-found.",
  readOnly: false,
  risk: "destructive",
  inputSchema: personaSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const persona = await client.deletePersona(
      { projectId: project.id, personaId: input.persona },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), persona };
  },
};

const journeySelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  journey: z.string().trim().min(1).describe("Journey id."),
});

export type GetJourneyInput = z.infer<typeof journeySelectorInput>;
export type GetJourneyResult = {
  project: SelectedProjectInfo;
  journey: PlatformJourney;
};

export const getJourneyOperation: PlatformOperation<
  GetJourneyInput,
  GetJourneyResult
> = {
  name: "get_journey",
  title: "Get one MCPJam journey",
  description:
    "One journey in full: its goal, persona, environments and execution config. Read this before launching if you need to know how many sessions a run will produce — that is targets x sessionsPerTarget, and it is what spends.",
  readOnly: true,
  inputSchema: journeySelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const journey = await client.getJourney(
      { projectId: project.id, journeyId: input.journey },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), journey };
  },
};

const createJourneyInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  goal: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe(
      "What the persona is trying to accomplish. Drives the whole run.",
    ),
  persona: z.string().trim().min(1).describe("Persona id to run as."),
  name: z.string().trim().min(1).max(200).optional(),
  swarm: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Swarm container id. Authoring provenance only."),
  environmentIds: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("Environments to fan out across, in order."),
  sessionsPerTarget: z
    .number()
    .int()
    .min(1)
    .max(100)
    .describe(
      "Sessions per target. TOTAL sessions = targets x this, and the total is what spends.",
    ),
  maxTurns: z.number().int().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export type CreateJourneyInput = z.infer<typeof createJourneyInput>;
export type CreateJourneyResult = {
  project: SelectedProjectInfo;
  journey: PlatformJourney;
};

export const createJourneyOperation: PlatformOperation<
  CreateJourneyInput,
  CreateJourneyResult
> = {
  name: "create_journey",
  title: "Create an MCPJam journey",
  description:
    "Author a journey: a persona, a goal, and the environments to pursue it against. Creating does NOT run it — launch_journey_run does, and that is the call that spends. Behind the sandboxes-enabled beta.",
  readOnly: false,
  risk: "none",
  inputSchema: createJourneyInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const journey = await client.createJourney(
      {
        projectId: project.id,
        goal: input.goal,
        personaId: input.persona,
        sessionsPerTarget: input.sessionsPerTarget,
        maxTurns: input.maxTurns,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.swarm !== undefined ? { swarmId: input.swarm } : {}),
        ...(input.environmentIds !== undefined
          ? { environmentIds: input.environmentIds }
          : {}),
      },
      {
        signal,
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      },
    );
    return { project: toSelectedProjectInfo(project), journey };
  },
};

const updateJourneyInput = journeySelectorInput.extend({
  name: z.string().trim().min(1).max(200).optional(),
  goal: z.string().trim().min(1).max(4000).optional(),
  environmentIds: z
    .union([z.array(z.string().min(1)).min(1), z.null()])
    .optional()
    .describe("null clears the fan-out and returns the journey to its hosts."),
  sessionsPerTarget: z.number().int().min(1).max(100).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
});

export type UpdateJourneyInput = z.infer<typeof updateJourneyInput>;
export type UpdateJourneyResult = CreateJourneyResult;

export const updateJourneyOperation: PlatformOperation<
  UpdateJourneyInput,
  UpdateJourneyResult
> = {
  name: "update_journey",
  title: "Update an MCPJam journey",
  description:
    "Edit a journey. sessionsPerTarget and maxTurns must be sent together — they are one execution config upstream. A run already in flight keeps the config it launched with.",
  readOnly: false,
  risk: "none",
  inputSchema: updateJourneyInput,
  async execute(input, { client, signal }) {
    requireConfigPair(input);
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const journey = await client.updateJourney(
      {
        projectId: project.id,
        journeyId: input.journey,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.environmentIds !== undefined
          ? { environmentIds: input.environmentIds }
          : {}),
        ...(input.sessionsPerTarget !== undefined
          ? { sessionsPerTarget: input.sessionsPerTarget }
          : {}),
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), journey };
  },
};

export type ArchiveJourneyInput = z.infer<typeof journeySelectorInput>;
export type ArchiveJourneyResult = {
  project: SelectedProjectInfo;
  journey: PlatformJourneyArchived;
};

export const archiveJourneyOperation: PlatformOperation<
  ArchiveJourneyInput,
  ArchiveJourneyResult
> = {
  name: "archive_journey",
  title: "Archive an MCPJam journey",
  description:
    "Take a journey off the roster. Its runs, sessions and scorecards stay readable — the evidence for past decisions is not deleted with the journey that produced it. A second call answers not-found.",
  readOnly: false,
  risk: "destructive",
  inputSchema: journeySelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const journey = await client.archiveJourney(
      { projectId: project.id, journeyId: input.journey },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), journey };
  },
};

const swarmSelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  swarm: z.string().trim().min(1).describe("Swarm container id."),
});

export type ListSwarmsInput = z.infer<typeof listPersonasInput>;
export type ListSwarmsResult = {
  project: SelectedProjectInfo;
  items: PlatformSwarm[];
};

export const listSwarmsOperation: PlatformOperation<
  ListSwarmsInput,
  ListSwarmsResult
> = {
  name: "list_swarms",
  title: "List MCPJam swarm containers",
  description:
    "Swarm containers group journeys authored together and hold their shared execution config. A journey does not need one — but a project authored through the app will have them, so list here to match what a human would see.",
  readOnly: true,
  inputSchema: listPersonasInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listSwarms({ projectId: project.id }, { signal });
    return { project: toSelectedProjectInfo(project), items: page.items };
  },
};

export type GetSwarmInput = z.infer<typeof swarmSelectorInput>;
export type GetSwarmResult = {
  project: SelectedProjectInfo;
  swarm: PlatformSwarm;
};

export const getSwarmOperation: PlatformOperation<
  GetSwarmInput,
  GetSwarmResult
> = {
  name: "get_swarm",
  title: "Get one MCPJam swarm container",
  description: "One swarm container: its name, defaults and fan-out.",
  readOnly: true,
  inputSchema: swarmSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const swarm = await client.getSwarm(
      { projectId: project.id, swarmId: input.swarm },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), swarm };
  },
};

const createSwarmInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  environmentIds: z.array(z.string().min(1)).min(1).optional(),
  sessionsPerTarget: z.number().int().min(1).max(100),
  maxTurns: z.number().int().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export type CreateSwarmInput = z.infer<typeof createSwarmInput>;
export type CreateSwarmResult = {
  project: SelectedProjectInfo;
  swarm: PlatformSwarm;
};

export const createSwarmOperation: PlatformOperation<
  CreateSwarmInput,
  CreateSwarmResult
> = {
  name: "create_swarm",
  title: "Create an MCPJam swarm container",
  description:
    "Create a container to author journeys under. Creating one runs nothing. Behind the sandboxes-enabled beta.",
  readOnly: false,
  risk: "none",
  inputSchema: createSwarmInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const swarm = await client.createSwarm(
      {
        projectId: project.id,
        name: input.name,
        sessionsPerTarget: input.sessionsPerTarget,
        maxTurns: input.maxTurns,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.environmentIds !== undefined
          ? { environmentIds: input.environmentIds }
          : {}),
      },
      {
        signal,
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      },
    );
    return { project: toSelectedProjectInfo(project), swarm };
  },
};

const updateSwarmInput = swarmSelectorInput.extend({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.union([z.string().max(2000), z.null()]).optional(),
  environmentIds: z
    .union([z.array(z.string().min(1)).min(1), z.null()])
    .optional(),
  sessionsPerTarget: z.number().int().min(1).max(100).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
});

export type UpdateSwarmInput = z.infer<typeof updateSwarmInput>;
export type UpdateSwarmResult = CreateSwarmResult;

export const updateSwarmOperation: PlatformOperation<
  UpdateSwarmInput,
  UpdateSwarmResult
> = {
  name: "update_swarm",
  title: "Update an MCPJam swarm container",
  description:
    "Edit a swarm container. sessionsPerTarget and maxTurns must be sent together — they are one config object upstream.",
  readOnly: false,
  risk: "none",
  inputSchema: updateSwarmInput,
  async execute(input, { client, signal }) {
    requireConfigPair(input);
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const swarm = await client.updateSwarm(
      {
        projectId: project.id,
        swarmId: input.swarm,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.environmentIds !== undefined
          ? { environmentIds: input.environmentIds }
          : {}),
        ...(input.sessionsPerTarget !== undefined
          ? { sessionsPerTarget: input.sessionsPerTarget }
          : {}),
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), swarm };
  },
};

export type ArchiveSwarmInput = z.infer<typeof swarmSelectorInput>;
export type ArchiveSwarmResult = {
  project: SelectedProjectInfo;
  swarm: PlatformSwarmArchived;
};

export const archiveSwarmOperation: PlatformOperation<
  ArchiveSwarmInput,
  ArchiveSwarmResult
> = {
  name: "archive_swarm",
  title: "Archive an MCPJam swarm container",
  description:
    "Take a swarm container off the roster. Journeys authored under it keep working — the reference is authoring provenance, not ownership.",
  readOnly: false,
  risk: "destructive",
  inputSchema: swarmSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const swarm = await client.archiveSwarm(
      { projectId: project.id, swarmId: input.swarm },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), swarm };
  },
};

const generationGroundingInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  environmentId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Ground the drafts in this environment. Use this one normally."),
  serverAttachmentId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Legacy grounding source. Use environmentId instead."),
  description: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe("Who the audience is, in your own words."),
  journeyCount: z.number().int().min(1).max(5).optional(),
});

const generatePersonasInput = generationGroundingInput.extend({
  personaCount: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe("Ask for a slate of N personas instead of one."),
  existingPersonas: z
    .array(z.object({ name: z.string().min(1), role: z.string().min(1) }))
    .max(30)
    .optional()
    .describe("Personas you already have, so the drafts do not repeat them."),
});

export type GeneratePersonasInput = z.infer<typeof generatePersonasInput>;
export type GeneratePersonasResult = {
  project: SelectedProjectInfo;
  drafts: PlatformGenerationDrafts;
};

export const generatePersonasOperation: PlatformOperation<
  GeneratePersonasInput,
  GeneratePersonasResult
> = {
  name: "generate_personas",
  title: "Draft MCPJam personas with a model",
  description:
    "Draft candidate personas grounded in what the project's servers actually do. NOTHING IS SAVED — pick what you want and pass it to create_persona. Runs a model on the organization's account, so it spends. Exactly one of environmentId or serverAttachmentId.",
  readOnly: false,
  risk: "spend",
  inputSchema: generatePersonasInput,
  async execute(input, { client, signal }) {
    requireExactlyOneGrounding(input);
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const drafts = await client.generatePersonas(
      {
        projectId: project.id,
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        ...(input.serverAttachmentId
          ? { serverAttachmentId: input.serverAttachmentId }
          : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.journeyCount !== undefined
          ? { journeyCount: input.journeyCount }
          : {}),
        ...(input.personaCount !== undefined
          ? { personaCount: input.personaCount }
          : {}),
        ...(input.existingPersonas?.length
          ? { existingPersonas: input.existingPersonas }
          : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), drafts };
  },
};

const generateJourneysInput = generationGroundingInput.extend({
  persona: z
    .object({
      name: z.string().min(1),
      role: z.string().min(1),
      notes: z.string().optional(),
    })
    .describe(
      "The persona to draft journeys for, BY VALUE — it does not have to exist yet.",
    ),
});

export type GenerateJourneysInput = z.infer<typeof generateJourneysInput>;
export type GenerateJourneysResult = {
  project: SelectedProjectInfo;
  drafts: PlatformGenerationDrafts;
};

export const generateJourneysOperation: PlatformOperation<
  GenerateJourneysInput,
  GenerateJourneysResult
> = {
  name: "generate_journeys",
  title: "Draft MCPJam journeys with a model",
  description:
    "Draft candidate journeys for a persona, grounded in the project's servers. NOTHING IS SAVED — pass what you want to create_journey. Spends. Exactly one of environmentId or serverAttachmentId.",
  readOnly: false,
  risk: "spend",
  inputSchema: generateJourneysInput,
  async execute(input, { client, signal }) {
    requireExactlyOneGrounding(input);
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const drafts = await client.generateJourneys(
      {
        projectId: project.id,
        persona: input.persona,
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        ...(input.serverAttachmentId
          ? { serverAttachmentId: input.serverAttachmentId }
          : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.journeyCount !== undefined
          ? { journeyCount: input.journeyCount }
          : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), drafts };
  },
};

// ── Swarm insights ──────────────────────────────────────────────────────────

export type GetSwarmOverviewInput = z.infer<typeof listPersonasInput>;
export type GetSwarmOverviewResult = {
  project: SelectedProjectInfo;
  overview: PlatformSwarmOverview;
};

export const getSwarmOverviewOperation: PlatformOperation<
  GetSwarmOverviewInput,
  GetSwarmOverviewResult
> = {
  name: "get_swarms_overview",
  title: "Get the MCPJam swarms overview",
  description:
    "The project's recent journey runs with their rubric findings and goal-completion trend — the roll-up a human sees on the Swarms page. Start here to answer 'how are our swarms doing'. Rates are over GRADED sessions, never attempted ones, and passRate is null (not 0) when nothing has been graded.",
  readOnly: true,
  inputSchema: listPersonasInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const overview = await client.getSwarmOverview(
      { projectId: project.id },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), overview };
  },
};

export type GetJourneyRunScorecardInput = z.infer<
  typeof journeyRunSelectorInput
>;
export type GetJourneyRunScorecardResult = {
  project: SelectedProjectInfo;
  scorecard: PlatformRunScorecard;
};

export const getJourneyRunScorecardOperation: PlatformOperation<
  GetJourneyRunScorecardInput,
  GetJourneyRunScorecardResult
> = {
  name: "get_journey_run_scorecard",
  title: "Get a journey run's rubric scorecard",
  description:
    "Per-criterion pass/fail counts for one run. DETERMINISTIC — no model involved — so this is the first thing to read when explaining a failure, and usually the whole answer. failedGradingCount is grading that BROKE, not a product failure; do not add it to failCount. Answers not-found when the run has no rubric.",
  readOnly: true,
  inputSchema: journeyRunSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const scorecard = await client.getJourneyRunScorecard(
      { projectId: project.id, runId: input.run },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), scorecard };
  },
};

export type ListSwarmFindingsInput = z.infer<typeof listPersonasInput>;
export type ListSwarmFindingsResult = {
  project: SelectedProjectInfo;
  items: PlatformSwarmFinding[];
};

export const listSwarmFindingsOperation: PlatformOperation<
  ListSwarmFindingsInput,
  ListSwarmFindingsResult
> = {
  name: "list_swarm_findings",
  title: "List MCPJam swarm findings",
  description:
    "Criteria that keep failing across waves, with how long each has been failing. A finding with a long streak is a standing problem; a `new` one is what just changed.",
  readOnly: true,
  inputSchema: listPersonasInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listSwarmFindings(
      { projectId: project.id },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), items: page.items };
  },
};

const findingSelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  finding: z.string().trim().min(1).describe("Finding id."),
});

export type DismissSwarmFindingInput = z.infer<typeof findingSelectorInput>;
export type DismissSwarmFindingResult = {
  project: SelectedProjectInfo;
  finding: PlatformFindingDismissed;
};

export const dismissSwarmFindingOperation: PlatformOperation<
  DismissSwarmFindingInput,
  DismissSwarmFindingResult
> = {
  name: "dismiss_swarm_finding",
  title: "Dismiss an MCPJam swarm finding",
  description:
    "Mark a finding as not worth acting on. It stops surfacing as active but its lifecycle keeps updating underneath, so undismissing later shows honest current state rather than a stale snapshot.",
  readOnly: false,
  risk: "none",
  inputSchema: findingSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const finding = await client.dismissSwarmFinding(
      { projectId: project.id, findingId: input.finding },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), finding };
  },
};

export type UndismissSwarmFindingInput = DismissSwarmFindingInput;
export type UndismissSwarmFindingResult = DismissSwarmFindingResult;

export const undismissSwarmFindingOperation: PlatformOperation<
  UndismissSwarmFindingInput,
  UndismissSwarmFindingResult
> = {
  name: "undismiss_swarm_finding",
  title: "Undismiss an MCPJam swarm finding",
  description: "Bring a dismissed finding back into the active list.",
  readOnly: false,
  risk: "none",
  inputSchema: findingSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const finding = await client.undismissSwarmFinding(
      { projectId: project.id, findingId: input.finding },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), finding };
  },
};

const waveSelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  wave: z
    .string()
    .trim()
    .min(1)
    .describe("Wave id — the `waveId` on a journey run."),
});

export type GetWaveInsightsInput = z.infer<typeof waveSelectorInput>;
export type GetWaveInsightsResult = {
  project: SelectedProjectInfo;
  insights: PlatformWaveInsights;
};

export const getWaveInsightsOperation: PlatformOperation<
  GetWaveInsightsInput,
  GetWaveInsightsResult
> = {
  name: "get_wave_insights",
  title: "Get an MCPJam wave's insights",
  description:
    "The model's analysis of a whole wave, if one has been requested. Poll this after request_wave_insights — status goes pending → completed. Not-found means nobody has requested it, which is different from 'requested and still working'.",
  readOnly: true,
  inputSchema: waveSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const insights = await client.getWaveInsights(
      { projectId: project.id, waveId: input.wave },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), insights };
  },
};

const requestWaveInsightsInput = waveSelectorInput.extend({
  force: z
    .boolean()
    .optional()
    .describe(
      "Regenerate over a wave that already has insights. SPENDS AGAIN — the usual reason a wave looks stuck is a caller that did not poll, so read get_wave_insights before reaching for this.",
    ),
});

export type RequestWaveInsightsInput = z.infer<typeof requestWaveInsightsInput>;
export type RequestWaveInsightsResult = {
  project: SelectedProjectInfo;
  request: PlatformWaveInsightsRequested;
};

export const requestWaveInsightsOperation: PlatformOperation<
  RequestWaveInsightsInput,
  RequestWaveInsightsResult
> = {
  name: "request_wave_insights",
  title: "Request MCPJam wave insights",
  description:
    "Ask a model to analyze a whole wave. Returns immediately with status pending; poll get_wave_insights. SPENDS against the organization's daily insights budget, which is SHARED with user-testing insights — burning it here takes it from there. Read the run scorecards first; they are free and usually explain the failure.",
  readOnly: false,
  risk: "spend",
  inputSchema: requestWaveInsightsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const request = await client.requestWaveInsights(
      {
        projectId: project.id,
        waveId: input.wave,
        ...(input.force ? { force: true } : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), request };
  },
};

export type CancelWaveInsightsInput = z.infer<typeof waveSelectorInput>;
export type CancelWaveInsightsResult = {
  project: SelectedProjectInfo;
  canceled: PlatformWaveInsightsCanceled;
};

export const cancelWaveInsightsOperation: PlatformOperation<
  CancelWaveInsightsInput,
  CancelWaveInsightsResult
> = {
  name: "cancel_wave_insights",
  title: "Cancel an MCPJam wave insights request",
  description:
    "Stop an in-flight insights generation. This is the recovery path for a wave stuck in pending — without it the only way forward is force, which spends again.",
  readOnly: false,
  risk: "none",
  inputSchema: waveSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const canceled = await client.cancelWaveInsights(
      { projectId: project.id, waveId: input.wave },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), canceled };
  },
};

// ── Capabilities ────────────────────────────────────────────────────────────

export type GetCapabilitiesInput = z.infer<typeof listPersonasInput>;
export type GetCapabilitiesResult = {
  project: SelectedProjectInfo;
  capabilities: PlatformCapabilities;
};

export const getCapabilitiesOperation: PlatformOperation<
  GetCapabilitiesInput,
  GetCapabilitiesResult
> = {
  name: "get_capabilities",
  title: "Get what you may do in an MCPJam project",
  description:
    "Your role, which betas this organization has, your plan's limits, and a `can` block of booleans to branch on. CHECK THIS BEFORE PLANNING work that authors, launches or publishes: the tool list you can see is the same for every caller, so it cannot tell you that this organization is not in the Swarms beta or that you are a member where the operation needs an admin. Finding that out from a 403 means you have already told someone you were doing it.",
  readOnly: true,
  inputSchema: listPersonasInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const capabilities = await client.getCapabilities(
      { projectId: project.id },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), capabilities };
  },
};

// ── User testing ────────────────────────────────────────────────────────────
//
// What a published scenario produced, and who may reach it. `publish_scenario`
// creates one; everything here addresses the scenario itself.
//
// The scenario is selected by ID rather than by name, unlike projects: a
// scenario's name is the public-facing label a visitor sees, so it is edited
// often and duplicated freely, and resolving by name would let an agent
// rotate the link on whichever "Checkout test" it matched first.

const userTestingScenarioSelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  scenario: z
    .string()
    .trim()
    .min(1)
    .describe("Scenario id (the `id` from list_scenarios / publish_scenario)."),
});

export type GetUserTestingScenarioInput = z.infer<
  typeof userTestingScenarioSelectorInput
>;

export type GetUserTestingScenarioResult = {
  project: SelectedProjectInfo;
  scenario: PlatformUserTestingScenarioDetail;
};

export const getUserTestingScenarioOperation: PlatformOperation<
  GetUserTestingScenarioInput,
  GetUserTestingScenarioResult
> = {
  name: "get_user_testing_scenario",
  title: "Get a user-testing scenario",
  description:
    "Scenario detail plus its actionable-insights envelope: findings AGGREGATED over the latest analyzed window of real visitor sessions, each with exemplar evidence. Only a finding with actionTarget mcp_server AND actionability ready authorizes proposing a server change; agent_configuration / eval_case / environment / investigate findings name other work and must not be 'fixed' in server code. Reads never trigger generation — request_user_testing_insights does, and spends.",
  readOnly: true,
  inputSchema: userTestingScenarioSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const scenario = await client.getUserTestingScenario(
      { projectId: project.id, scenarioId: input.scenario },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), scenario };
  },
};

const updateUserTestingScenarioInput = userTestingScenarioSelectorInput.extend({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  mode: z
    .enum(["project_members", "invited_only", "anyone_with_link"])
    .optional()
    .describe(
      "Who may open the share link. Send this ON ITS OWN — identity and exposure are separate operations, and a mixed request is rejected.",
    ),
});

export type UpdateUserTestingScenarioInput = z.infer<
  typeof updateUserTestingScenarioInput
>;
export type UpdateUserTestingScenarioResult = {
  project: SelectedProjectInfo;
  scenario: PlatformUserTestingScenario;
};

export const updateUserTestingScenarioOperation: PlatformOperation<
  UpdateUserTestingScenarioInput,
  UpdateUserTestingScenarioResult
> = {
  name: "update_user_testing_scenario",
  title: "Update a user-testing scenario",
  description:
    "Rename a scenario, or change who may open its share link. SINGLE-CONCERN: send `mode` alone, or name/description together — never both, because they are separate operations upstream and applying them in sequence could leave the scenario live in a mode nobody asked for. Widening to anyone_with_link exposes it to anyone holding the URL. Workspace membership is enough — no admin needed.",
  readOnly: false,
  risk: "exposure",
  inputSchema: updateUserTestingScenarioInput,
  async execute(input, { client, signal }) {
    // Identity and exposure are separate mutations upstream, so the route
    // refuses to chain them: a failure between the two would leave the
    // scenario half-updated on the half that decides who can reach it.
    if (
      input.mode !== undefined &&
      (input.name !== undefined || input.description !== undefined)
    ) {
      throw operationInputError(
        "Send `mode` on its own: identity and exposure are separate operations upstream.",
      );
    }
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const scenario = await client.updateUserTestingScenario(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), scenario };
  },
};

const listUserTestingSessionsInput = userTestingScenarioSelectorInput.extend({
  cursor: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Pass the previous response's nextCursor to get the next page."),
  limit: z.number().int().min(1).max(200).optional(),
});

export type ListUserTestingSessionsInput = z.infer<
  typeof listUserTestingSessionsInput
>;
export type ListUserTestingSessionsResult = {
  project: SelectedProjectInfo;
  items: PlatformUserTestingSession[];
  nextCursor?: string;
};

export const listUserTestingSessionsOperation: PlatformOperation<
  ListUserTestingSessionsInput,
  ListUserTestingSessionsResult
> = {
  name: "list_user_testing_sessions",
  title: "List the sessions a user-testing scenario produced",
  description:
    "Sessions real visitors had with a published scenario: message counts, feedback, device and visitor segment, and a first-message preview. SUMMARIES only — transcripts are a separate call, because these are real people's conversations and a listing should not page them into every caller that wanted counts.",
  readOnly: true,
  inputSchema: listUserTestingSessionsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listUserTestingSessions(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal },
    );
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  },
};

const getUserTestingSessionInput = userTestingScenarioSelectorInput.extend({
  session: z.string().trim().min(1).describe("Session id."),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export type GetUserTestingSessionInput = z.infer<
  typeof getUserTestingSessionInput
>;
export type GetUserTestingSessionResult = {
  project: SelectedProjectInfo;
  session: PlatformUserTestingSessionDetail;
};

export const getUserTestingSessionOperation: PlatformOperation<
  GetUserTestingSessionInput,
  GetUserTestingSessionResult
> = {
  name: "get_user_testing_session",
  title: "Read one user-testing session's transcript",
  description:
    "One session's conversation, paged. This is a real person talking to your product — read it when you need the words, and prefer get_user_testing_metrics or the findings when you need the pattern. transcriptUnavailable: true means the stored conversation could not be read, which is NOT the same as the visitor saying nothing.",
  readOnly: true,
  inputSchema: getUserTestingSessionInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const session = await client.getUserTestingSession(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        sessionId: input.session,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), session };
  },
};

const userTestingMetricsInput = userTestingScenarioSelectorInput.extend({
  population: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Restrict the metrics to a session population."),
});

export type GetUserTestingMetricsInput = z.infer<
  typeof userTestingMetricsInput
>;
export type GetUserTestingMetricsResult = {
  project: SelectedProjectInfo;
  metrics: Record<string, unknown>;
};

export const getUserTestingMetricsOperation: PlatformOperation<
  GetUserTestingMetricsInput,
  GetUserTestingMetricsResult
> = {
  name: "get_user_testing_metrics",
  title: "Get a user-testing scenario's session metrics",
  description:
    "Aggregate metrics across a scenario's sessions. Start here rather than reading transcripts — it answers 'how is this going' without pulling anyone's conversation into the turn.",
  readOnly: true,
  inputSchema: userTestingMetricsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const metrics = await client.getUserTestingMetrics(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        ...(input.population ? { population: input.population } : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), metrics };
  },
};

export type GetUserTestingUsageInput = z.infer<
  typeof userTestingScenarioSelectorInput
>;
export type GetUserTestingUsageResult = {
  project: SelectedProjectInfo;
  usage: Record<string, unknown>;
};

export const getUserTestingUsageOperation: PlatformOperation<
  GetUserTestingUsageInput,
  GetUserTestingUsageResult
> = {
  name: "get_user_testing_usage",
  title: "Get a user-testing scenario's usage breakdown",
  description:
    "Usage rates for a scenario, broken down by visitor and device. READ `scan.truncated` BEFORE QUOTING ANY RATE: true means the numbers were computed over the most recent N sessions rather than all of them, so reporting them unconditionally would overstate what was measured.",
  readOnly: true,
  inputSchema: userTestingScenarioSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const usage = await client.getUserTestingUsage(
      { projectId: project.id, scenarioId: input.scenario },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), usage };
  },
};

export type ListUserTestingFindingsInput = z.infer<
  typeof userTestingScenarioSelectorInput
>;
export type ListUserTestingFindingsResult = {
  project: SelectedProjectInfo;
  items: Array<Record<string, unknown>>;
};

export const listUserTestingFindingsOperation: PlatformOperation<
  ListUserTestingFindingsInput,
  ListUserTestingFindingsResult
> = {
  name: "list_user_testing_findings",
  title: "List a user-testing scenario's findings",
  description:
    "Problems detected across a scenario's sessions, tracked over time so a recurring one is distinguishable from a new one.",
  readOnly: true,
  inputSchema: userTestingScenarioSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listUserTestingFindings(
      { projectId: project.id, scenarioId: input.scenario },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), items: page.items };
  },
};

export type GetUserTestingSignalsInput = z.infer<
  typeof userTestingScenarioSelectorInput
>;
export type GetUserTestingSignalsResult = {
  project: SelectedProjectInfo;
  signals: Record<string, unknown>;
};

export const getUserTestingSignalsOperation: PlatformOperation<
  GetUserTestingSignalsInput,
  GetUserTestingSignalsResult
> = {
  name: "get_user_testing_signals",
  title: "Get a user-testing scenario's current window signals",
  description:
    "The scenario's live analysis window, and the `windowId` you need to read its insights. Call this first when you want insights for 'the current window'.",
  readOnly: true,
  inputSchema: userTestingScenarioSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const signals = await client.getUserTestingSignals(
      { projectId: project.id, scenarioId: input.scenario },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), signals };
  },
};

const userTestingWindowInput = userTestingScenarioSelectorInput.extend({
  window: z
    .string()
    .trim()
    .min(1)
    .describe("Window id, from get_user_testing_signals."),
});

export type GetUserTestingInsightsInput = z.infer<
  typeof userTestingWindowInput
>;
export type GetUserTestingInsightsResult = {
  project: SelectedProjectInfo;
  insights: Record<string, unknown>;
};

export const getUserTestingInsightsOperation: PlatformOperation<
  GetUserTestingInsightsInput,
  GetUserTestingInsightsResult
> = {
  name: "get_user_testing_insights",
  title: "Get a user-testing window's insights",
  description:
    "The model's analysis of one analysis window, if one has been requested. Not-found means nobody has requested it, which is different from requested-and-still-working.",
  readOnly: true,
  inputSchema: userTestingWindowInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const insights = await client.getUserTestingInsights(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        windowId: input.window,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), insights };
  },
};

const requestUserTestingInsightsInput = userTestingScenarioSelectorInput.extend(
  {
    force: z
      .boolean()
      .optional()
      .describe(
        "Regenerate over a window that already has insights. Spends again.",
      ),
  },
);

export type RequestUserTestingInsightsInput = z.infer<
  typeof requestUserTestingInsightsInput
>;
export type RequestUserTestingInsightsResult = {
  project: SelectedProjectInfo;
  request: PlatformUserTestingInsightsRequested;
};

export const requestUserTestingInsightsOperation: PlatformOperation<
  RequestUserTestingInsightsInput,
  RequestUserTestingInsightsResult
> = {
  name: "request_user_testing_insights",
  title: "Request insights for a user-testing scenario",
  description:
    "Ask a model to analyze the scenario's current window. Returns immediately with the windowId and status pending; poll get_user_testing_insights. SPENDS against the organization's daily insights budget, which is SHARED with swarm wave insights. A 409 means the window has not been mined yet — wait, do not retry in a loop.",
  readOnly: false,
  risk: "spend",
  inputSchema: requestUserTestingInsightsInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const request = await client.requestUserTestingInsights(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        ...(input.force ? { force: true } : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), request };
  },
};

export type CancelUserTestingInsightsInput = z.infer<
  typeof userTestingWindowInput
>;
export type CancelUserTestingInsightsResult = {
  project: SelectedProjectInfo;
  canceled: Record<string, unknown>;
};

export const cancelUserTestingInsightsOperation: PlatformOperation<
  CancelUserTestingInsightsInput,
  CancelUserTestingInsightsResult
> = {
  name: "cancel_user_testing_insights",
  title: "Cancel a user-testing insights request",
  description:
    "Stop an in-flight insights generation. The recovery path for a window stuck pending — without it the only way forward is force, which spends again.",
  readOnly: false,
  risk: "none",
  inputSchema: userTestingWindowInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const canceled = await client.cancelUserTestingInsights(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        windowId: input.window,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), canceled };
  },
};

const userTestingFindingInput = userTestingScenarioSelectorInput.extend({
  finding: z.string().trim().min(1).describe("Finding id."),
});

export type DismissUserTestingFindingInput = z.infer<
  typeof userTestingFindingInput
>;
export type DismissUserTestingFindingResult = {
  project: SelectedProjectInfo;
  finding: Record<string, unknown>;
};

export const dismissUserTestingFindingOperation: PlatformOperation<
  DismissUserTestingFindingInput,
  DismissUserTestingFindingResult
> = {
  name: "dismiss_user_testing_finding",
  title: "Dismiss a user-testing finding",
  description:
    "Mark a finding as not worth acting on. Its lifecycle keeps updating underneath, so undismissing later shows honest current state.",
  readOnly: false,
  risk: "none",
  inputSchema: userTestingFindingInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const finding = await client.dismissUserTestingFinding(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        findingId: input.finding,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), finding };
  },
};

export type UndismissUserTestingFindingInput = DismissUserTestingFindingInput;
export type UndismissUserTestingFindingResult = DismissUserTestingFindingResult;

export const undismissUserTestingFindingOperation: PlatformOperation<
  UndismissUserTestingFindingInput,
  UndismissUserTestingFindingResult
> = {
  name: "undismiss_user_testing_finding",
  title: "Undismiss a user-testing finding",
  description: "Bring a dismissed finding back into the active list.",
  readOnly: false,
  risk: "none",
  inputSchema: userTestingFindingInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const finding = await client.undismissUserTestingFinding(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        findingId: input.finding,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), finding };
  },
};

const setGuestExecutionInput = userTestingScenarioSelectorInput.extend({
  enabled: z.boolean(),
  computerEnabled: z.boolean(),
  sharedSkillsEnabled: z.boolean(),
  dailyCreditCap: z
    .number()
    .min(0)
    .describe("Hard ceiling on what visitors can spend per day, in credits."),
  dailyComputerStartCap: z.number().int().min(0),
  maxConcurrentComputers: z.number().int().min(0),
  harnessEnabled: z.boolean().optional(),
  dailyHarnessSpendCapMicros: z.number().int().min(0).optional(),
  dailyHarnessCallCap: z.number().int().min(0).optional(),
  maxConcurrentHarnessRuns: z.number().int().min(0).optional(),
});

export type SetUserTestingGuestExecutionInput = z.infer<
  typeof setGuestExecutionInput
>;
export type SetUserTestingGuestExecutionResult = {
  project: SelectedProjectInfo;
  result: Record<string, unknown>;
};

export const setUserTestingGuestExecutionOperation: PlatformOperation<
  SetUserTestingGuestExecutionInput,
  SetUserTestingGuestExecutionResult
> = {
  name: "set_user_testing_guest_execution",
  title: "Set a user-testing scenario's guest execution caps",
  description:
    "What anonymous visitors may run on the organization's account, and how much of it. A FULL REPLACEMENT, not a patch: send every field, because these caps only mean something as a set and raising one while leaving a stale sibling produces a combination nobody chose. Read the current values first. Project admin.",
  readOnly: false,
  risk: "spend",
  inputSchema: setGuestExecutionInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const { project: _project, scenario, ...guestExecution } = input;
    const result = await client.setUserTestingGuestExecution(
      {
        projectId: project.id,
        scenarioId: scenario,
        guestExecution,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), result };
  },
};

export type RotateUserTestingLinkInput = z.infer<
  typeof userTestingScenarioSelectorInput
>;
export type RotateUserTestingLinkResult = {
  project: SelectedProjectInfo;
  result: Record<string, unknown>;
};

export const rotateUserTestingLinkOperation: PlatformOperation<
  RotateUserTestingLinkInput,
  RotateUserTestingLinkResult
> = {
  name: "rotate_user_testing_link",
  title: "Rotate a user-testing scenario's share link",
  description:
    "Mint a new share link and invalidate the old one. IMMEDIATE AND IRREVERSIBLE: everyone holding the old URL loses access and every live session on it dies. This is what you do when a link has leaked, not routine hygiene. Workspace membership is enough — no admin needed.",
  readOnly: false,
  risk: "destructive",
  inputSchema: userTestingScenarioSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const result = await client.rotateUserTestingLink(
      { projectId: project.id, scenarioId: input.scenario },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), result };
  },
};

const upsertUserTestingMemberInput = userTestingScenarioSelectorInput.extend({
  email: z.string().trim().min(3).max(320),
  sendInviteEmail: z
    .boolean()
    .optional()
    .describe(
      "Off by default — adding someone is not the same as telling them.",
    ),
});

export type UpsertUserTestingMemberInput = z.infer<
  typeof upsertUserTestingMemberInput
>;
export type UpsertUserTestingMemberResult = {
  project: SelectedProjectInfo;
  result: Record<string, unknown>;
};

export const upsertUserTestingMemberOperation: PlatformOperation<
  UpsertUserTestingMemberInput,
  UpsertUserTestingMemberResult
> = {
  name: "upsert_user_testing_member",
  title: "Invite someone to a user-testing scenario",
  description:
    "Grant one person access to a scenario by email. Upsert, so re-inviting an existing member is not an error. Widens who can reach the scenario.",
  readOnly: false,
  risk: "exposure",
  inputSchema: upsertUserTestingMemberInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const result = await client.upsertUserTestingMember(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        email: input.email,
        ...(input.sendInviteEmail !== undefined
          ? { sendInviteEmail: input.sendInviteEmail }
          : {}),
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), result };
  },
};

const removeUserTestingMemberInput = userTestingScenarioSelectorInput.extend({
  member: z.string().trim().min(1).describe("Member id or email."),
});

export type RemoveUserTestingMemberInput = z.infer<
  typeof removeUserTestingMemberInput
>;
export type RemoveUserTestingMemberResult = UpsertUserTestingMemberResult;

export const removeUserTestingMemberOperation: PlatformOperation<
  RemoveUserTestingMemberInput,
  RemoveUserTestingMemberResult
> = {
  name: "remove_user_testing_member",
  title: "Remove someone from a user-testing scenario",
  description:
    "Revoke one person's access. Narrowing exposure is the safe direction, so this is never blocked by the beta gate — losing access to a feature is exactly when revoking matters most. It is still a REMOVAL: the person loses a scenario they could reach, and getting it back means inviting them again.",
  readOnly: false,
  // `destructive` is about HARM, not about gating. Revoking access removes
  // something a named person had, which is what a client should be able to
  // confirm before it fires; that it is also ungated by the beta flag is a
  // separate property, decided by direction of exposure rather than by risk.
  risk: "destructive",
  inputSchema: removeUserTestingMemberInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const result = await client.removeUserTestingMember(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        member: input.member,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), result };
  },
};

const rebindUserTestingScenarioInput = userTestingScenarioSelectorInput.extend({
  environmentId: z
    .string()
    .trim()
    .min(1)
    .describe("The environment to point at."),
});

export type RebindUserTestingScenarioInput = z.infer<
  typeof rebindUserTestingScenarioInput
>;
export type RebindUserTestingScenarioResult = UpsertUserTestingMemberResult;

export const rebindUserTestingScenarioOperation: PlatformOperation<
  RebindUserTestingScenarioInput,
  RebindUserTestingScenarioResult
> = {
  name: "rebind_user_testing_scenario",
  title: "Point a user-testing scenario at a different environment",
  description:
    "Swap the environment behind a scenario, KEEPING its share link, its members and its session history. The alternative — unpublish and republish — mints a new link, which means re-sharing it with everyone. Changes what visitors are talking to; project admin.",
  readOnly: false,
  risk: "exposure",
  inputSchema: rebindUserTestingScenarioInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const result = await client.rebindUserTestingScenario(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        environmentId: input.environmentId,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), result };
  },
};

const connectProjectServerInput = z.object({
  // Validated HERE rather than left to the API. This is the field a model or a
  // CLI flag fills in, and rejecting `not-a-url` or `file:///etc/passwd` at the
  // keyboard is both a better error and one fewer caller-supplied string that
  // reaches an egress guard to be refused. The guard still runs — this is the
  // outer of two checks, never a replacement for it.
  url: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => {
        try {
          const parsed = new URL(value);
          return parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "Must be an http:// or https:// URL." },
    )
    .describe("The MCP server URL to connect (http or https)."),
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Project name or id. Omit to let the person choose in the browser — this never defaults to a project on their behalf.",
    ),
  serverId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Disambiguates when the project already has several saved servers on this URL. Supply one of the ids from an AMBIGUOUS_SERVER error.",
    ),
  name: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Name for the server if a new one is created. Ignored when an existing server is reused.",
    ),
  reauthorize: z
    .boolean()
    .optional()
    .describe("Force a fresh authorization instead of reusing one in flight."),
});

export type ConnectProjectServerInput = z.infer<
  typeof connectProjectServerInput
>;

const getProjectServerConnectionStatusInput = z.object({
  connectionRequestId: z
    .string()
    .trim()
    .min(1)
    .describe("The connection request id returned by connect_project_server."),
});

export type GetProjectServerConnectionStatusInput = z.infer<
  typeof getProjectServerConnectionStatusInput
>;

/**
 * Connect an MCP server URL to a project — the handoff-first flow.
 *
 * WHAT MAKES THIS OPERATION UNUSUAL: it usually cannot finish on its own. A
 * server that needs OAuth needs a human at a browser, and a request with no
 * project needs someone to choose one. So the honest result of a successful
 * call is often `awaiting_authorization` plus a link, not a connected server.
 * Callers are expected to present the link and then poll
 * `get_project_server_connection_status`.
 *
 * `handoffUrl` IS A PRIVATE CAPABILITY. Anyone holding it can complete the
 * authorization, so a surface must deliver it to the requester alone —
 * ephemerally in Slack, behind an owner-checked button in Discord — and never
 * let a model repeat it in prose. The agent adapter strips it from
 * model-visible text for exactly this reason.
 */
export const connectProjectServerOperation: PlatformOperation<
  ConnectProjectServerInput,
  PlatformServerConnection
> = {
  name: "connect_project_server",
  title: "Connect an MCP server to a project",
  description:
    "Connect an MCP server URL to an MCPJam project. Discovers whether the server needs OAuth, saves it to the project, and returns a connection request. When the next step belongs to a person — choosing a project, or granting consent — the result carries a private authorization link for the requester to open; present it privately and never repeat the URL in a shared channel. Poll get_project_server_connection_status until the status is ready or failed.",
  readOnly: false,
  inputSchema: connectProjectServerInput,
  async execute(input, { client, signal }) {
    // Resolve a NAMED project to an id, but only when one was supplied.
    // `resolveProject`'s no-selector arm falls back to the most recently
    // updated project, and silently adopting that here would connect a server
    // to whichever project the caller happened to touch last. Absent means
    // absent: the request becomes `awaiting_project` and a human chooses.
    let projectId: string | undefined;
    if (input.project) {
      const { project } = await resolveProjectOrThrow(
        client,
        input.project,
        signal,
      );
      projectId = project.id;
    }

    return await client.createServerConnection(
      {
        body: {
          url: input.url,
          projectId,
          serverId: input.serverId,
          name: input.name,
          reauthorize: input.reauthorize,
        },
      },
      { signal },
    );
  },
};

/**
 * Poll one connection request.
 *
 * Read-only and cheap by design — the status path carries no rate-limit
 * bucket, so a caller never has to choose between polling responsively and
 * tripping a budget.
 */
export const getProjectServerConnectionStatusOperation: PlatformOperation<
  GetProjectServerConnectionStatusInput,
  PlatformServerConnection
> = {
  name: "get_project_server_connection_status",
  title: "Check a server connection",
  description:
    "Check the status of a server connection request started by connect_project_server. Returns the current status, the saved server once one exists, and an error with a retryable flag if it failed.",
  readOnly: true,
  inputSchema: getProjectServerConnectionStatusInput,
  async execute(input, { client, signal }) {
    return await client.getServerConnection(
      { connectionRequestId: input.connectionRequestId },
      { signal },
    );
  },
};

const shareResourceSelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  resourceType: z
    .enum(["scenario", "conformanceRun", "evalRun"])
    .describe("Shared resource kind."),
  resourceId: z
    .string()
    .trim()
    .min(1)
    .describe("Id of the scenario, conformance run, or eval run."),
});

export type GetShareSettingsInput = z.infer<typeof shareResourceSelectorInput>;
export type GetShareSettingsResult = {
  project: SelectedProjectInfo;
  settings: Record<string, unknown>;
};

export const getShareSettingsOperation: PlatformOperation<
  GetShareSettingsInput,
  GetShareSettingsResult
> = {
  name: "get_share_settings",
  title: "Get unified share settings",
  description:
    "Read the share envelope for a scenario, conformance run, or eval run: mode, policyVersion, link token, and invited members.",
  readOnly: true,
  inputSchema: shareResourceSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const settings = await client.getShareSettings(
      {
        projectId: project.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), settings };
  },
};

const setShareModeInput = shareResourceSelectorInput.extend({
  mode: z.enum(["project_members", "invited_only", "anyone_with_link"]),
  allowGuestAccess: z.boolean().optional(),
});

export type SetShareModeInput = z.infer<typeof setShareModeInput>;
export type SetShareModeResult = {
  project: SelectedProjectInfo;
  settings: Record<string, unknown>;
};

export const setShareModeOperation: PlatformOperation<
  SetShareModeInput,
  SetShareModeResult
> = {
  name: "set_share_mode",
  title: "Set who can open a shared resource",
  description:
    "Change the share mode for a scenario, conformance run, or eval run. anyone_with_link means anyone holding the URL, including guests (browser sessions, not verified individuals). invited_only restricts to named emails. project_members is private to the project.",
  readOnly: false,
  risk: "exposure",
  inputSchema: setShareModeInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const settings = await client.setShareMode(
      {
        projectId: project.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        mode: input.mode,
        allowGuestAccess: input.allowGuestAccess,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), settings };
  },
};

export type RotateShareLinkInput = z.infer<typeof shareResourceSelectorInput>;
export type RotateShareLinkResult = {
  project: SelectedProjectInfo;
  settings: Record<string, unknown>;
};

export const rotateShareLinkOperation: PlatformOperation<
  RotateShareLinkInput,
  RotateShareLinkResult
> = {
  name: "rotate_share_link",
  title: "Rotate a share link",
  description:
    "Mint a new share URL and invalidate the old one. IMMEDIATE: everyone holding the old URL loses the ability to redeem it. Invited people keep their access. Use this when a link has leaked, not as routine hygiene.",
  readOnly: false,
  risk: "destructive",
  inputSchema: shareResourceSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const settings = await client.rotateShareLink(
      {
        projectId: project.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), settings };
  },
};

const CONNECTION_STATUS_OP = "get_project_server_connection_status" as const;

const INSTALL_NOT_CONNECT_DESCRIPTION =
  "Install writes a project `servers` row and provenance and stops — it is NOT a live connection. Follow with get_project_server_connection_status. A first-time OAuth install returns a browser connect-link in nextSteps.connectLinkUrl (or nextSteps.connectLinkError when minting it failed); a reconnected install returns no link — check the connection status and use connect_project_server if it is not connected.";

async function nextStepsForInstall(
  client: PlatformApiClient,
  projectId: string,
  serverId: string,
  outcome: PlatformRegistryInstallResult["outcome"],
  signal: AbortSignal | undefined,
): Promise<PlatformRegistryInstallResult["nextSteps"]> {
  const nextSteps: PlatformRegistryInstallResult["nextSteps"] = {
    connectionStatusOp: CONNECTION_STATUS_OP,
  };
  // A reconnect means the server row — and possibly a completed OAuth grant —
  // already existed. Minting a handoff link here would create a real pending
  // connection request with a single-use token on every repeat install, and
  // orphan it whenever the existing grant still works. The status op says
  // whether it does; connect_project_server mints a link deliberately if not.
  if (outcome === "reconnected") return nextSteps;
  try {
    const server = await client.getProjectServer(
      { projectId, serverId },
      { signal },
    );
    if (!server.useOAuth || !server.url) return nextSteps;
    const connection = await client.createServerConnection(
      { body: { url: server.url, projectId, serverId } },
      { signal },
    );
    if (connection.handoffUrl) {
      nextSteps.connectLinkUrl = connection.handoffUrl;
    }
  } catch (error) {
    // Caller-initiated cancellation fails the whole operation; a success
    // report after the caller cancelled would be a lie.
    if (signal?.aborted) {
      throw error;
    }
    // The install itself succeeded, so a link-minting failure stays
    // non-fatal — but VISIBLY so, or the caller waits for a link that is
    // not coming instead of starting connect_project_server themselves.
    nextSteps.connectLinkError =
      error instanceof Error && error.message.trim()
        ? error.message
        : "The browser connect-link could not be created.";
  }
  return nextSteps;
}

export const searchRegistryDirectoryOperation: PlatformOperation<
  {
    q?: string;
    source?: string;
    rowType?: string;
    endpointKind?: string;
    verifiedTier?: string;
    connectableOnly?: boolean;
    cursor?: string;
    limit?: number;
  },
  PlatformPage<PlatformCatalogServer>
> = {
  name: "search_registry_directory",
  title: "Search the MCP directory",
  description:
    "Search scraped MCP directories (Claude, ChatGPT, and any future source). `source` is a free string; omit it or pass `all` to search every source. Discover source ids with list_registry_directory_sources — do not hardcode source names. Prefer a matching organization card from list_registry_servers when one exists: those carry config someone in the org already set up.",
  readOnly: true,
  inputSchema: z.object({
    q: z.string().trim().min(1).optional().describe("Search query."),
    source: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Directory source id, or `all` (default). Not an enum."),
    rowType: z.string().trim().min(1).optional(),
    endpointKind: z.string().trim().min(1).optional(),
    verifiedTier: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Verification-tier filter; tier values are data, not an enum."),
    connectableOnly: z.boolean().optional(),
    cursor: z.string().trim().min(1).optional(),
    limit: z.number().int().positive().optional(),
  }),
  async execute(input, { client, signal }) {
    return client.searchRegistryDirectory(
      { ...input, source: input.source ?? "all" },
      { signal },
    );
  },
};

const getRegistryDirectoryServerInput = z
  .object({
    catalogServerId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    source: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!!value.catalogServerId === !!value.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of catalogServerId or name.",
      });
    }
    // Refused rather than ignored: silently dropping `source` would answer a
    // question the caller did not ask (an id already names its source).
    if (value.catalogServerId && value.source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "source only applies to name lookups; a catalogServerId already names its source.",
      });
    }
  });

export const getRegistryDirectoryServerOperation: PlatformOperation<
  z.infer<typeof getRegistryDirectoryServerInput>,
  PlatformCatalogServer
> = {
  name: "get_registry_directory_server",
  title: "Get a directory server",
  description:
    "Fetch one scraped directory row by catalogServerId, or by name (optionally with source). The latestContentHash is the freshness pin for install_registry_directory_server.",
  readOnly: true,
  inputSchema: getRegistryDirectoryServerInput,
  async execute(input, { client, signal }) {
    if (input.catalogServerId) {
      return client.getRegistryDirectoryServer(
        { catalogServerId: input.catalogServerId },
        { signal },
      );
    }
    return client.getRegistryDirectoryServer(
      { name: input.name!, source: input.source },
      { signal },
    );
  },
};

export const listRegistryDirectorySourcesOperation: PlatformOperation<
  Record<string, never>,
  PlatformPage<PlatformCatalogSourceStatus>
> = {
  name: "list_registry_directory_sources",
  title: "List directory sources",
  description:
    "Discover directory source ids for search_registry_directory. Sources are data, not an enum.",
  readOnly: true,
  inputSchema: z.object({}),
  async execute(_input, { client, signal }) {
    return client.listRegistryDirectorySources({ signal });
  },
};

export const listRegistryServersOperation: PlatformOperation<
  { project?: string; scope?: "global" | "organization" | "all" },
  { project: SelectedProjectInfo; items: PlatformRegistryServer[] }
> = {
  name: "list_registry_servers",
  title: "List registry cards",
  description:
    "List the project's organization registry cards (and any global cards; the global shelf is currently empty). Prefer an organization card over a scraped directory row when both match — cards carry config someone in the org already set up.",
  readOnly: true,
  inputSchema: z.object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    scope: z.enum(["global", "organization", "all"]).optional(),
  }),
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listRegistryServers(
      { projectId: project.id, scope: input.scope ?? "all" },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), items: page.items };
  },
};

export const listRegistryConnectionsOperation: PlatformOperation<
  { project?: string },
  { project: SelectedProjectInfo; items: PlatformRegistryConnection[] }
> = {
  name: "list_registry_connections",
  title: "List registry installs",
  description:
    "List directory and card installs already in a project (provenance rows whose server still exists).",
  readOnly: true,
  inputSchema: projectScopedInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const page = await client.listRegistryConnections(
      { projectId: project.id },
      { signal },
    );
    return { project: toSelectedProjectInfo(project), items: page.items };
  },
};

export const installRegistryDirectoryServerOperation: PlatformOperation<
  {
    project?: string;
    catalogServerId: string;
    endpointUrl?: string;
    expectedContentHash?: string;
  },
  PlatformRegistryInstallResult
> = {
  name: "install_registry_directory_server",
  title: "Install a directory server",
  description: INSTALL_NOT_CONNECT_DESCRIPTION,
  readOnly: false,
  risk: "exposure",
  inputSchema: z.object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    catalogServerId: z.string().trim().min(1),
    endpointUrl: z.string().trim().min(1).optional(),
    expectedContentHash: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Freshness pin from get_registry_directory_server."),
  }),
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const installed = await client.installRegistryDirectoryServer(
      {
        projectId: project.id,
        catalogServerId: input.catalogServerId,
        endpointUrl: input.endpointUrl,
        expectedContentHash: input.expectedContentHash,
      },
      { signal },
    );
    return {
      ...installed,
      nextSteps: await nextStepsForInstall(
        client,
        project.id,
        installed.serverId,
        installed.outcome,
        signal,
      ),
    };
  },
};

export const installRegistryServerOperation: PlatformOperation<
  { project?: string; registryServerId: string; expectedUpdatedAt?: number },
  PlatformRegistryInstallResult
> = {
  name: "install_registry_server",
  title: "Install a registry card",
  description: INSTALL_NOT_CONNECT_DESCRIPTION,
  readOnly: false,
  risk: "exposure",
  inputSchema: z.object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    registryServerId: z.string().trim().min(1),
    expectedUpdatedAt: z
      .number()
      .finite()
      .optional()
      .describe("Freshness pin from list_registry_servers.updatedAt."),
  }),
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    const installed = await client.installRegistryServer(
      {
        projectId: project.id,
        registryServerId: input.registryServerId,
        expectedUpdatedAt: input.expectedUpdatedAt,
      },
      { signal },
    );
    return {
      ...installed,
      nextSteps: await nextStepsForInstall(
        client,
        project.id,
        installed.serverId,
        installed.outcome,
        signal,
      ),
    };
  },
};

export const uninstallRegistryServerOperation: PlatformOperation<
  { project?: string; registryServerId: string },
  { deleted?: boolean }
> = {
  name: "uninstall_registry_server",
  title: "Uninstall a registry card",
  description:
    "Remove a curated/org registry card install from a project. Directory uninstall is delete_project_server — there is no separate catalog-uninstall route.",
  readOnly: false,
  risk: "destructive",
  inputSchema: z.object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    registryServerId: z.string().trim().min(1),
  }),
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal,
    );
    return client.uninstallRegistryServer(
      { projectId: project.id, registryServerId: input.registryServerId },
      { signal },
    );
  },
};

export const ALL_OPERATIONS: readonly AnyPlatformOperation[] = [
  getMeOperation,
  listModelsOperation,
  listOrganizationsOperation,
  listProjectsOperation,
  createProjectOperation,
  updateProjectOperation,
  deleteProjectOperation,
  listProjectServersOperation,
  showServersOperation,
  connectProjectServerOperation,
  getProjectServerConnectionStatusOperation,
  diagnoseServerOperation,
  validateServerOperation,
  exportServerOperation,
  listServerToolsOperation,
  listServerPromptsOperation,
  listServerResourcesOperation,
  callServerToolOperation,
  getServerPromptOperation,
  readServerResourceOperation,
  checkHostCompatibilityOperation,
  startClaudeReadinessRunOperation,
  startOpenAIReadinessRunOperation,
  getReadinessRunOperation,
  listReadinessRunsOperation,
  cancelReadinessRunOperation,
  getReadinessReportOperation,
  startConformanceRunOperation,
  getConformanceRunOperation,
  listConformanceRunsOperation,
  getConformanceReportOperation,
  listEvalSuitesOperation,
  listEvalSuiteRunsOperation,
  runEvalSuiteOperation,
  runEvalCaseOperation,
  createEvalSuiteOperation,
  getEvalSuiteOperation,
  updateEvalSuiteOperation,
  deleteEvalSuiteOperation,
  setEvalSuiteScheduleOperation,
  setEvalSuiteEnvironmentsOperation,
  listEvalCasesOperation,
  getEvalCaseOperation,
  createEvalCaseOperation,
  createEvalCasesOperation,
  updateEvalCaseOperation,
  deleteEvalCaseOperation,
  generateEvalCasesOperation,
  getEvalRunOperation,
  compareEvalRunOperation,
  listEvalRunIterationsOperation,
  getEvalIterationTraceOperation,
  cancelEvalRunOperation,
  requestEvalRunJudgeOperation,
  listEvalCheckReposOperation,
  connectEvalCheckRepoOperation,
  getEvalRunStepsOperation,
  createTunnelOperation,
  closeTunnelOperation,
  listScenariosOperation,
  getScenarioOperation,
  listChatSessionsOperation,
  searchSessionsOperation,
  listJourneysOperation,
  listJourneyRunsOperation,
  getJourneyRunOperation,
  listJourneyRunSessionsOperation,
  launchJourneyRunOperation,
  cancelJourneyRunOperation,
  publishScenarioOperation,
  unpublishScenarioOperation,
  listHostsOperation,
  getHostOperation,
  createHostOperation,
  updateHostOperation,
  deleteHostOperation,
  setHostServersOperation,
  duplicateHostOperation,
  listEnvironmentsOperation,
  getEnvironmentCapabilitiesOperation,
  getEnvironmentOperation,
  resolveEnvironmentOperation,
  createEnvironmentOperation,
  ensureAdhocEnvironmentOperation,
  nameEnvironmentOperation,
  updateEnvironmentOperation,
  archiveEnvironmentOperation,
  restoreEnvironmentOperation,
  listProjectPluginsOperation,
  getPluginVersionOperation,
  listImagesOperation,
  getImageOperation,
  createImageOperation,
  updateImageOperation,
  validateImageBlueprintOperation,
  buildImageOperation,
  listImageBuildsOperation,
  promoteImageOperation,
  useImageOperation,
  resetComputerOperation,
  deleteImageOperation,
  createProjectServerOperation,
  getProjectServerOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  // Swarms authoring + insights, and the capability read that lets an agent
  // check before it plans.
  getCapabilitiesOperation,
  listPersonasOperation,
  getPersonaOperation,
  createPersonaOperation,
  updatePersonaOperation,
  deletePersonaOperation,
  generatePersonasOperation,
  getJourneyOperation,
  createJourneyOperation,
  updateJourneyOperation,
  archiveJourneyOperation,
  generateJourneysOperation,
  listSwarmsOperation,
  getSwarmOperation,
  createSwarmOperation,
  updateSwarmOperation,
  archiveSwarmOperation,
  getSwarmOverviewOperation,
  getJourneyRunScorecardOperation,
  listSwarmFindingsOperation,
  dismissSwarmFindingOperation,
  undismissSwarmFindingOperation,
  getWaveInsightsOperation,
  requestWaveInsightsOperation,
  cancelWaveInsightsOperation,
  // User testing — what a published scenario produced, and who may reach it.
  getUserTestingScenarioOperation,
  updateUserTestingScenarioOperation,
  listUserTestingSessionsOperation,
  getUserTestingSessionOperation,
  getUserTestingMetricsOperation,
  getUserTestingUsageOperation,
  listUserTestingFindingsOperation,
  getUserTestingSignalsOperation,
  getUserTestingInsightsOperation,
  requestUserTestingInsightsOperation,
  cancelUserTestingInsightsOperation,
  dismissUserTestingFindingOperation,
  undismissUserTestingFindingOperation,
  setUserTestingGuestExecutionOperation,
  rotateUserTestingLinkOperation,
  upsertUserTestingMemberOperation,
  removeUserTestingMemberOperation,
  rebindUserTestingScenarioOperation,
  getShareSettingsOperation,
  setShareModeOperation,
  rotateShareLinkOperation,
  searchRegistryDirectoryOperation,
  getRegistryDirectoryServerOperation,
  listRegistryDirectorySourcesOperation,
  listRegistryServersOperation,
  listRegistryConnectionsOperation,
  installRegistryDirectoryServerOperation,
  installRegistryServerOperation,
  uninstallRegistryServerOperation,
];
