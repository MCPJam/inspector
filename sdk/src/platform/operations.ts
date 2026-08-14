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
  PlatformSwarm,
  PlatformSwarmArchived,
  PlatformSwarmFinding,
  PlatformSwarmOverview,
  PlatformWaveInsights,
  PlatformWaveInsightsCanceled,
  PlatformUserTestingInsightsRequested,
  PlatformUserTestingScenario,
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
      { signal }
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
      "Organization to create the project in, from list_organizations. Defaults to the caller's own organization."
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
    { message: "Provide at least one project field to update." }
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
      signal
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
      signal
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
      signal
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    return client.validateServer(
      { projectId: project.id, serverId: server.id },
      { signal }
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
      signal
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    return client.exportServer(
      { projectId: project.id, serverId: server.id },
      { signal }
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
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
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
      "Pass either environment or servers, not both — a project environment supplies its own closed server set, which servers cannot override."
    );
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
  environment: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(SUITE_ENVIRONMENT_SELECTOR_DESCRIPTION),
});

export type RunEvalSuiteInput = z.infer<typeof runEvalSuiteInput>;

export type RunEvalSuiteResult = {
  project: SelectedProjectInfo;
  suite: { id: string; name: string | null };
  /** The servers the run connects to; names are included when known. */
  servers: Array<{ id: string; name?: string }>;
  /**
   * The environment the run is pinned to. Non-null even when `environment` was
   * omitted, if the suite has exactly one attached — the platform selects it.
   */
  environment: PlatformEvalRunCreated["environment"];
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
    "Start an asynchronous rerun of an existing eval suite. By default the run connects the suite's saved server selection, resolved by the platform; pass servers only to override it. For a suite with attached project environments, pass environment to choose which one runs (required when several are attached; a lone one is used automatically) — attach them first with set_eval_suite_environments. Returns a runId immediately; poll get_eval_run with the returned project and runId until status is completed, failed, or cancelled. Eval runs execute LLM iterations and consume the organization's credits or configured provider keys.",
  readOnly: false,
  inputSchema: runEvalSuiteInput,
  async execute(input, { client, signal }) {
    assertNoServerOverrideWithEnvironment(input);
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
    // Name-or-ID → id. Whether the environment is ATTACHED to the suite is the
    // platform's call, not ours: only it can decide that without racing a
    // concurrent attachment edit.
    const environment = input.environment
      ? await resolveEnvironmentSelector(
          client,
          project,
          input.environment,
          signal
        )
      : undefined;
    const created = await client.createEvalRun(
      {
        projectId: project.id,
        body: {
          suiteId: suite.id,
          ...(overrideServers
            ? { serverIds: overrideServers.map((server) => server.id) }
            : {}),
          ...(environment ? { environmentId: environment.id } : {}),
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
      environment: created.environment ?? null,
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
  environment: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(SUITE_ENVIRONMENT_SELECTOR_DESCRIPTION),
});

export type RunEvalCaseInput = z.infer<typeof runEvalCaseInput>;

export type RunEvalCaseResult = {
  project: SelectedProjectInfo;
  suite: { id: string; name: string | null };
  case: { id: string; title: string | null };
  servers: Array<{ id: string; name?: string }>;
  /** The environment the run is pinned to; see `RunEvalSuiteResult`. */
  environment: PlatformEvalRunCreated["environment"];
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
    "Start an asynchronous run of ONE case in an existing eval suite — a persisted, fully-queryable run scoped to just that case (inspect it with get_eval_run / list_eval_run_iterations / get_eval_run_steps, same as a full run). For a suite with attached project environments, pass environment to choose which one runs. Returns a runId immediately; poll get_eval_run until terminal. Consumes credits like any eval run.",
  readOnly: false,
  inputSchema: runEvalCaseInput,
  async execute(input, { client, signal }) {
    assertNoServerOverrideWithEnvironment(input);
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
    const environment = input.environment
      ? await resolveEnvironmentSelector(
          client,
          project,
          input.environment,
          signal
        )
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
          ...(environment ? { environmentId: environment.id } : {}),
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
      environment: created.environment ?? null,
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
  environment: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Project environment name or ID the scheduled runs launch. A schedule fires exactly one run, so an environment-based suite pins exactly one of its attached environments — required when several are attached, defaulted when one is. Only valid with enabled: true."
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
        "environment only applies when enabling a schedule — disabling preserves the existing pin. Re-send with enabled: true to repoint it."
      );
    }
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const environment = input.environment
      ? await resolveEnvironmentSelector(
          client,
          project,
          input.environment,
          signal
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
      { signal }
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
      "Project environment names or IDs to attach, in the order they should appear. Replaces the current attachments outright (this is a set, not an append). Pass null to detach every environment and revert the suite to its saved server selection. An empty array is rejected — use null."
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
      signal
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
        { signal }
      );
      const resolved = input.environments.map((selector) =>
        resolveByIdOrName(
          page.items,
          selector,
          "Project environment",
          `project "${project.name}"`
        )
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
            `"${previous}" and "${selector}" both refer to the environment "${environment.name}" (id: ${environment.id}). List each environment once.`
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
    "AI-generate test cases from the suite's server tools and persist them into the suite. Connects the servers to discover tools and spends the organization's credits. For a suite with attached project environments, tools are discovered from the environment's closed server set — pass environment to choose which one. The authoring model is platform-controlled; set caseModels to choose the generated cases' execution models.",
  readOnly: false,
  inputSchema: generateEvalCasesInput,
  async execute(input, { client, signal }) {
    assertNoServerOverrideWithEnvironment(input);
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
    const environment = input.environment
      ? await resolveEnvironmentSelector(
          client,
          project,
          input.environment,
          signal
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
      .string()
      .trim()
      .min(1)
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
      .optional()
      .describe(
        "Full host config v2 to use verbatim (alternative to template). Must pin a non-empty `modelId`."
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
      signal
    );
    const host = await resolveHost(client, project, input.host, signal);
    await client.setHostServers(
      {
        projectId: project.id,
        hostId: host.id,
        serverIds: input.serverIds,
        optionalServerIds: input.optionalServerIds,
      },
      { signal }
    );
    return client.getHost(
      { projectId: project.id, hostId: host.id },
      { signal }
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
      signal
    );
    const host = await resolveHost(client, project, input.host, signal);
    return client.duplicateHost(
      { projectId: project.id, hostId: host.id, name: input.name },
      { signal }
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
  prefer: "live" | "archived" = "live"
): Promise<PlatformEnvironment> {
  const page = await client.listEnvironments(
    { projectId: project.id, includeArchived: true },
    { signal }
  );
  const trimmedSelector = selector.trim();
  const idMatch = page.items.find((item) => item.id === trimmedSelector);
  if (idMatch) {
    return idMatch;
  }
  const preferred = page.items.filter(
    (item) => item.archived === (prefer === "archived")
  );
  const normalizedSelector = trimmedSelector.toLocaleLowerCase();
  const preferredHasName = preferred.some(
    (item) => item.name?.toLocaleLowerCase() === normalizedSelector
  );
  return resolveByIdOrName(
    preferredHasName ? preferred : page.items,
    selector,
    "Project environment",
    `project "${project.name}"`
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
      "Include archived environments. Off by default; turn it on to find an environment to restore."
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
      signal
    );
    const page = await client.listEnvironments(
      {
        projectId: project.id,
        ...(input.includeArchived !== undefined
          ? { includeArchived: input.includeArchived }
          : {}),
      },
      { signal }
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
      signal
    );
    return {
      project: toSelectedProjectInfo(project),
      capabilities: await client.getEnvironmentCapabilities(
        { projectId: project.id },
        { signal }
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
      signal
    );
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      input.environment,
      signal
    );
    return client.getEnvironment(
      { projectId: project.id, environmentId: environment.id },
      { signal }
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
      signal
    );
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      input.environment,
      signal
    );
    return client.resolveEnvironment(
      { projectId: project.id, environmentId: environment.id },
      { signal }
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
        "Project-shared skill IDs to pin. Skills with supporting files or extra frontmatter, and plugin-component skills, cannot be pinned."
      ),
  })
  .describe(
    "Explicit pinned skill selection. Cannot be empty — omit the field entirely, or pass null when updating, to mean 'no pinned skills'."
  );

const pluginVersionIdsInput = z
  .array(z.string().trim().min(1))
  .min(1)
  .describe(
    "Plugin VERSION IDs to pin. Narrow by design: the plugin must be installed and enabled, the version must be ready, at most one version per plugin, and none of its skills may carry supporting files."
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
      "Display name for the new environment. Must be unique among the project's live (non-archived) environments."
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
      "Optional standalone server group to pin. Omit to fall back to the host config's own servers."
    ),
  modelId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Model this environment runs, overriding the model pinned on its host. Omit to inherit the host\'s. The id is stored verbatim — no alias canonicalization — so pass exactly the id you want the provider request to carry (e.g. "anthropic/claude-sonnet-4-5").'
    ),
  skillSelection: skillSelectionInput.optional(),
  pluginVersionIds: pluginVersionIdsInput.optional(),
  sandboxImageId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional sandbox image (see the images operations) to pin: eval runs in this environment boot a fresh sandbox from it. Must be project-shared; personal drafts are rejected — promote first."
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
      signal
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
        "New standalone server group, or null to clear the pin and fall back to the host config's servers. Omit to leave unchanged."
      ),
    modelId: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "New model override, or null to CLEAR it and fall back to the host's model. Omit to leave unchanged. An empty string is rejected — it is not a way to clear."
      ),
    skillSelection: skillSelectionInput
      .nullable()
      .optional()
      .describe(
        "New pinned skill selection, or null to clear it. Omit to leave unchanged."
      ),
    pluginVersionIds: pluginVersionIdsInput
      .nullable()
      .optional()
      .describe(
        "New pinned plugin versions, or null to clear them. Omit to leave unchanged."
      ),
    sandboxImageId: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "New sandbox-image pin (project-shared image id), or null to clear it and use the default image. Omit to leave unchanged."
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
    }
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
      signal
    );
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      input.environment,
      signal
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
      { signal }
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
      signal
    );
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      input.environment,
      signal
    );
    return client.archiveEnvironment(
      {
        projectId: project.id,
        environmentId: environment.id,
        expectedRevision: input.expectedRevision,
      },
      { signal }
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
      signal
    );
    // Restore is the one operation whose target is archived by definition, so
    // a name shared with a live environment must resolve to the archived one.
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      input.environment,
      signal,
      "archived"
    );
    return client.restoreEnvironment(
      {
        projectId: project.id,
        environmentId: environment.id,
        expectedRevision: input.expectedRevision,
      },
      { signal }
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
      signal
    );
    const page = await client.listProjectPlugins(
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

const getPluginVersionInput = z.object({
  pluginVersionId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Plugin version ID — a plugin's `activeVersionId` from list_project_plugins, or a pinned id from an environment's `pluginVersionIds`."
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
      { signal }
    );
  },
};

