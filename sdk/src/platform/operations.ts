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
  PlatformEvalIteration,
  PlatformEvalRun,
  PlatformEvalRunCreated,
  PlatformEvalSuite,
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