// ── Sandbox images ───────────────────────────────────────────────────────────

const IMAGE_SELECTOR_DESCRIPTION = "Sandbox image name or ID.";

async function resolveImage(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined
): Promise<PlatformImage> {
  const page = await client.listImages({ projectId: project.id }, { signal });
  return resolveByIdOrName(
    page.items,
    selector,
    "Sandbox image",
    `project "${project.name}"`
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
      signal
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
      signal
    );
    const image = await resolveImage(client, project, input.image, signal);
    return client.getImage(
      { projectId: project.id, imageId: image.id },
      { signal }
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
      "Blueprint YAML (base / initialize / maintenance / knowledge). `base` must be an allowlisted official image pinned by @sha256 digest."
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
      signal
    );
    return client.createImage(
      {
        projectId: project.id,
        body: { name: input.name, blueprint: input.blueprint },
      },
      { signal }
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
    }
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
      signal
    );
    const image = await resolveImage(client, project, input.image, signal);
    const body: { name?: string; blueprint?: string } = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.blueprint !== undefined) body.blueprint = input.blueprint;
    return client.updateImage(
      { projectId: project.id, imageId: image.id, body },
      { signal }
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
      signal
    );
    return client.validateImageBlueprint(
      { projectId: project.id, body: { blueprint: input.blueprint } },
      { signal }
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
      signal
    );
    const image = await resolveImage(client, project, input.image, signal);
    return client.buildImage(
      { projectId: project.id, imageId: image.id },
      { signal }
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
      signal
    );
    const image = await resolveImage(client, project, input.image, signal);
    const page = await client.listImageBuilds(
      { projectId: project.id, imageId: image.id },
      { signal }
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
      signal
    );
    const image = await resolveImage(client, project, input.image, signal);
    return client.promoteImage(
      { projectId: project.id, imageId: image.id },
      { signal }
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
      signal
    );
    const image = await resolveImage(client, project, input.image, signal);
    return client.useImage(
      { projectId: project.id, imageId: image.id },
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
      signal
    );
    const image = await resolveImage(client, project, input.image, signal);
    return client.deleteImage(
      { projectId: project.id, imageId: image.id },
      { signal }
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
      signal
    );
    return client.createProjectServer(
      { projectId: project.id, body: input.body },
      { signal }
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
      signal
    );
    return client.getProjectServer(
      { projectId: project.id, serverId: input.serverId },
      { signal }
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
      signal
    );
    return client.updateProjectServer(
      { projectId: project.id, serverId: input.serverId, body: input.body },
      { signal }
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
      signal
    );
    return client.deleteProjectServer(
      { projectId: project.id, serverId: input.serverId },
      { signal }
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
      signal
    );
    const page = await client.listJourneys(
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
      signal
    );
    const page = await client.listJourneyRuns(
      {
        projectId: project.id,
        journeyId: input.journey,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal }
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
    "One journey run in full: status, per-target rollups, and the per-session attempt records. This is what to poll after launching a run — status leaves 'running' once every attempt has settled.",
  readOnly: true,
  inputSchema: journeyRunSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const run = await client.getJourneyRun(
      { projectId: project.id, runId: input.run },
      { signal }
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
      signal
    );
    const page = await client.listJourneyRunSessions(
      {
        projectId: project.id,
        runId: input.run,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal }
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
      "Retry key. A launch spends model credits, so a retry after a dropped response must not run the journey twice — replaying a key returns the ORIGINAL run with deduped: true. Omit it and every call starts a new run."
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
      "Fan out across these project environments instead of the journey's authored targets."
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
      signal
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
      }
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
      signal
    );
    const run = await client.cancelJourneyRun(
      { projectId: project.id, runId: input.run },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

// ── Scenarios (user testing) ────────────────────────────────────────────────
//
// A scenario is a project environment published for people outside the project
// to talk to. Internally these are `chatboxes` rows and will stay that way;
// "scenario" is the public noun. The older `list_chatboxes` / `get_chatbox`
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
      "Project environment id to publish (or unpublish). One scenario per environment."
    ),
});
export type PublishScenarioInput = z.infer<typeof scenarioSelectorInput>;

export type PublishScenarioResult = {
  project: SelectedProjectInfo;
  scenario: PlatformScenario;
};

export const publishScenarioOperation: PlatformOperation<
  PublishScenarioInput,
  PublishScenarioResult
> = {
  name: "publish_scenario",
  risk: "exposure",
  title: "Publish a project environment as a user-testing scenario",
  description:
    "Publish a project environment so people outside the project can talk to it through a share link. IDEMPOTENT — publishing an already-published environment returns the existing scenario rather than creating a second one; `created` tells you which happened. Requires project admin.",
  readOnly: false,
  inputSchema: scenarioSelectorInput,
  async execute(input, { client, signal }) {
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
    );
    const scenario = await client.publishScenario(
      { projectId: project.id, environmentId: input.environment },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), scenario };
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
      signal
    );
    const result = await client.unpublishScenario(
      { projectId: project.id, environmentId: input.environment },
      { signal }
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
      "Provide exactly one of environmentId or serverAttachmentId to ground the drafts."
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
      "sessionsPerTarget and maxTurns must be sent together — they are one execution config upstream."
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
      signal
    );
    const page = await client.listPersonas(
      { projectId: project.id },
      { signal }
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
      signal
    );
    const persona = await client.getPersona(
      { projectId: project.id, personaId: input.persona },
      { signal }
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
      "How they behave: what they know, what they will not tolerate, how they phrase things. This is what makes a persona produce a realistic session rather than a compliant one."
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Retry key. Pass one: the server replays it BEFORE uniquifying the slug, so a retry without it leaves a second near-identical persona named '…-2' rather than the one you already made."
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
      signal
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
      }
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
      signal
    );
    const persona = await client.updatePersona(
      {
        projectId: project.id,
        personaId: input.persona,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      { signal }
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
      signal
    );
    const persona = await client.deletePersona(
      { projectId: project.id, personaId: input.persona },
      { signal }
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
      signal
    );
    const journey = await client.getJourney(
      { projectId: project.id, journeyId: input.journey },
      { signal }
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
      "What the persona is trying to accomplish. Drives the whole run."
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
      "Sessions per target. TOTAL sessions = targets x this, and the total is what spends."
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
      signal
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
      }
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
      signal
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
      { signal }
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
      signal
    );
    const journey = await client.archiveJourney(
      { projectId: project.id, journeyId: input.journey },
      { signal }
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
      signal
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
      signal
    );
    const swarm = await client.getSwarm(
      { projectId: project.id, swarmId: input.swarm },
      { signal }
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
      signal
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
      }
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
      signal
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
      { signal }
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
      signal
    );
    const swarm = await client.archiveSwarm(
      { projectId: project.id, swarmId: input.swarm },
      { signal }
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
      signal
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
      { signal }
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
      "The persona to draft journeys for, BY VALUE — it does not have to exist yet."
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
      signal
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
      { signal }
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
      signal
    );
    const overview = await client.getSwarmOverview(
      { projectId: project.id },
      { signal }
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
      signal
    );
    const scorecard = await client.getJourneyRunScorecard(
      { projectId: project.id, runId: input.run },
      { signal }
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
      signal
    );
    const page = await client.listSwarmFindings(
      { projectId: project.id },
      { signal }
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
      signal
    );
    const finding = await client.dismissSwarmFinding(
      { projectId: project.id, findingId: input.finding },
      { signal }
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
      signal
    );
    const finding = await client.undismissSwarmFinding(
      { projectId: project.id, findingId: input.finding },
      { signal }
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
      signal
    );
    const insights = await client.getWaveInsights(
      { projectId: project.id, waveId: input.wave },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), insights };
  },
};

const requestWaveInsightsInput = waveSelectorInput.extend({
  force: z
    .boolean()
    .optional()
    .describe(
      "Regenerate over a wave that already has insights. SPENDS AGAIN — the usual reason a wave looks stuck is a caller that did not poll, so read get_wave_insights before reaching for this."
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
      signal
    );
    const request = await client.requestWaveInsights(
      {
        projectId: project.id,
        waveId: input.wave,
        ...(input.force ? { force: true } : {}),
      },
      { signal }
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
      signal
    );
    const canceled = await client.cancelWaveInsights(
      { projectId: project.id, waveId: input.wave },
      { signal }
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
      signal
    );
    const capabilities = await client.getCapabilities(
      { projectId: project.id },
      { signal }
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
    .describe("Scenario id (the `id` from list_chatboxes / publish_scenario)."),
});

const updateUserTestingScenarioInput = userTestingScenarioSelectorInput.extend({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  mode: z
    .enum(["project_members", "invited_only", "anyone_with_link"])
    .optional()
    .describe(
      "Who may open the share link. Send this ON ITS OWN — identity and exposure are separate operations, and a mixed request is rejected."
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
        "Send `mode` on its own: identity and exposure are separate operations upstream."
      );
    }
    const { project } = await resolveProjectOrThrow(
      client,
      input.project,
      signal
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
      { signal }
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
      signal
    );
    const page = await client.listUserTestingSessions(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal }
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
      signal
    );
    const session = await client.getUserTestingSession(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        sessionId: input.session,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal }
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
      signal
    );
    const metrics = await client.getUserTestingMetrics(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        ...(input.population ? { population: input.population } : {}),
      },
      { signal }
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
      signal
    );
    const usage = await client.getUserTestingUsage(
      { projectId: project.id, scenarioId: input.scenario },
      { signal }
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
      signal
    );
    const page = await client.listUserTestingFindings(
      { projectId: project.id, scenarioId: input.scenario },
      { signal }
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
      signal
    );
    const signals = await client.getUserTestingSignals(
      { projectId: project.id, scenarioId: input.scenario },
      { signal }
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
      signal
    );
    const insights = await client.getUserTestingInsights(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        windowId: input.window,
      },
      { signal }
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
        "Regenerate over a window that already has insights. Spends again."
      ),
  }
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
      signal
    );
    const request = await client.requestUserTestingInsights(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        ...(input.force ? { force: true } : {}),
      },
      { signal }
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
      signal
    );
    const canceled = await client.cancelUserTestingInsights(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        windowId: input.window,
      },
      { signal }
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
      signal
    );
    const finding = await client.dismissUserTestingFinding(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        findingId: input.finding,
      },
      { signal }
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
      signal
    );
    const finding = await client.undismissUserTestingFinding(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        findingId: input.finding,
      },
      { signal }
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
      signal
    );
    const { project: _project, scenario, ...guestExecution } = input;
    const result = await client.setUserTestingGuestExecution(
      {
        projectId: project.id,
        scenarioId: scenario,
        guestExecution,
      },
      { signal }
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
      signal
    );
    const result = await client.rotateUserTestingLink(
      { projectId: project.id, scenarioId: input.scenario },
      { signal }
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
      "Off by default — adding someone is not the same as telling them."
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
      signal
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
      { signal }
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
      signal
    );
    const result = await client.removeUserTestingMember(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        member: input.member,
      },
      { signal }
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
      signal
    );
    const result = await client.rebindUserTestingScenario(
      {
        projectId: project.id,
        scenarioId: input.scenario,
        environmentId: input.environmentId,
      },
      { signal }
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
      { message: "Must be an http:// or https:// URL." }
    )
    .describe("The MCP server URL to connect (http or https)."),
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Project name or id. Omit to let the person choose in the browser — this never defaults to a project on their behalf."
    ),
  serverId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Disambiguates when the project already has several saved servers on this URL. Supply one of the ids from an AMBIGUOUS_SERVER error."
    ),
  name: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Name for the server if a new one is created. Ignored when an existing server is reused."
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
        signal
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
      { signal }
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
      { signal }
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
  updateEvalCaseOperation,
  deleteEvalCaseOperation,
  generateEvalCasesOperation,
  getEvalRunOperation,
  listEvalRunIterationsOperation,
  getEvalIterationTraceOperation,
  cancelEvalRunOperation,
  getEvalRunStepsOperation,
  createTunnelOperation,
  closeTunnelOperation,
  listChatboxesOperation,
  getChatboxOperation,
  listChatSessionsOperation,
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
];
