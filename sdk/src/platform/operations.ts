/**
 * Curated, task-shaped operations over the Platform API. Each operation is
 * defined once and adapted per surface: MCP worker tools, CLI commands, and
 * (later) in-product agent tools. Names follow the built-in tool id
 * convention (`^[a-z][a-z0-9_]{0,63}$`) so they can be registered in the
 * product catalog unchanged.
 */
import { z } from "zod";
import { opaqueIdSchema } from "../contract/identity.js";
import {
  GATE_WAIVER_MAX_REASON_LENGTH,
  GATE_WAIVER_REASON_NOTICE,
} from "../gates.js";
import {
  MAX_BATCH_CREATE_CASES,
  evalSuiteFileCaseImportSchema,
} from "../contract/suite-file.js";
import {
  caseIntentSchema,
  caseIntentUpdateSchema,
} from "../contract/stage-intent.js";
import { readEvalRunDecisionSummary } from "../eval-decision-summary.js";
import type { PlatformApiClient } from "./client.js";
import { PlatformApiError } from "./errors.js";
import {
  derivePermalinks,
  noPermalink,
  responsePermalinks,
  type PlatformPermalinkPolicy,
  type PlatformResourceRef,
} from "./permalinks.js";
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
  PlatformWidgetRender,
  PlatformChatTurn,
  PlatformChatSessionTrace,
  PlatformChatSessionDetail,
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
  PlatformEvalCaseBatchCreated,
  PlatformEvalCaseBatchResult,
  PlatformEvalCaseDeleted,
  PlatformEvalCasesGenerated,
  PlatformEvalIteration,
  PlatformEvalStepResult,
  PlatformEvalRun,
  PlatformEvalRunDecisionSummary,
  PlatformGateWaiver,
  PlatformGateWaiverWriteResult,
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
  PlatformEnvironmentSkillSelection,
  PlatformComputerAttached,
  PlatformComputerReset,
  PlatformEnvironment,
  PlatformEvalRunDisclosure,
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
  PlatformSecret,
  PlatformSecretDeleted,
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
  PlatformClient,
  PlatformClientDeleted,
  PlatformClientDetail,
  PlatformHost,
  PlatformHostDeleted,
  PlatformHostDetail,
  PlatformOrganization,
  PlatformPage,
  PlatformMe,
  PlatformModel,
  PlatformPlugin,
  PlatformProjectSkill,
  PlatformProjectSkillDetail,
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
  /**
   * The project this call actually resolved to, fired exactly once when
   * resolution succeeds.
   *
   * Permalinks need a project id and most callers do not have one. The hosted
   * route does, but an MCP host passes a project NAME or nothing at all and
   * the operation resolves the real project internally — so a permalink built
   * from the adapter's own guess would name a different project than the one
   * the operation read. This receipt is how the adapter learns which project
   * the work happened in, without the operation's RESULT changing shape
   * (`{data, scope}` would break every direct SDK caller).
   *
   * SYNCHRONOUS BY CONTRACT and best-effort, same as `onDisclosure`: it is
   * not awaited, a throwing callback is swallowed rather than failing the
   * operation, and an operation that resolves no project (list_projects,
   * get_me, the registry directory) never fires it.
   */
  onScopeResolved?: (scope: {
    projectId: string;
    organizationId?: string;
  }) => void;
  /**
   * Fired by `runEvalSuiteOperation` with the pre-run disclosure it fetched
   * for the frozen launch plan, ONE resolution before it calls
   * `createEvalRun`/`createEvalRunGroup` — so "what was disclosed" is
   * literally "what will run", not a second, independently-resolved target
   * that could drift from it. A caller that wants to show or log the
   * disclosure passes this rather than resolving targets a second time to
   * fetch it separately.
   *
   * Best-effort: a disclosure fetch failure (a backend that predates the
   * contract, a transient error) never blocks or fails the launch — this
   * callback simply does not fire, and the receipt's `disclosure` field is
   * absent. Never called for `runEvalCaseOperation`, which shares no target
   * resolution with the suite op. See `onDisclosureUnavailable` for the
   * failure counterpart.
   *
   * SYNCHRONOUS BY CONTRACT — the "ONE resolution before the create call"
   * ordering guarantee only holds for code that runs to completion before
   * this function returns. It is not awaited: a caller who ignores the type
   * and hands back an async function anyway gets its rejections swallowed
   * defensively, but only its SYNCHRONOUS prefix is guaranteed to run before
   * `createEvalRun`/`createEvalRunGroup`.
   */
  onDisclosure?: (disclosure: PlatformEvalRunDisclosure) => void;
  /**
   * Fired INSTEAD of `onDisclosure` when the fetch for the frozen launch
   * plan failed — a backend predating the contract, a timeout, a transient
   * error. Still never blocks or fails the launch (the same best-effort
   * guarantee `onDisclosure` carries); this exists so a caller can say
   * something was ATTEMPTED and failed, rather than rendering nothing at
   * all. An absent disclosure with no signal at all is indistinguishable
   * from "this build has no disclosure feature" — the same failure class
   * the backend's `executionAbsence.kind` exists to prevent one layer up.
   *
   * Never fired for a caller-initiated cancellation (the operation's own
   * `signal` aborting) — that is not a disclosure failure to report, it is
   * the whole launch being cancelled, and mislabeling it as "the disclosure
   * fetch timed out" would misdescribe an unrelated abort. Synchronous by
   * contract, same as `onDisclosure`.
   */
  onDisclosureUnavailable?: (reason: string) => void;
}

/**
 * Ceiling on the pre-run disclosure fetch, independent of whatever deadline
 * the caller's own signal carries.
 *
 * Deliberately SHORT, not generous: this fetch is awaited BEFORE
 * `createEvalRun(Group)`, sequentially, sharing the SAME caller-supplied
 * deadline signal (`runPlatformOperation` in the CLI creates one
 * `AbortController` for the whole operation and threads its signal through
 * both calls). A bound anywhere near the caller's own timeout risks the
 * disclosure fetch alone consuming most or all of it — `boundedDisclosureSignal`
 * still forwards a genuine caller abort into this fetch to cut it short, but
 * by the time that forwarded abort lands, the caller's signal is ALREADY
 * aborted, and `createEvalRun` — sharing that same signal — then fails
 * immediately with zero chance to run, turning a best-effort read into a
 * failed launch. A single lightweight GET to our own backend has no business
 * needing more than a few seconds under normal conditions, so this stays
 * short enough to leave the launch call a fair remaining share of any
 * realistic `--timeout` (the CLI default is 30s), while still catching a
 * genuine stall. Not a complete fix for a pathologically small caller
 * timeout (e.g. `--timeout 500`) — that would need the operation to know its
 * OWN remaining budget, which `PlatformOperationContext` does not carry
 * today.
 */
const DISCLOSURE_FETCH_TIMEOUT_MS = 3_000;

/**
 * A signal for the best-effort disclosure fetch that is bounded by ITS OWN
 * short timeout, so a stalled request cannot silently consume the caller's
 * launch deadline — see the `onDisclosure` doc above. Still aborts when the
 * caller signal does (a genuine cancellation should stop this fetch too); it
 * just never runs the other direction, and its own timer never touches the
 * caller's signal.
 */
function boundedDisclosureSignal(callerSignal: AbortSignal | undefined): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (callerSignal?.aborted) {
    // Already aborted before this helper ran — e.g. propagated from an
    // earlier best-effort lookup, or a caller-supplied pre-aborted signal.
    // `addEventListener("abort", ...)` alone would never fire for an event
    // that already happened, leaving the fetch to run for the full timeout.
    // Passing the reason through keeps a caller inspecting the derived
    // signal's `.reason` from seeing a generic AbortError in place of
    // whatever actually caused the caller's own cancellation.
    controller.abort(callerSignal.reason);
    return {
      signal: controller.signal,
      dispose: () => {},
    };
  }
  const timeoutId = setTimeout(
    () => controller.abort(),
    DISCLOSURE_FETCH_TIMEOUT_MS
  );
  const onCallerAbort = () => controller.abort(callerSignal!.reason);
  callerSignal?.addEventListener("abort", onCallerAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Invokes a `PlatformOperationContext` disclosure callback (`onDisclosure` /
 * `onDisclosureUnavailable`) — SYNCHRONOUS by contract, never awaited, so its
 * failure can never delay the launch that follows. This exists only as a
 * runtime safety net for a caller who ignores the sync-only type and hands
 * back an async function anyway (TypeScript permits it structurally): the
 * returned value is wrapped so a later rejection is swallowed rather than
 * surfacing as an unhandled rejection. A synchronous throw is caught the
 * same way. Either way, only the callback's SYNCHRONOUS prefix is guaranteed
 * to have run by the time this returns.
 */
function invokeDisclosureCallback(run: () => void | Promise<void>): void {
  try {
    void Promise.resolve(run()).catch(() => {
      // The callback's own async failure is the caller's concern.
    });
  } catch {
    // The callback's own synchronous failure is likewise the caller's
    // concern.
  }
}

/**
 * A short, human-readable reason a disclosure fetch failed — for
 * `onDisclosureUnavailable`, so a caller can say something was ATTEMPTED and
 * failed rather than rendering nothing at all. Deliberately coarse: this is
 * a best-effort planning aid's failure message, not a diagnostic surface.
 */
function disclosureUnavailableReason(error: unknown): string {
  if (error instanceof PlatformApiError) {
    if (
      error.code === "FEATURE_NOT_SUPPORTED" &&
      (error.details as Record<string, unknown> | undefined)?.reason ===
        "contract_unavailable"
    ) {
      return "this deployment predates the pre-run disclosure contract";
    }
    return error.message;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "the disclosure fetch timed out";
  }
  return "the disclosure fetch failed";
}

export const getMeOperation: PlatformOperation<
  Record<string, never>,
  PlatformMe
> = {
  name: "get_me",
  title: "Get the current MCPJam account",
  description: "Return the account associated with the current API credential.",
  readOnly: true,
  permalink: noPermalink(
    "no-addressable-resource",
    "An account identity read. The account is not a project resource and has no app page of its own."
  ),
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
  permalink: noPermalink(
    "no-addressable-resource",
    "The hosted model catalog is platform configuration, not a resource in anyone's project."
  ),
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
  permalink: derivePermalinks((result) =>
    result.items.map((organization) => ({
      type: "organization" as const,
      id: organization.id,
      label: `Open ${organization.name}`,
    }))
  ),
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
  /**
   * Which durable resources this operation's result can be opened at.
   *
   * REQUIRED, and discriminated: there is no unclassified operation. Before
   * this field every surface re-derived app URLs from result shapes it half
   * knew, three of them assembled the same eval-run URL, and the model filled
   * the remaining gaps by inventing `https://app.mcpjam.com/servers` — a link
   * that opens whatever project the RECIPIENT last selected. Making the field
   * mandatory means a new operation cannot ship having quietly skipped the
   * question; declaring `noPermalink("mutation-only")` is a decision, an
   * omitted optional field was not.
   */
  permalink: PlatformPermalinkPolicy<TInput, TOutput>;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, context: PlatformOperationContext): Promise<TOutput>;
}

const PROJECT_SELECTOR_DESCRIPTION =
  "Project name or ID. Defaults to the most recently updated accessible project.";

/**
 * Up here, not beside the compose resolvers it belongs to, for the same
 * temporal-dead-zone reason `composeRunTargetInput` is declared above the run
 * inputs: both compose schemas read this at module-init time, and the earlier
 * of the two sits thousands of lines above those resolvers.
 */
const SERVERS_SELECTOR_DESCRIPTION =
  "Server(s) (name or ID) the stack must run against. Resolves to a pinned standalone server group holding exactly these servers, so the stack keeps testing them even if the host's own server list is edited later. Mutually exclusive with `serverGroup`.";

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
  permalink: derivePermalinks((result) =>
    // Rows SPAN projects, so each carries its own `projectId` rather than
    // inheriting the operation's resolved scope — there is no single resolved
    // project here, and stamping one would relabel every other row with it.
    result.items.map((project) => ({
      type: "project" as const,
      id: project.id,
      projectId: project.id,
      label: `Open ${project.name}`,
    }))
  ),
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
  permalink: derivePermalinks((result) => [
    { type: "project", id: result.id, projectId: result.id },
  ]),
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
  permalink: derivePermalinks((result) => [
    { type: "project", id: result.id, projectId: result.id },
  ]),
  inputSchema: updateProjectInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: deleteProjectInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) =>
    result.items.map((server) => ({
      type: "project_server" as const,
      id: server.id,
      projectId: result.project?.id,
      label: `Open ${server.name}`,
    }))
  ),
  inputSchema: projectScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) =>
    result.servers.map((server) => ({
      type: "project_server" as const,
      id: server.id,
      projectId: result.project?.id,
      label: `Open ${server.name}`,
    }))
  ),
  inputSchema: projectScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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

/**
 * Resolve the caller's project selector, and REPORT what it resolved to.
 *
 * The report is the reason this is the one shared resolution path: a selector
 * is usually a name, or absent entirely, so the project id exists only here.
 * Firing `onScopeResolved` at the single point where resolution succeeds is
 * what lets an adapter build a permalink for the project the operation
 * actually read, instead of one it guessed — and doing it here rather than at
 * 154 call sites is what stops half of them from forgetting.
 */
async function resolveProjectOrThrow(
  context: Pick<
    PlatformOperationContext,
    "client" | "signal" | "onScopeResolved"
  >,
  selector: string | undefined
): Promise<{ project: PlatformProject; sortedProjects: PlatformProject[] }> {
  const { client, signal, onScopeResolved } = context;
  const page = await client.listProjects({}, { signal });
  const resolution = resolveProject(page.items, selector);
  if (!resolution.ok) {
    throw projectResolutionError(resolution.message);
  }
  reportResolvedScope(onScopeResolved, resolution.project);
  return {
    project: resolution.project,
    sortedProjects: resolution.sortedProjects,
  };
}

/**
 * Deliver the resolved-scope receipt, best-effort.
 *
 * A caller's own synchronous failure is the caller's problem, not a reason to
 * fail an operation that already succeeded — the same contract
 * `notifyDisclosure` keeps one screen up.
 */
function reportResolvedScope(
  onScopeResolved: PlatformOperationContext["onScopeResolved"],
  project: PlatformProject
): void {
  if (!onScopeResolved) return;
  try {
    onScopeResolved({
      projectId: project.id,
      ...(project.organizationId
        ? { organizationId: project.organizationId }
        : {}),
    });
  } catch {
    // Best-effort by contract.
  }
}

/**
 * A case as an OPERATION returns it: the wire projection plus the suite the
 * operation resolved to reach it.
 *
 * NOT on `PlatformEvalCase` itself. That type mirrors the REST `EvalCase`
 * schema field for field (the openapi parity test enforces it), and the route
 * does not send a suite id — the OPERATION knows it because it just resolved
 * the caller's `suite` selector. Stamping it here keeps the wire contract
 * honest while giving the permalink policy the parent it needs: a case's route
 * is `/evals/suite/:suiteId/test/:testId`, and without the suite there is no
 * link to build, only a wrong one.
 */
export type PlatformEvalCaseWithSuite = PlatformEvalCase & { suiteId: string };

/** `create_eval_cases`, with each created row's suite stamped on. */
export type CreateEvalCasesResult = Omit<
  PlatformEvalCaseBatchResult,
  "created"
> & {
  created: Array<PlatformEvalCaseBatchCreated & { suiteId: string }>;
};

/** `generate_eval_cases`, with each generated case's suite stamped on. */
export type GenerateEvalCasesResult = Omit<
  PlatformEvalCasesGenerated,
  "created"
> & { created: PlatformEvalCaseWithSuite[] };

/**
 * Stamp the suite a case-shaped payload belongs to.
 *
 * The REST projections for eval cases predate permalinks and carry no suite
 * id, so `/evals/suite/:suiteId/test/:testId` cannot be composed from a
 * response alone. The operation has just resolved that suite in order to make
 * the call, so it stamps it on the way out — an additive optional field older
 * readers ignore, rather than a second lookup at every link site.
 */
function stampSuiteId<T extends object>(
  payload: T,
  suiteId: string
): T & { suiteId: string } {
  return { ...payload, suiteId };
}

// ── Permalink derivation helpers ─────────────────────────────────────
//
// Small, named, and shared so the 164 policy declarations below stay one
// readable line of intent each. Every one of them returns a REF, never a URL:
// composing the URL is `buildAppPermalink`'s job and happens in exactly one
// place.

/** Spread `projectId` only when the payload actually carries one. */
function projectIdOf(source: { projectId?: string | null }): {
  projectId?: string;
} {
  return source.projectId ? { projectId: source.projectId } : {};
}

/** The saved server a server-scoped operation resolved. */
function serverRef(result: {
  project: SelectedProjectInfo;
  server: { id: string; name: string };
}): PlatformResourceRef {
  return {
    type: "project_server",
    id: result.server.id,
    projectId: result.project?.id,
    label: `Open ${result.server.name}`,
  };
}

/** An eval run, addressed through the suite that owns it. */
function evalRunRef(
  runId: string,
  suiteId: string,
  projectId?: string
): PlatformResourceRef {
  return {
    type: "eval_run",
    id: runId,
    parent: { type: "eval_suite", id: suiteId },
    ...(projectId ? { projectId } : {}),
  };
}

/**
 * An eval case, addressed through its suite.
 *
 * Returns NOTHING when the suite is unknown rather than falling back to the
 * suite list or a bare case id: `/evals/suite/<wrong>/test/<id>` would render
 * a different suite's screen, which is precisely the wrong-resource failure
 * permalinks exist to end. Every catalog path stamps `suiteId` (see
 * `stampSuiteId`), so in practice this is the guard, not the common case.
 */
function evalCaseRef(
  testCase: { id: string; title?: string },
  suiteId: string | undefined
): PlatformResourceRef[] {
  if (!suiteId) return [];
  return [
    {
      type: "eval_case",
      id: testCase.id,
      parent: { type: "eval_suite", id: suiteId },
      ...(testCase.title ? { label: `Open ${testCase.title}` } : {}),
    },
  ];
}

/** One project environment. */
function environmentRef(environment: {
  id: string;
  projectId: string;
  name?: string | null;
}): PlatformResourceRef {
  return {
    type: "project_environment",
    id: environment.id,
    projectId: environment.projectId,
    ...(environment.name ? { label: `Open ${environment.name}` } : {}),
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
  permalink: derivePermalinks((result) => [
    {
      type: "project_server",
      id: result.server.id,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: serverScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "An opaque validation payload: the operation resolves its server from a selector and the response echoes no id to address."
  ),
  inputSchema: serverScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "An opaque export payload: the operation resolves its server from a selector and the response echoes no id to address."
  ),
  inputSchema: serverScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  // No `.min(1)`: `""` is a legitimate MCP cursor (2026-07-28
  // `server/utilities/pagination`), and rejecting it would refuse to page a
  // conforming server.
  cursor: z.string().optional().describe(PAGE_CURSOR_DESCRIPTION),
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
  const { client, signal, onScopeResolved } = context;
  const { project } = await resolveProjectOrThrow(
    { client, signal, onScopeResolved },
    input.project
  );
  const server = await resolveLiveServer(client, project, input.server, signal);
  const page = await list(
    { projectId: project.id, serverId: server.id },
    // Presence, not truthiness, in BOTH directions: this is a passthrough of
    // the MCP server's cursor, and `""` is a valid one.
    input.cursor !== undefined ? { cursor: input.cursor } : {}
  );
  return {
    project: toSelectedProjectInfo(project),
    server: toServerInfo(server),
    items: page.items,
    ...(typeof page.nextCursor === "string"
      ? { nextCursor: page.nextCursor }
      : {}),
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
  permalink: derivePermalinks((result) => [serverRef(result)]),
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
  permalink: derivePermalinks((result) => [serverRef(result)]),
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
  permalink: derivePermalinks((result) => [serverRef(result)]),
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

const renderServerWidgetInput = serverScopedInput.extend({
  toolName: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The MCP App tool to render. It must declare a `ui://` UI resource; a tool that does not is refused rather than run."
    ),
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Tool arguments matching the tool's input schema."),
  includeSnapshot: z
    .boolean()
    .optional()
    .describe(
      "Return the widget as an accessibility tree with addressable elements. DEFAULT TRUE — it is the cheap, readable answer."
    ),
  includeScreenshot: z
    .boolean()
    .optional()
    .describe(
      "Also return a base64 image. DEFAULT FALSE: it is by far the largest field this returns, and a caller that cannot see images pays for it anyway."
    ),
  injectOpenAiCompat: z
    .boolean()
    .optional()
    .describe(
      "Mount with the OpenAI Apps compatibility shims instead of the spec-default MCP-UI bridge."
    ),
  viewport: z
    .object({
      width: z.number().int().min(1).max(8192),
      height: z.number().int().min(1).max(8192),
    })
    .optional(),
});

export type RenderServerWidgetInput = z.infer<typeof renderServerWidgetInput>;

export type RenderServerWidgetResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  render: PlatformWidgetRender;
};

export const renderServerWidgetOperation: PlatformOperation<
  RenderServerWidgetInput,
  RenderServerWidgetResult
> = {
  name: "render_server_widget",
  title: "Render an MCP App widget",
  description:
    "Call an MCP App tool and mount its `ui://` widget in real headless Chromium, then report whether it rendered, what it logged, what it was blocked from fetching, and the widget as an accessibility tree with addressable elements. Returns the tree by default and the screenshot only on request. EXECUTES THE TOOL, so it has whatever side effects that tool has.",
  readOnly: false,
  // Same unknowability as `call_server_tool`, because it IS a tool call — the
  // render is what happens afterwards. Softening the destructive default would
  // claim a safety this cannot verify.
  mayBeDestructive: true,
  // The conservative reading of an unknowable effect. `none` would claim the
  // call is reversible and free, which is exactly what nobody can promise
  // about a third party's tool. The agent surface then treats this as
  // approval-worthy rather than silently callable — see the TIER_EXCEPTIONS
  // entry, which explains why it is gated rather than excluded outright.
  risk: "destructive",
  permalink: derivePermalinks((result) => [serverRef(result)]),
  inputSchema: renderServerWidgetInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    const render = await client.renderServerWidget(
      {
        projectId: project.id,
        serverId: server.id,
        body: {
          toolName: input.toolName,
          ...(input.parameters ? { parameters: input.parameters } : {}),
          ...(input.includeSnapshot !== undefined
            ? { includeSnapshot: input.includeSnapshot }
            : {}),
          ...(input.includeScreenshot !== undefined
            ? { includeScreenshot: input.includeScreenshot }
            : {}),
          ...(input.injectOpenAiCompat !== undefined
            ? { injectOpenAiCompat: input.injectOpenAiCompat }
            : {}),
          ...(input.viewport ? { viewport: input.viewport } : {}),
        },
      },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      // NARROWED, like every other live-server operation in this file.
      // Assigning the raw row would ship a whole `PlatformProjectServer` —
      // including its config — through a field the type says is `{id, name}`,
      // so consumers would see fields the contract does not promise and the
      // published shape would disagree with the declared one.
      server: toServerInfo(server),
      render,
    };
  },
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
  permalink: noPermalink(
    "external-resource",
    "The payload is the third-party tool's own output. Linking to MCPJam's page for the server would answer a question the caller did not ask."
  ),
  inputSchema: callServerToolInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "external-resource",
    "The payload is the third-party server's prompt content."
  ),
  inputSchema: getServerPromptInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "external-resource",
    "The payload is the third-party server's resource content."
  ),
  inputSchema: readServerResourceInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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

// ── Server-served Agent Skills (SEP-2640) ────────────────────────────
//
// Three operations rather than the resource family's two. Resources need
// `list` + `read`; skills need `list` + `get` + `read file`, because
// `skills/get` reaches a skill a partial listing never mentioned — a URI can
// arrive from the server's own `instructions`, from another skill's body, or
// from a user — and that is the reason the SEP has `skills/get` at all.
//
// Every one of these answers with EITHER content or a `refusal` naming the
// integrity check that failed. The refusals are the product: a debugger's user
// asking "why won't this skill load" is asking exactly which digest, which
// field, which URI.

export type ListServerSkillsResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  result: Record<string, unknown>;
};

export const listServerSkillsOperation: PlatformOperation<
  ServerScopedInput,
  ListServerSkillsResult
> = {
  name: "list_server_skills",
  title: "List MCPJam server skills",
  description:
    "List the Agent Skills a saved MCP server serves over the skills extension (SEP-2640). Includes skills the server advertises that MCPJam declines to load, each with the reason. Not paginated: the catalog is drained server-side because duplicate detection spans the whole listing.",
  readOnly: true,
  permalink: derivePermalinks((result) => [serverRef(result)]),
  inputSchema: serverScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    const result = await client.listServerSkills(
      { projectId: project.id, serverId: server.id },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      server: toServerInfo(server),
      result,
    };
  },
};

const getServerSkillInput = serverScopedInput.extend({
  uri: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Exact skill uri. Usually from list_server_skills, but any uri works — a skill absent from a partial listing may still be served."
    ),
});

export type GetServerSkillInput = z.infer<typeof getServerSkillInput>;

export type GetServerSkillResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  result: Record<string, unknown>;
};

export const getServerSkillOperation: PlatformOperation<
  GetServerSkillInput,
  GetServerSkillResult
> = {
  name: "get_server_skill",
  title: "Get MCPJam server skill",
  description:
    "Fetch one skill from a saved MCP server by uri, verified before any content is returned: the SKILL.md digest against the manifest, the fetched frontmatter against what the listing advertised, and the name against the uri. Answers with the skill, or with a refusal naming the check that failed.",
  readOnly: true,
  permalink: noPermalink(
    "external-resource",
    "The payload is the third-party server's skill content."
  ),
  inputSchema: getServerSkillInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    const result = await client.getServerSkill(
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

const readServerSkillFileInput = serverScopedInput.extend({
  skillUri: z
    .string()
    .trim()
    .min(1)
    .describe("Uri of the skill that owns the file."),
  resourceUri: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Uri of the supporting file, which must appear in that skill's manifest — the manifest is the read allowlist."
    ),
});

export type ReadServerSkillFileInput = z.infer<typeof readServerSkillFileInput>;

export type ReadServerSkillFileResult = {
  project: SelectedProjectInfo;
  server: ResolvedServerInfo;
  result: Record<string, unknown>;
};

export const readServerSkillFileOperation: PlatformOperation<
  ReadServerSkillFileInput,
  ReadServerSkillFileResult
> = {
  name: "read_server_skill_file",
  title: "Read MCPJam server skill file",
  description:
    "Read one supporting file of a server-served skill, checked against that skill's own manifest for byte length and digest. Get both uris from list_server_skills or get_server_skill first.",
  readOnly: true,
  permalink: noPermalink(
    "external-resource",
    "The payload is the third-party server's skill file content."
  ),
  inputSchema: readServerSkillFileInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
    );
    const result = await client.readServerSkillFile(
      {
        projectId: project.id,
        serverId: server.id,
        body: {
          skillUri: input.skillUri,
          resourceUri: input.resourceUri,
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
  permalink: derivePermalinks((result) => [serverRef(result)]),
  inputSchema: serverScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
    // No repeated-cursor guard: comparing two cursors for equality is itself
    // a determination based on cursor value, and a server may legally reissue
    // one constant token — `""` included — for every page. The cap below is
    // the bound, and it already flags the read as incomplete.
    for (let page = 0; page < HOST_COMPAT_TOOLS_PAGE_CAP; page++) {
      const result = await client.listServerTools(
        // Presence, not truthiness: `""` is a valid MCP continuation cursor.
        { ...scope, body: cursor !== undefined ? { cursor } : {} },
        { signal }
      );
      rawTools.push(...result.items);
      cursor =
        typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (cursor === undefined) break;
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
      "Ask a model for optional experience observations. COSTS the organization's MCPJam credits. Defaults false; the deterministic grade is complete without it."
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Replay guard. A retry carrying the same key returns the run it already started rather than dialling the target twice."
    ),
});

const startOpenAIReadinessInput = startReadinessInput.extend({
  submissionMode: z
    .enum(["mcp-only", "mcp-imported-skills"])
    .describe(
      "REQUIRED, and never inferred: which submission shape is being graded. The two package shapes need an upload this API cannot receive — grade those with `mcpjam readiness check` locally."
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `conformance/readiness/:runId` route: the readiness section rediscovers the LATEST run for a server and has no run-selection UI, so `/conformance?readinessRun=` is read by nothing. A link carrying it would switch the reader's project and then show them a different run — the wrong-resource landing this contract exists to end."
  ),
  inputSchema: startReadinessInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    // Rejects stdio and URL-less servers with a named reason, which is the
    // same refusal the route makes — better here, before a row exists.
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
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
      { signal }
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `conformance/readiness/:runId` route: the readiness section rediscovers the LATEST run for a server and has no run-selection UI, so `/conformance?readinessRun=` is read by nothing. A link carrying it would switch the reader's project and then show them a different run — the wrong-resource landing this contract exists to end."
  ),
  inputSchema: startOpenAIReadinessInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
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
      { signal }
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `conformance/readiness/:runId` route: the readiness section rediscovers the LATEST run for a server and has no run-selection UI, so `/conformance?readinessRun=` is read by nothing. A link carrying it would switch the reader's project and then show them a different run — the wrong-resource landing this contract exists to end."
  ),
  inputSchema: readinessRunScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const run = await client.getReadinessRun(
      { projectId: project.id, runId: input.run },
      { signal }
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `conformance/readiness/:runId` route: the readiness section rediscovers the LATEST run for a server and has no run-selection UI, so `/conformance?readinessRun=` is read by nothing. A link carrying it would switch the reader's project and then show them a different run — the wrong-resource landing this contract exists to end."
  ),
  inputSchema: listReadinessRunsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
      { signal }
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
  permalink: noPermalink("mutation-only"),
  inputSchema: readinessRunScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const result = await client.cancelReadinessRun(
      { projectId: project.id, runId: input.run },
      { signal }
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `conformance/readiness/:runId` route: the readiness section rediscovers the LATEST run for a server and has no run-selection UI, so `/conformance?readinessRun=` is read by nothing. A link carrying it would switch the reader's project and then show them a different run — the wrong-resource landing this contract exists to end."
  ),
  inputSchema: readinessRunScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
        String(left.class) as (typeof READINESS_FINDING_CLASS_ORDER)[number]
      );
      const rightRank = READINESS_FINDING_CLASS_ORDER.indexOf(
        String(right.class) as (typeof READINESS_FINDING_CLASS_ORDER)[number]
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
      "Suites to run. Defaults to protocol, apps, and tasks. OAuth is not available on this surface."
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Replay guard. A retry carrying the same key returns the run it already started rather than dialling the target twice."
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
  permalink: derivePermalinks((result) => [
    {
      type: "conformance_run",
      id: result.run.runId,
      projectId: result.run.projectId,
    },
  ]),
  inputSchema: startConformanceRunInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const server = await resolveLiveServer(
      client,
      project,
      input.server,
      signal
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
      { signal }
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
  permalink: derivePermalinks((result) => [
    {
      type: "conformance_run",
      id: result.run.id,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: conformanceRunScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const run = await client.getConformanceRun(
      { projectId: project.id, runId: input.run },
      { signal }
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
  permalink: derivePermalinks((result) =>
    result.runs.map((run) => ({
      type: "conformance_run" as const,
      id: run.id,
      projectId: result.project?.id,
    }))
  ),
  inputSchema: listConformanceRunsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
      { signal }
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
  permalink: derivePermalinks((result) => [
    {
      type: "conformance_run",
      id: result.runId,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: conformanceRunScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const report = await client.getConformanceReport(
      { projectId: project.id, runId: input.run },
      { signal }
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
      "Pass compose OR a target selector, not both — compose builds the execution stack the run uses, so naming an environment, host, server override or allAttached alongside it describes two different runs."
    );
  }

  if (input.environment && (input.environments?.length ?? 0) > 0) {
    throw operationInputError(
      "Pass either environment (one) or environments (several), not both."
    );
  }
  if (input.host && (input.hosts?.length ?? 0) > 0) {
    throw operationInputError(
      "Pass either host (one) or hosts (several), not both."
    );
  }
  if (hasEnvironmentAxis && hasHostAxis) {
    throw operationInputError(
      "Pass environments or hosts, not both — a run targets ONE axis, and an environment already resolves a host, so combining them would describe a configuration the suite never had."
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
      "Pass either environment or servers, not both — a project environment supplies its own closed server set, which servers cannot override."
    );
  }
  if (hasHostAxis && (input.servers?.length ?? 0) > 0) {
    throw operationInputError(
      "Pass either a host or servers, not both — running an attached host uses that host's own configured server set, which servers cannot override."
    );
  }
  if (input.allAttached && (hasEnvironmentAxis || hasHostAxis)) {
    throw operationInputError(
      "Pass allAttached or name targets explicitly, not both — 'every attached target' and 'these ones' cannot both be meant, and guessing would either skip a run you asked for or start one you did not."
    );
  }
  if (input.allAttached && (input.servers?.length ?? 0) > 0) {
    throw operationInputError(
      "Pass allAttached or servers, not both — a server override replaces the suite's selection for one run and has no fan-out."
    );
  }
}

/**
 * The TARGET_REQUIRED refusal, enumerating what is actually pickable.
 *
 * Named after the machine-readable code so a surface can match on it, and
 * written so the caller never has to go look the choices up: the whole failure
 * mode this replaces was an agent guessing a target because the error did not
 * say which ones existed. That enumeration lives here ONCE, shared by both
 * callers, precisely so the two cannot drift — before G4c the disclosure
 * variant was a separate function that listed only environments, which went
 * stale the moment that operation gained a `host` selector.
 *
 * `readOnly` is `getEvalRunDisclosureOperation`'s variant. It must not inherit
 * the launch wording's "running all of them would spend more than you may have
 * meant" / "one PAID RUN per target" — nothing it does spends anything, and
 * telling an agent otherwise invites it to treat a free planning read as a
 * costly one. It also has no `allAttached` selector, so naming that flag would
 * send a caller retrying with an argument that fails validation the same way
 * twice.
 */
function targetRequiredMessage(
  plan: {
    attachedEnvironments: RunTarget[];
    attachedHosts: RunTarget[];
  },
  opts: { readOnly?: boolean } = {}
): string {
  const parts: string[] = [];
  if (plan.attachedEnvironments.length > 0) {
    parts.push(
      `environments: ${plan.attachedEnvironments
        .map((target) =>
          target.name ? `"${target.name}" (${target.id})` : target.id
        )
        .join(", ")}`
    );
  }
  if (plan.attachedHosts.length > 0) {
    parts.push(
      `hosts: ${plan.attachedHosts
        .map((target) => `"${target.name}" (${target.id})`)
        .join(", ")}`
    );
  }
  const lead = opts.readOnly
    ? "TARGET_REQUIRED — this suite has several attached targets, so which one to disclose for is ambiguous. "
    : "TARGET_REQUIRED — this suite has several attached targets, so which one to run is ambiguous and running all of them would spend more than you may have meant. ";
  // The read-only closing names ONLY the selectors that actually apply to
  // what is attached. Naming a fix a caller cannot apply — `host` against a
  // suite with no attached hosts — sends an agent retrying with an argument
  // that resolves to nothing; that is the same failure the enumeration above
  // exists to prevent, one sentence later.
  const readOnlyWays: string[] = [];
  if (plan.attachedEnvironments.length > 0) readOnlyWays.push("environment");
  if (plan.attachedHosts.length > 0) readOnlyWays.push("host");
  const closing = opts.readOnly
    ? `Name one with ${readOnlyWays.join(" or ")}${
        plan.attachedEnvironments.length > 0
          ? ", or several with environments."
          : "."
      }`
    : "Name one with environment or host, several with environments or hosts, or run every attached target with allAttached (one PAID RUN per target).";
  return lead + `Attached ${parts.join("; ")}. ` + closing;
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
  signal: AbortSignal | undefined
): Promise<Array<{ id: string; name?: string }>> {
  if (selectors.length === 0) return [];
  const attached = detail?.environmentIds ?? [];
  const resolved: Array<{ id: string; name?: string }> = [];
  for (const selector of selectors) {
    const environment = await resolveEnvironmentSelector(
      client,
      project,
      selector,
      signal
    );
    if (!attached.includes(environment.id)) {
      throw operationInputError(
        attached.length === 0
          ? `Environment "${selector}" is not attached to suite "${
              suite.name ?? suite.id
            }", which has no environments at all. Attach it with set_eval_suite_environments first.`
          : `Environment "${selector}" is not attached to suite "${
              suite.name ?? suite.id
            }". Attached environment IDs: ${attached.join(", ")}.`
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
  signal: AbortSignal | undefined
): Promise<Map<string, string>> {
  if (environmentIds.length === 0) return new Map();
  try {
    const page = await client.listEnvironments(
      { projectId: project.id },
      { signal }
    );
    const wanted = new Set(environmentIds);
    return new Map(
      page.items
        .filter((environment) => wanted.has(environment.id) && environment.name)
        .map((environment) => [environment.id, environment.name])
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
  selectors: string[]
): RunTargetHost[] {
  if (selectors.length === 0) return [];
  const hosts = detail?.hosts ?? [];
  if (hosts.length === 0) {
    throw operationInputError(
      `Suite "${
        suite.name ?? suite.id
      }" has no attached hosts, so there is no host to run. Attach one to the suite first, or omit the host selector.`
    );
  }
  return selectors.map((selector) =>
    resolveByIdOrName(
      hosts,
      selector,
      "Suite host",
      `suite "${suite.name ?? suite.id}"`
    )
  );
}

/** The knobs both launch shapes forward, in the wire's own vocabulary. */
function runKnobBody(
  input: {
    repetitions?: number;
    /** Deprecated alias for repetitions. */
    iterations?: number;
    notes?: string;
    minPassRate?: number;
    matchOptions?: z.infer<typeof publicMatchOptionsSchema>;
    excludeSkills?: boolean;
    idempotencyKey?: string;
    sourceHash?: string;
    importApprovals?: Array<{ testCaseId: string; reason: string }>;
  },
  caseIds: string[] | undefined
): Record<string, unknown> {
  return {
    ...(input.repetitions !== undefined || input.iterations !== undefined
      ? { iterationOverride: input.repetitions ?? input.iterations }
      : {}),
    ...(caseIds ? { caseIds } : {}),
    ...(input.matchOptions ? { matchOptionsOverride: input.matchOptions } : {}),
    ...(input.excludeSkills ? { skillsOverride: "exclude" as const } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.minPassRate !== undefined
      ? { passCriteria: { minimumPassRate: input.minPassRate } }
      : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
    // Forwarded UNCHANGED to every target of a grouped launch. A case's
    // approximation is approximated the same way on each of them, so an
    // approval that covered only the first target would refuse the rest of a
    // launch the caller approved once and meant once.
    ...(input.importApprovals?.length
      ? { importApprovals: input.importApprovals }
      : {}),
  };
}

/** What a `compose` produced, plus the report the result carries. */
interface ComposedCell {
  id: string;
  modelId?: string;
  created: boolean;
}

interface ComposedRunEnvironment {
  environment: { id: string };
  environments: Array<{ id: string; modelId?: string }>;
  report: {
    environment: {
      id: string;
      name: null;
      adhoc: true;
      created: boolean;
      modelId?: string;
    };
    environments: Array<{
      id: string;
      name: null;
      adhoc: true;
      created: boolean;
      modelId?: string;
    }>;
    attachment: { attached: boolean };
  };
}

export function expandComposeModelChoices(stack: {
  model?: string;
  models?: string[];
  includeClientDefault?: boolean;
}): Array<{ modelId: string | undefined }> {
  const explicit = [
    ...new Set([
      ...(stack.models ?? []),
      ...(stack.model ? [stack.model] : []),
    ]),
  ];
  const includeDefault =
    explicit.length === 0 ? true : stack.includeClientDefault === true;
  const choices: Array<{ modelId: string | undefined }> = [];
  if (includeDefault) choices.push({ modelId: undefined });
  for (const modelId of explicit) choices.push({ modelId });
  return choices;
}

/**
 * What a compose already wrote, as a sentence for an error that came after it.
 *
 * ONE formatter, because both places that report this are reporting the same
 * two facts (which cells exist, whether the suite was edited) and a caller
 * deciding "did this touch my suite?" must not get a different answer
 * depending on which step failed.
 */
function composedCellsNote(
  cells: ReadonlyArray<{ id: string; created: boolean; modelId?: string }>,
  attached: boolean
): string {
  const cellNote = cells
    .map(
      (cell) =>
        `${cell.id}${cell.created ? " (created)" : " (reused)"}${
          cell.modelId ? ` · ${cell.modelId}` : ""
        }`
    )
    .join(", ");
  return `(The composed environment${
    cells.length === 1 ? "" : "s"
  } ${cellNote} ${
    attached ? "were attached to the suite" : "were minted without attaching"
  }; retrying is safe — it will reuse them.)`;
}

/**
 * Turn a composed stack into runnable target cells: ensure one ad-hoc
 * environment per model choice (host-major inherit-then-explicit).
 *
 * DEFAULT IS EPHEMERAL — mint and launch without mutating the suite. Attach
 * is opt-in (`saveTargets` / `--save-targets`) because permanently appending
 * on every compose experiment accumulates toward the 10-cap.
 *
 * When attach is requested, the union `|existing ∪ newCells|` is checked
 * before the first attach, so the suite is never grown past the cap and never
 * left half-appended by it. Note what that check CANNOT be: exact before the
 * cells exist. Ad-hoc ids are content-addressed by the backend, so whether a
 * cell is new or resolves onto a row the suite already has is not knowable
 * client-side — an `existing + choices` estimate would reject re-composing a
 * stack that is already attached, which fits fine. Minting first and checking
 * the real union keeps the answer exact; the cost is ad-hoc rows that no
 * suite references, which is the standing posture for them anyway (content-
 * addressed, hidden from lists, reused on the next identical compose).
 */
async function composeRunEnvironment(
  client: PlatformApiClient,
  project: PlatformProject,
  suite: PlatformEvalSuite,
  stack: {
    host: string;
    serverGroup?: string;
    server?: string;
    servers?: string[];
    hostServers?: boolean;
    model?: string;
    models?: string[];
    includeClientDefault?: boolean;
    saveTargets?: boolean;
    computer?: string;
    skills?: PlatformEnvironmentSkillSelection;
    pluginVersionIds?: string[];
  },
  signal: AbortSignal | undefined,
  options: { attach: boolean } = { attach: true }
): Promise<ComposedRunEnvironment> {
  // Once, before the fan-out: every model cell shares one server group, and
  // resolving inside the loop would re-list (and race to create) per cell.
  const pinned = await materializeComposeServers(
    client,
    project,
    stack,
    signal
  );
  // Truthiness, not `!== undefined`, because that is what actually reaches the
  // wire: `resolveComposeStack` drops a blank `serverGroup`, so a `""` checked
  // for presence alone would clear this guard and then compose the exact
  // unpinned environment it exists to refuse.
  const pinnedGroup = pinned.serverGroup?.trim();
  // Asking to follow the host AND to pin is a contradiction, and resolving it
  // silently would drop one of the two things the caller said. The CLI rejects
  // the pair too; repeated here because `execute` is reachable without it.
  if (
    stack.hostServers === true &&
    (pinnedGroup || stack.server !== undefined || stack.servers !== undefined)
  ) {
    throw operationInputError(
      "`hostServers` runs against the host's current list, so it cannot be combined with `server`/`servers`/`serverGroup`, which pin one."
    );
  }
  // The server is the thing under test, so a composed RUN has to say which one.
  // Without a pin the run reads the host's list at execution time, and editing
  // that shared host silently repoints every eval composed against it — the
  // failure this guard exists to stop. Following the host stays available, but
  // only as something the caller asked for out loud.
  if (!pinnedGroup && stack.hostServers !== true) {
    throw operationInputError(
      "A composed eval run must say which servers to test: pass `server`/`servers` (or `serverGroup`). To deliberately run against the host's current list — which changes when the host is edited — pass `hostServers: true`."
    );
  }
  const choices = expandComposeModelChoices(pinned);
  const cells: ComposedCell[] = [];
  for (const choice of choices) {
    const body = await resolveComposeStack(
      client,
      project,
      { ...pinned, model: choice.modelId },
      signal
    );
    const ensured = await client.ensureAdhocEnvironment(
      { projectId: project.id, body },
      { signal }
    );
    cells.push({
      id: ensured.environment.id,
      ...(choice.modelId ? { modelId: choice.modelId } : {}),
      created: ensured.created === true,
    });
  }

  let attached = false;
  if (options.attach) {
    const detail = await client.getEvalSuite(
      { projectId: project.id, suiteId: suite.id },
      { signal }
    );
    const existing = new Set(detail.environmentIds ?? []);
    const union = new Set([...existing, ...cells.map((cell) => cell.id)]);
    if (union.size > 10) {
      throw operationInputError(
        `Attaching these composed cells would grow the suite to ${
          union.size
        } environments (limit 10). Detach some first, or omit --save-targets / saveTargets to launch ephemerally. ${composedCellsNote(
          cells,
          false
        )}`
      );
    }
    for (const cell of cells) {
      try {
        const attachment = await client.attachEvalSuiteEnvironment(
          {
            projectId: project.id,
            suiteId: suite.id,
            environmentId: cell.id,
          },
          { signal }
        );
        attached = attached || attachment.attached === true;
      } catch (error) {
        // The suite is now PARTIALLY appended, and this loop runs before the
        // launch — so the annotator that reports compose writes does not exist
        // yet (it is handed a finished `ComposedRunEnvironment`). Without this
        // the caller is told the attach failed and never that some of it
        // landed. Annotated in place so an abort stays an abort.
        if (error instanceof Error) {
          error.message = `${error.message} ${composedCellsNote(
            cells,
            attached
          )}`;
        }
        throw error;
      }
    }
  }

  const reports = cells.map((cell) => ({
    id: cell.id,
    name: null as null,
    adhoc: true as const,
    created: cell.created,
    ...(cell.modelId ? { modelId: cell.modelId } : {}),
  }));
  return {
    environment: { id: cells[0]!.id },
    environments: cells.map((cell) => ({
      id: cell.id,
      ...(cell.modelId ? { modelId: cell.modelId } : {}),
    })),
    report: {
      environment: reports[0]!,
      environments: reports,
      attachment: { attached },
    },
  };
}

/**
 * Probe what this deployment can do with a composed stack, in ONE read.
 *
 * A missing capabilities route (older inspector) or a payload that omits a
 * flag both mean "do not send it" — an unknown field is a hard 400 on a strict
 * schema, not a silently ignored one.
 *
 * `modelOverrides` rides along rather than getting a second round-trip: both
 * questions are answered by the same route, and the compose path has to ask
 * both whenever a model is named.
 */
async function probeComposeCapabilities(
  client: PlatformApiClient,
  projectId: string,
  signal: AbortSignal | undefined
): Promise<{ ephemeralLaunch: boolean; modelOverrides: boolean }> {
  try {
    const capabilities = await client.getEnvironmentCapabilities(
      { projectId },
      { signal }
    );
    return {
      ephemeralLaunch: capabilities.ephemeralEnvironmentLaunch === true,
      modelOverrides: capabilities.modelOverrides === true,
    };
  } catch {
    return { ephemeralLaunch: false, modelOverrides: false };
  }
}

/**
 * Decide whether a compose writes suite attachments and whether the launch
 * may send `ephemeralEnvironment: true`.
 *
 * Multi-cell compose against a backend that cannot launch unattached envs
 * is refused here — before any mint — rather than sending an unknown arg.
 * A single cell on that same backend falls back to attach, which is what
 * today's compose already did.
 */
function composeLaunchPolicy(input: {
  choiceCount: number;
  saveTargets: boolean;
  ephemeralOk: boolean;
  /** Explicit model ids were named (an inherit-only compose names none). */
  explicitModels: boolean;
  modelOverridesOk: boolean;
  refreshSnapshot?: boolean;
}): { attach: boolean; ephemeralLaunch: boolean } {
  if (input.explicitModels && !input.modelOverridesOk) {
    // The same preflight `environments create --model` performs, on the path
    // that actually grew a model axis. Without it a skew deployment answers a
    // `--compose-model` with the raw validator error from `ensureAdhocEnvironment`
    // — the opaque failure that guard exists to replace — and the CLI, remote
    // MCP and in-app agent all take THIS path, so putting it here is what makes
    // the three agree with the web composer, which already refuses.
    throw operationInputError(
      "This MCPJam deployment does not support environment model overrides. Upgrade the platform, or omit --compose-model / compose.models."
    );
  }
  if (input.choiceCount > 1 && input.refreshSnapshot) {
    throw operationInputError(
      "refreshSnapshot cannot be used with a multi-target launch — it PERSISTS one host-config snapshot on the suite, and several runs racing to write it would leave the suite pinned to whichever finished last. Run one target at a time to refresh it."
    );
  }
  if (input.choiceCount > 1 && !input.ephemeralOk && !input.saveTargets) {
    throw operationInputError(
      "This MCPJam server cannot launch a multi-model compose without attaching the environments. Upgrade the backend (ephemeralEnvironmentLaunch) or pass --save-targets / saveTargets to attach them instead."
    );
  }
  if (input.choiceCount > 10) {
    throw operationInputError(
      `1 client × ${input.choiceCount} model choices = ${input.choiceCount} targets; limit 10.`
    );
  }
  const attach =
    input.saveTargets || (!input.ephemeralOk && input.choiceCount === 1);
  return {
    attach,
    ephemeralLaunch: !attach && input.ephemeralOk,
  };
}

/**
 * Id-shaped: a Convex document id — lowercase base32-ish, no separators.
 *
 * Deliberately narrow. A looser shape (anything 16+ of `[A-Za-z0-9_-]`) also
 * matches ordinary display names like `staging-environment`, which then reach
 * `v.id()` on the server and fail validation BEFORE the handler — an error
 * class the route reports as a 500, not a 404. The list path is the correct
 * home for names, so keep them off this branch. Anything that slips through
 * still falls back (see {@link resolveEnvironmentSelector}).
 */
function looksLikeEnvironmentId(selector: string): boolean {
  return /^[a-z0-9]{25,40}$/.test(selector);
}

/** A caller-requested cancellation, however the transport spelled it. */
function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "AbortError" || code === "ABORT_ERR";
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
  launch: () => Promise<T>
): Promise<T> {
  if (!composed) return launch();
  try {
    return await launch();
  } catch (error) {
    const cells = composed.report.environments ?? [composed.report.environment];
    const note = composedCellsNote(
      cells,
      composed.report.attachment.attached === true
    );
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
  signal: AbortSignal | undefined
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
        { status: 404 }
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
  permalink: derivePermalinks((result) =>
    result.items.map((suite) => ({
      type: "eval_suite" as const,
      id: suite.id,
      projectId: result.project?.id,
      ...(suite.name ? { label: `Open ${suite.name}` } : {}),
    }))
  ),
  inputSchema: projectScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) =>
    result.items.map((run) =>
      evalRunRef(run.id, result.suite.id, result.project?.id)
    )
  ),
  inputSchema: evalSuiteScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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

/**
 * Knobs that apply to a run whatever it targets. Declared once and spread into
 * both run inputs: a knob that exists on the suite op and not the case op is a
 * knob callers have to remember two rules for, and the divergence is invisible
 * until someone hits it.
 */
/**
 * The ONE skill-selection schema. Every surface that accepts a pinned skill
 * selection — `create_project_environment`, `update_project_environment`,
 * `ensure_adhoc_environment`, and the run ops' `compose` field — parses
 * through this, so a selection means the same thing wherever it is written.
 *
 * `compose` used to declare its own narrower twin, which parsed `mode` and
 * `skillIds` and dropped `versionPins` on the floor: composing a pinned stack
 * silently ran Latest, which is precisely the arm the caller pinned away from.
 *
 * Declared HERE, above the run inputs, for the same temporal-dead-zone reason
 * `composeRunTargetInput` is — the environment ops that also use it are far
 * below.
 */
const skillSelectionInput = z
  .object({
    mode: z.literal("explicit"),
    skillIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .describe(
        "Project-shared skill IDs to select. Plugin-component skills cannot be selected — they reach a run by pinning their plugin version."
      ),
    versionPins: z
      .array(
        z.object({
          skillId: z.string().trim().min(1),
          versionId: z.string().trim().min(1),
        })
      )
      .min(1)
      .optional()
      .describe(
        "Optional exact-version overlay: at most one entry per selected skill, each naming a version of that same skill. A selected skill with no entry runs 'Latest' — its current revision, resolved when the run starts. Pin a version to hold this environment at a known revision, e.g. to compare two revisions of one skill side by side."
      ),
  })
  // The pins are only meaningful RELATIVE to the selection they ride on, so the
  // relation is checked here rather than left to the API: a duplicate pin makes
  // "which revision does this skill run?" ambiguous, and a pin for an
  // unselected skill silently does nothing. Both are rejected server-side too —
  // catching them in the SDK turns a round-trip error into an immediate one.
  .superRefine((selection, ctx) => {
    const pins = selection.versionPins ?? [];
    const selected = new Set(selection.skillIds);
    const seen = new Set<string>();
    for (const pin of pins) {
      if (seen.has(pin.skillId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["versionPins"],
          message: `Skill ${pin.skillId} has more than one version pin; pin at most one version per skill.`,
        });
      }
      seen.add(pin.skillId);
      if (!selected.has(pin.skillId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["versionPins"],
          message: `Version pin references skill ${pin.skillId}, which is not in skillIds.`,
        });
      }
    }
  })
  .describe(
    "Explicit pinned skill selection. Cannot be empty — omit the field entirely, or pass null when updating, to mean 'no pinned skills'."
  );

/**
 * A COMPOSED run target: assemble a stack instead of naming a saved
 * environment. Declared here, above the run inputs, for the same
 * temporal-dead-zone reason `publicMatchOptionsSchema` is.
 *
 * The stack resolves to ad-hoc (unnamed, content-addressed) environments and
 * then launches through the ORDINARY environment path — same resolution, same
 * immutable snapshot. Model fan-out is N of those cells (one per explicit
 * model, plus an inherit cell when `includeClientDefault` is set), not a
 * second run-level override channel.
 */
const composeRunTargetInput = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Host (name or ID) the composed stack runs as — the client whose configuration the run is stamped with."
      ),
    serverGroup: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Standalone server group to pin (by ID). One of `server`/`servers`/`serverGroup` is required unless `hostServers` opts into the host's live list."
      ),
    hostServers: z
      .boolean()
      .optional()
      .describe(
        "Run against the host's CURRENT server list instead of pinning one. The list is read at run time, so editing the host later changes what a rerun tests — opt in only when following the host is the point."
      ),
    server: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Singular alias for `servers`."),
    servers: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe(SERVERS_SELECTOR_DESCRIPTION),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Singular alias for `models`. Prefer `models` for a matrix."),
    models: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe(
        "Explicit model overrides. Each id mints one override cell. Combined with `includeClientDefault` this is the model axis. Replaces the client default unless `includeClientDefault` is true."
      ),
    includeClientDefault: z
      .boolean()
      .optional()
      .describe(
        "Also mint an inherit cell that uses the host's pinned model. Default false when `models` is set; implied true when no models are named."
      ),
    saveTargets: z
      .boolean()
      .optional()
      .describe(
        "Attach the minted cells to the suite (append, capped at 10). Default is ephemeral: mint and launch without mutating suite attachments."
      ),
    computer: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Sandbox image (name or ID) to pin, so the run boots a fresh computer from it. Must be project-shared."
      ),
    skills: skillSelectionInput
      .optional()
      .describe(
        "Explicit pinned skill selection for the composed stack, `versionPins` included — the same schema every other skill-selection surface uses."
      ),
    pluginVersionIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe("Plugin VERSION IDs to pin for the composed stack."),
  })
  .superRefine(refineComposeServerSelectors)
  .describe(
    "Compose an execution stack to run instead of naming a saved environment. Default is EPHEMERAL: cells are minted and launched without attaching them to the suite (`saveTargets: true` opts into append). Deduplicated by content, so composing the same stack twice reuses one environment. Mutually exclusive with environment/environments/host/hosts/servers/allAttached."
  );

/**
 * One per-run approval of an approximated import.
 *
 * The caller supplies the id and the reason and NOTHING ELSE. A
 * caller-supplied approver would file one person's approval under another's
 * name, and a caller-supplied timestamp could be backdated past the edit that
 * invalidated the claim — so both are derived server-side, and this object has
 * no field for either.
 */
const importApprovalsSchema = z
  .array(
    z
      .object({
        testCaseId: z
          .string()
          .trim()
          .min(1)
          .describe("Hosted test-case id (not the authored/declared case id)."),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .describe(
            "Why this approximation is acceptable for this run. An override with no stated reason is indistinguishable from an accident."
          ),
      })
      .strict()
  )
  .min(1);

const RUN_KNOB_FIELDS = {
  repetitions: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Run each case this many times under verdict policy 2, overriding its saved repetitions FOR THIS RUN ONLY (the suite is untouched). Multiplies what the run costs."
    ),
  iterations: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Run each case this many times, overriding its saved iteration count FOR THIS RUN ONLY (the suite is untouched). Multiplies what the run costs."
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
      "Pass threshold for this run as a percentage (0-100), overriding the suite's own criterion."
    ),
  matchOptions: publicMatchOptionsSchema
    .optional()
    .describe(
      "Tool-call match options for this run only, layered over suite defaults and per-case overrides. Does NOT edit the suite or its cases."
    ),
  excludeSkills: z
    .boolean()
    .optional()
    .describe(
      "Run the 'without skills' arm of an A/B comparison: NO skills are pinned from any channel and the run is labelled as excluded, rather than merely being skill-free. Scoped to skill delivery — a pinned plugin's MCP servers stay connected, because which servers an arm connects is the one variable a skills A/B has to hold fixed."
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Retry-safety key. Repeating a call with the same key returns the run it already started instead of starting (and billing) a second one. On a multi-target launch the key covers the whole group: a retry returns the same group and the same runs."
    ),
  sourceHash: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/,
      "sourceHash must be a 64-character lowercase SHA-256 hex digest"
    )
    .optional()
    .describe(
      "SHA-256 hex of the suite-file bytes that launched this run. Set by `eval run --file`; a UI or API launch that did not come from a file omits it."
    ),
  importApprovals: importApprovalsSchema
    .optional()
    .describe(
      "Approve `approximated` imported cases for THIS RUN ONLY. Each entry names a hosted test-case id and a reason (1-500 characters). The approver's identity and the approval time are derived by the server and frozen into the run's own snapshot — never supplied here. Approval does not persist: the next run of the same case needs a new one."
    ),
} as const;

const runEvalSuiteInput = z
  .object({
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
    environments: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe(
        "Several attached environments to run, one PAID RUN EACH, grouped. Every name or ID must be attached to the suite. Use `environment` for exactly one; passing both is an error."
      ),
    host: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "One host ATTACHED to the suite (name or ID) to run against. The run is stamped with that host's configuration; without it a suite with several attached hosts cannot be run at all, and one with exactly one runs against it automatically. Mutually exclusive with the environment selectors and with `servers`."
      ),
    hosts: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe(
        "Several attached hosts to run, one PAID RUN EACH, grouped. Every name or ID must be attached to the suite. Use `host` for exactly one; passing both is an error."
      ),
    allAttached: z
      .boolean()
      .optional()
      .describe(
        "Run EVERY attached environment (or, when the suite has none, every attached host), one run per target, grouped under a single launch. THIS LAUNCHES MULTIPLE PAID RUNS — one per target, each consuming credits. Cannot be combined with naming targets explicitly: 'all of them' and 'these ones' cannot both be meant."
      ),
    cases: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe(
        "Run only these cases (titles or IDs) instead of the whole suite. The suite itself is untouched."
      ),
    refreshSnapshot: z
      .boolean()
      .optional()
      .describe(
        "PERSISTS A NEW HOST-CONFIG SNAPSHOT ON THE SUITE, changing what every future run of it uses — not just this one. Without it a rerun leaves the snapshot frozen, which is what stops newly connected servers from silently contaminating an existing suite. Single-target runs only; rejected with any multi-target launch, where last-writer-wins on a frozen snapshot is never what was meant."
      ),
    compose: composeRunTargetInput.optional(),
    ...RUN_KNOB_FIELDS,
  })
  .superRefine((input, ctx) => {
    if (input.repetitions !== undefined && input.iterations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repetitions"],
        message:
          "Use either repetitions or the deprecated iterations alias, not both.",
      });
    }
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
    environment: {
      id: string;
      name: null;
      adhoc: true;
      created: boolean;
      modelId?: string;
    };
    environments?: Array<{
      id: string;
      name: null;
      adhoc: true;
      created: boolean;
      modelId?: string;
    }>;
    attachment: { attached: boolean };
  };
  /** One entry per target, in launch order. */
  targets: RunEvalTargetResult[];
  /**
   * The pre-run disclosure fetched for this launch's frozen target plan — the
   * SAME resolution `onDisclosure` (see `PlatformOperationContext`) already
   * received, carried on the receipt so a caller that only reads the return
   * value (rather than passing a callback) still sees it. Absent when the
   * fetch failed — a backend that predates the contract, a transient error —
   * which never blocks the launch itself.
   */
  disclosure?: PlatformEvalRunDisclosure;
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
  permalink: derivePermalinks((result) => {
    // A GROUPED launch links to the suite's runs lens, not to one member run:
    // linking to a single run would hide a sibling's failure, which is the one
    // thing whoever approved N paid runs most needs to see.
    if (result.runGroupId) {
      return [
        {
          type: "eval_run_group",
          id: result.runGroupId,
          parent: { type: "eval_suite", id: result.suite.id },
          projectId: result.project?.id,
        },
      ];
    }
    return result.runId
      ? [evalRunRef(result.runId, result.suite.id, result.project?.id)]
      : [
          {
            type: "eval_suite",
            id: result.suite.id,
            projectId: result.project?.id,
          },
        ];
  }),
  inputSchema: runEvalSuiteInput,
  async execute(
    input,
    { client, signal, onScopeResolved, onDisclosure, onDisclosureUnavailable }
  ) {
    // ── Guards first: reject every ambiguous combination BEFORE resolving
    // anything, so a caller who meant two different things is told so without
    // spending a round trip — let alone a run.
    assertNoServerOverrideWithEnvironment(input);
    assertRunTargetSelectorsCoherent(input);

    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
          (testCase) => testCase.id
        )
      : undefined;

    // COMPOSE produces the targets. Every refusal that can fire without a
    // write (wrong cases already resolved above; refreshSnapshot × N cells;
    // multi-model on a backend that cannot launch unattached) happens first
    // so a mistyped request does not mint rows or edit the suite.
    const composeChoices = input.compose
      ? expandComposeModelChoices(input.compose)
      : [];
    let composeAttach = false;
    let ephemeralLaunch = false;
    if (input.compose) {
      const capabilities = await probeComposeCapabilities(
        client,
        project.id,
        signal
      );
      const policy = composeLaunchPolicy({
        choiceCount: composeChoices.length,
        saveTargets: input.compose.saveTargets === true,
        ephemeralOk: capabilities.ephemeralLaunch,
        explicitModels: composeChoices.some(
          (choice) => choice.modelId !== undefined
        ),
        modelOverridesOk: capabilities.modelOverrides,
        ...(input.refreshSnapshot ? { refreshSnapshot: true } : {}),
      });
      composeAttach = policy.attach;
      ephemeralLaunch = policy.ephemeralLaunch;
    }
    const composed = input.compose
      ? await composeRunEnvironment(
          client,
          project,
          suite,
          input.compose,
          signal,
          { attach: composeAttach }
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
            { signal }
          );

    const selectedEnvironments = await resolveSuiteEnvironmentTargets(
      client,
      project,
      suite,
      detail,
      input.environment ? [input.environment] : input.environments ?? [],
      signal
    );
    const selectedHosts = resolveSuiteHostTargets(
      suite,
      detail,
      input.host ? [input.host] : input.hosts ?? []
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
      signal
    );

    // A composed stack IS the target set: one cell → a single launch, N
    // cells → one grouped launch under a single runGroupId. The attachment
    // axes are not consulted; the stack produced the environments.
    const plan: RunTargetPlan = composed
      ? composed.environments.length > 1
        ? {
            kind: "group",
            targets: composed.environments.map((environment) => ({
              kind: "environment" as const,
              id: environment.id,
            })),
          }
        : {
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
        "refreshSnapshot cannot be used with a multi-target launch — it PERSISTS one host-config snapshot on the suite, and several runs racing to write it would leave the suite pinned to whichever finished last. Run one target at a time to refresh it."
      );
    }

    // THE ONE RESOLUTION. The plan is now frozen — this is the exact target
    // set `createEvalRun`/`createEvalRunGroup` are about to launch below — so
    // fetching the disclosure here, keyed off that SAME frozen plan, is what
    // makes "what was disclosed" identical to "what will run". Deliberately
    // NOT re-resolved from `input`'s raw selectors a second time: a second
    // resolution could race an attachment edit and disclose a different plan
    // than the one that launches a moment later.
    //
    // BEST EFFORT. A disclosure fetch failure — a backend that predates the
    // contract, a transient network error — must never block or fail a
    // launch: this is a planning aid, not a gate. `onDisclosure` simply does
    // not fire, and the receipt's `disclosure` field is absent.
    let disclosure: PlatformEvalRunDisclosure | undefined;
    const disclosureEnvironmentIds =
      plan.kind === "single"
        ? plan.target?.kind === "environment"
          ? [plan.target.id]
          : []
        : plan.targets
            .filter((target) => target.kind === "environment")
            .map((target) => target.id);
    // A SINGLE host target is disclosed for real since G4c: the backend
    // contract takes `namedHostId`, so the frozen plan's host is forwarded
    // and the engine/sandbox facts come from that host's own config. Before
    // that this skipped the fetch entirely — the only query available was the
    // selector-less suite-BASE derivation, which a host config's own model
    // and harness can contradict, so a host-targeted run could be disclosed
    // "emulated, no sandbox" while it actually booted a harness sandbox.
    //
    // A multi-target GROUP containing a host is still not derivable, and for
    // a DIFFERENT reason than the retired one: the contract answers for ONE
    // launch plan (its one-axis rule refuses a host alongside an environment
    // selector), so a group spanning hosts has no single engine or model set
    // to disclose. N pre-launch round trips to stitch a composite would be a
    // different contract than the audit stamp records — an honest absence
    // beats a confident wrong answer, which is the principle this whole
    // contract is built on.
    //
    // (A plan with NOTHING attached is unaffected: `plan.target` is
    // undefined there, not host-kind, and that bare-rerun case is exactly
    // what the suite-base derivation already answers correctly for.)
    const disclosureHostId =
      plan.kind === "single" && plan.target?.kind === "host"
        ? plan.target.id
        : undefined;
    const isMultiTargetHostLaunch =
      plan.kind === "group" &&
      plan.targets.some((target) => target.kind === "host");
    let disclosureFailureReason: string | undefined;
    if (isMultiTargetHostLaunch) {
      disclosureFailureReason =
        "not derivable for a multi-target launch that includes a host — the disclosure contract answers for one launch plan, and a group spanning hosts has no single engine or model set to disclose";
    } else {
      // BOUNDED INDEPENDENTLY of the caller's own signal/deadline. This
      // request is awaited BEFORE the launch, so sharing the caller's signal
      // would let a stalled disclosure fetch burn through the launch's own
      // timeout budget — and once that deadline fires, the shared signal is
      // already aborted for the createEvalRun(Group) call a moment later,
      // turning a best-effort read into a failed launch.
      // `boundedDisclosureSignal` still aborts on a genuine caller
      // cancellation; it just cannot itself abort anything but this one
      // fetch.
      const disclosureBound = boundedDisclosureSignal(signal);
      try {
        disclosure = await client.getEvalRunDisclosure(
          {
            projectId: project.id,
            suiteId: suite.id,
            ...(caseIds && caseIds.length > 0 ? { caseIds } : {}),
            ...(disclosureEnvironmentIds.length === 1
              ? { environmentId: disclosureEnvironmentIds[0]! }
              : disclosureEnvironmentIds.length > 1
              ? { environmentIds: disclosureEnvironmentIds }
              : {}),
            ...(disclosureHostId ? { namedHostId: disclosureHostId } : {}),
          },
          { signal: disclosureBound.signal }
        );
      } catch (error) {
        disclosure = undefined;
        // A caller-initiated cancellation (the launch's OWN signal aborting,
        // forwarded through `boundedDisclosureSignal`) is not a disclosure
        // failure — the whole operation is being cancelled, and labeling it
        // "the disclosure fetch timed out" would misdescribe an unrelated
        // abort right before the launch itself fails the same way.
        disclosureFailureReason = signal?.aborted
          ? undefined
          : disclosureUnavailableReason(error);
      } finally {
        disclosureBound.dispose();
      }
    }
    // OUTSIDE the fetch's try/catch on purpose: `onDisclosure`/
    // `onDisclosureUnavailable` are caller code we do not control, and a
    // callback that throws must not be able to erase a disclosure that was
    // already fetched successfully — only a FETCH failure may leave
    // `disclosure` unset.
    if (disclosure) {
      invokeDisclosureCallback(() => onDisclosure?.(disclosure!));
    } else if (disclosureFailureReason) {
      // An absent disclosure with NO signal at all is indistinguishable from
      // "this build has no disclosure feature" — a caller that wants to say
      // "attempted, failed" rather than rendering nothing gets the chance to
      // here. Still never blocks or fails the launch.
      invokeDisclosureCallback(() =>
        onDisclosureUnavailable?.(disclosureFailureReason!)
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
              ...(ephemeralLaunch ? { ephemeralEnvironment: true } : {}),
              ...knobs,
            },
          },
          { signal }
        )
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
        ...(disclosure ? { disclosure } : {}),
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

    const group = await createEvalRunOrReportCompose(composed, () =>
      createEvalRunGroupOrExplain(
        client,
        project.id,
        {
          suiteId: suite.id,
          targets: plan.targets.map((target) =>
            target.kind === "environment"
              ? { environmentId: target.id }
              : { namedHostId: target.id }
          ),
          ...(ephemeralLaunch ? { ephemeralEnvironment: true } : {}),
          ...knobs,
        },
        signal
      )
    );

    const nameById = new Map(
      plan.targets.map((target) => [target.id, target.name])
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
        target.status === "started"
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
      ...(disclosure ? { disclosure } : {}),
      ...(composed ? { composed: composed.report } : {}),
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

const runEvalCaseInput = z
  .object({
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
    host: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "One host ATTACHED to the suite (name or ID) to run this case against, so the run is stamped with that host's configuration. Mutually exclusive with `environment` and `servers`."
      ),
    compose: composeRunTargetInput.optional(),
    repetitions: RUN_KNOB_FIELDS.repetitions,
    iterations: RUN_KNOB_FIELDS.iterations,
    idempotencyKey: RUN_KNOB_FIELDS.idempotencyKey,
    // A single-case run of an APPROXIMATED case needs the same per-run
    // approval a suite run does. Without it this operation could never launch
    // one — the platform refuses a selected approximation that carries no
    // approval — while `run_eval_suite` with `cases: [thatCase]` launches the
    // very same case. Two ways to run one case should not disagree about
    // whether it may run.
    importApprovals: RUN_KNOB_FIELDS.importApprovals,
  })
  .superRefine((input, ctx) => {
    if (input.repetitions !== undefined && input.iterations !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repetitions"],
        message:
          "Use either repetitions or the deprecated iterations alias, not both.",
      });
    }
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
    environment: {
      id: string;
      name: null;
      adhoc: true;
      created: boolean;
      modelId?: string;
    };
    environments?: Array<{
      id: string;
      name: null;
      adhoc: true;
      created: boolean;
      modelId?: string;
    }>;
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
  permalink: derivePermalinks((result) => [
    evalRunRef(result.runId, result.suite.id, result.project?.id),
  ]),
  inputSchema: runEvalCaseInput,
  async execute(input, { client, signal, onScopeResolved }) {
    assertNoServerOverrideWithEnvironment(input);
    assertRunTargetSelectorsCoherent(input);
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
    const composeChoices = input.compose
      ? expandComposeModelChoices(input.compose)
      : [];
    if (composeChoices.length > 1) {
      throw operationInputError(
        "`run_eval_case` accepts only one compose model — its receipt is a single run. Use `run_eval_suite` / `eval run` for a client × model matrix."
      );
    }
    let composeAttach = false;
    let ephemeralLaunch = false;
    if (input.compose) {
      const capabilities = await probeComposeCapabilities(
        client,
        project.id,
        signal
      );
      const policy = composeLaunchPolicy({
        choiceCount: composeChoices.length,
        saveTargets: input.compose.saveTargets === true,
        ephemeralOk: capabilities.ephemeralLaunch,
        explicitModels: composeChoices.some(
          (choice) => choice.modelId !== undefined
        ),
        modelOverridesOk: capabilities.modelOverrides,
      });
      composeAttach = policy.attach;
      ephemeralLaunch = policy.ephemeralLaunch;
    }
    const composed = input.compose
      ? await composeRunEnvironment(
          client,
          project,
          suite,
          input.compose,
          signal,
          { attach: composeAttach }
        )
      : undefined;
    const environment = input.environment
      ? await resolveEnvironmentSelector(
          client,
          project,
          input.environment,
          signal
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
            { signal }
          ),
          [input.host]
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
            ...(ephemeralLaunch ? { ephemeralEnvironment: true } : {}),
            ...(input.repetitions !== undefined ||
            input.iterations !== undefined
              ? { iterationOverride: input.repetitions ?? input.iterations }
              : {}),
            ...(input.idempotencyKey
              ? { idempotencyKey: input.idempotencyKey }
              : {}),
            ...(input.importApprovals?.length
              ? { importApprovals: input.importApprovals }
              : {}),
          },
        },
        { signal }
      )
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
  intent: caseIntentSchema
    .optional()
    .describe(
      "Optional analytics grouping label for this case. It does not change scoring or verdicts."
    ),
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
  permalink: derivePermalinks((result) => [
    {
      type: "eval_suite",
      id: result.suite.id,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: createEvalSuiteInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  intent: caseIntentSchema
    .optional()
    .describe(
      "Optional analytics grouping label for this case. It does not change scoring or verdicts."
    ),
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
  // THE CONVERTER'S CLAIM, on the operation surface too.
  //
  // Without it Zod strips the key and `buildCaseBody` never sees it, so a
  // converter writing through `create_eval_case` / `update_eval_case` (or
  // `cloud eval cases create/update --json`) stores an APPROXIMATED case as a
  // native one — and a native case needs no approval, so it runs and gates on
  // provenance that was silently discarded on the way in. Losing the claim is
  // strictly worse than rejecting the write.
  //
  // NOT nullable here, unlike `matchOptions` above. Clearing a claim is
  // meaningful only on an update, and the route agrees: the REST create schema
  // takes the claim or nothing while only PATCH accepts `null`. Sharing a
  // nullable schema across both would have the SDK advertise `import: null` on
  // a create as valid and the server answer 400 — a contract that lies to the
  // caller about its own inputs. `updateEvalCaseInput` widens it.
  import: evalSuiteFileCaseImportSchema
    .optional()
    .describe(
      "Import provenance for a converted case: {status, sourceCaseKey?, note?}. `exact` is a CONVERTER CLAIM, not a verification, and requires a note citing the mapping rule."
    ),
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
    "Stable declared id for the case (e.g. from a suite file). Minted for you when omitted."
  );

/** `buildCaseBody` plus the create-only declared id. */
function buildCreateCaseBody(
  input: Record<string, unknown>
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
  permalink: derivePermalinks((result) => [
    { type: "eval_suite", id: result.id, ...projectIdOf(result) },
  ]),
  inputSchema: getEvalSuiteInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return client.getEvalSuite(
      { projectId: project.id, suiteId: suite.id },
      { signal }
    );
  },
};

const getEvalRunDisclosureInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  suite: z.string().trim().min(1).describe(SUITE_SELECTOR_DESCRIPTION),
  cases: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe(
      "Narrow the disclosure to these cases (titles or IDs) instead of the whole suite — the same subset a run selects with `cases`."
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
      "Several attached environments to disclose for, mirroring an `environments` run launch. Every name or ID must be attached to the suite. Use `environment` for exactly one; passing both is an error."
    ),
  host: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "An attached host (name or ID) to disclose for, mirroring a `host` run launch — the engine and sandbox facts come from that host's own config. Pass either a host or an environment, never both: a run targets one axis, and an environment already resolves a host."
    ),
});
export type GetEvalRunDisclosureInput = z.infer<
  typeof getEvalRunDisclosureInput
>;

export const getEvalRunDisclosureOperation: PlatformOperation<
  GetEvalRunDisclosureInput,
  PlatformEvalRunDisclosure
> = {
  name: "get_eval_run_disclosure",
  title: "Get eval run pre-run disclosure",
  description:
    "What happens to a suite run's content BEFORE you launch it: which models it calls and where they route, which LLM analyzers/judges can fire and where their evidence goes, capture/retention/region facts, and the subprocessors engaged. Read-only — never launches or gates a run. Keyed by the same destination-affecting subset a launch selects (cases/environment/environments/host); pass the same selectors you would pass to run_eval_suite so what this discloses is what that would run.",
  readOnly: true,
  permalink: noPermalink(
    "no-addressable-resource",
    "A pre-run planning read: it describes what a launch WOULD do, so there is no run to open yet."
  ),
  inputSchema: getEvalRunDisclosureInput,
  async execute(input, { client, signal, onScopeResolved }) {
    assertRunTargetSelectorsCoherent({
      environment: input.environment,
      environments: input.environments,
      host: input.host,
    });
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const caseIds = input.cases
      ? (await resolveCases(client, project, suite, input.cases, signal)).map(
          (testCase) => testCase.id
        )
      : undefined;
    const detail = await client.getEvalSuite(
      { projectId: project.id, suiteId: suite.id },
      { signal }
    );
    const selectedEnvironments = await resolveSuiteEnvironmentTargets(
      client,
      project,
      suite,
      detail,
      input.environment ? [input.environment] : input.environments ?? [],
      signal
    );
    // SAME plan resolution `run_eval_suite` uses — including its
    // exactly-one-attached-environment auto-select — so a bare call (no
    // selector at all) discloses the plan a bare launch would actually run,
    // not a suite-base derivation that could name different models. A suite
    // with SEVERAL attached targets and no selector is ambiguous for a launch
    // too, so it refuses the same way here rather than silently disclosing
    // one of them.
    const attachedEnvironmentNames = await environmentNamesFor(
      client,
      project,
      detail.environmentIds ?? [],
      signal
    );
    // `attachedHosts` IS included in this plan, and since G4c a caller can
    // actually SATISFY a host-axis ambiguity: `host` names one, exactly as
    // `run_eval_suite`'s own selector does. Before that this operation had to
    // refuse the host axis outright — the backend contract took no host
    // selector, so the only query it could have sent was the selector-less
    // suite-base derivation, which a host config's own model/harness can
    // contradict. `testSuites:getRunDisclosure` now takes `namedHostId`, so
    // the refusal is gone and the host axis is disclosed for real.
    const selectedHosts = resolveSuiteHostTargets(
      suite,
      detail,
      input.host ? [input.host] : []
    );
    const plan = computeRunTargets({
      attachedEnvironments: (detail.environmentIds ?? []).map((id) => ({
        id,
        ...(attachedEnvironmentNames.get(id)
          ? { name: attachedEnvironmentNames.get(id)! }
          : {}),
      })),
      attachedHosts: (detail.hosts ?? []).map((host) => ({
        id: host.id,
        name: host.name,
      })),
      selectedEnvironments,
      selectedHosts,
    });
    if (plan.kind === "target-required") {
      // `readOnly` wording: this operation spends nothing, and has no
      // `allAttached`. The enumeration now names attached HOSTS too, which is
      // what makes this refusal actionable on the host axis rather than a
      // dead end.
      throw operationInputError(
        targetRequiredMessage(plan, { readOnly: true })
      );
    }
    // ONE PLAN, ONE DISCLOSURE. A multi-target GROUP containing a host cannot
    // be expressed as one query: `getRunDisclosure` answers for a single
    // launch plan, and its one-axis rule refuses `namedHostId` alongside an
    // environment selector — deliberately, because a fan-out across two axes
    // has no single engine/model set to disclose. Fanning out N pre-launch
    // round trips to stitch a composite would be a different contract than
    // the one the audit stamp records, so this refuses with a reason that
    // names the actual limit (multi-target), not the retired "no host
    // selector" one.
    if (
      plan.kind === "group" &&
      plan.targets.some((target) => target.kind === "host")
    ) {
      throw operationInputError(
        "Disclosure covers ONE launch plan, and this resolves to several targets including a host — the contract answers per plan, so a multi-target group spanning hosts has no single engine or model set to disclose. Disclose one target at a time with host or environment."
      );
    }
    const disclosureEnvironmentIds =
      plan.kind === "single"
        ? plan.target?.kind === "environment"
          ? [plan.target.id]
          : []
        : plan.targets
            .filter((target) => target.kind === "environment")
            .map((target) => target.id);
    const disclosureHostId =
      plan.kind === "single" && plan.target?.kind === "host"
        ? plan.target.id
        : undefined;
    return client.getEvalRunDisclosure(
      {
        projectId: project.id,
        suiteId: suite.id,
        ...(caseIds && caseIds.length > 0 ? { caseIds } : {}),
        ...(disclosureEnvironmentIds.length === 1
          ? { environmentId: disclosureEnvironmentIds[0]! }
          : disclosureEnvironmentIds.length > 1
          ? { environmentIds: disclosureEnvironmentIds }
          : {}),
        ...(disclosureHostId ? { namedHostId: disclosureHostId } : {}),
      },
      { signal }
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
          "Server selection by name; replaces the suite's server set. Omit to leave it (and its bindings) alone."
        ),
      computerEnvironment: z
        .union([z.string().trim().min(1), z.null()])
        .optional()
        .describe(
          "Custom sandbox image the suite's eval runs boot from, by name or id (see list_sandbox_images). null uses the provider's default base image."
        ),
    })
    .optional()
    .describe(
      "Suite environment: server selection and the sandbox image runs boot from. Unspecified fields are preserved."
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
      })
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
          "Floor on per-case iterations, 1–10: every case runs at least this many times. null removes the floor."
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
              "Make the judge available on this suite. On its own this grades nothing — set autoRun (or request grading on a finished run) to make grading happen."
            ),
          model: z.string().trim().min(1).optional(),
          autoRun: z
            .boolean()
            .optional()
            .describe(
              "Grade every run automatically as it completes. This is the flag that makes LLM-as-judge grading happen; it SPENDS on each run."
            ),
          threshold: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe(
              "Advisory pass threshold, 0–1 (passed = score >= threshold)."
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
  permalink: derivePermalinks((result) => [
    { type: "eval_suite", id: result.id, ...projectIdOf(result) },
  ]),
  inputSchema: updateEvalSuiteInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: deleteEvalSuiteInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [
    { type: "eval_suite", id: result.id, ...projectIdOf(result) },
  ]),
  inputSchema: setEvalSuiteScheduleInput,
  async execute(input, { client, signal, onScopeResolved }) {
    // Disabling returns early server-side and would silently drop a pin, so an
    // environment sent with `enabled: false` never takes effect. Fail instead
    // of letting the caller believe they repointed the schedule.
    if (input.environment && !input.enabled) {
      throw operationInputError(
        "environment only applies when enabling a schedule — disabling preserves the existing pin. Re-send with enabled: true to repoint it."
      );
    }
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [
    { type: "eval_suite", id: result.id, ...projectIdOf(result) },
  ]),
  inputSchema: setEvalSuiteEnvironmentsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
      const resolved: PlatformEnvironment[] = [];
      for (const selector of input.environments) {
        try {
          resolved.push(
            resolveByIdOrName(
              page.items,
              selector,
              "Project environment",
              `project "${project.name}"`
            )
          );
          continue;
        } catch (error) {
          // Ad-hoc rows are list-hidden, so a composed cell is unresolvable
          // here — and because this is a REPLACE, that also made it impossible
          // to add one named environment alongside cells a compose attached
          // without silently detaching them. `GET /environments/:id` serves
          // them, so an id-shaped selector the listing did not know gets one
          // direct read before we report it missing.
          const trimmed = selector.trim();
          if (!looksLikeEnvironmentId(trimmed)) throw error;
          if (signal?.aborted || isAbortError(error)) throw error;
          let byId: PlatformEnvironment;
          try {
            byId = await client.getEnvironment(
              { projectId: project.id, environmentId: trimmed },
              { signal }
            );
          } catch (lookupError) {
            if (signal?.aborted || isAbortError(lookupError)) {
              throw lookupError;
            }
            // Report the ENUMERATED not-found from the listing, not this
            // lookup's bare 404 — it is the message that tells the caller what
            // they could have picked.
            throw error;
          }
          resolved.push({
            ...byId,
            name:
              typeof byId.name === "string" && byId.name.trim().length > 0
                ? byId.name
                : byId.id,
          });
        }
      }
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
  PlatformPage<PlatformEvalCaseWithSuite>
> = {
  name: "list_eval_cases",
  title: "List MCPJam eval cases",
  description:
    "List the test cases in an eval suite, with their ids and configuration.",
  readOnly: true,
  permalink: derivePermalinks((result) =>
    result.items.flatMap((testCase) => evalCaseRef(testCase, testCase.suiteId))
  ),
  inputSchema: listEvalCasesInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const page = await client.listEvalCases(
      { projectId: project.id, suiteId: suite.id },
      { signal }
    );
    return {
      ...page,
      items: page.items.map((testCase) => stampSuiteId(testCase, suite.id)),
    };
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
  PlatformEvalCaseWithSuite
> = {
  name: "get_eval_case",
  title: "Get MCPJam eval case",
  description: "Fetch one eval test case's full definition.",
  readOnly: true,
  permalink: derivePermalinks((result) => evalCaseRef(result, result.suiteId)),
  inputSchema: getEvalCaseInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const testCase = await resolveCase(
      client,
      project,
      suite,
      input.case,
      signal
    );
    return stampSuiteId(
      await client.getEvalCase(
        { projectId: project.id, suiteId: suite.id, caseId: testCase.id },
        { signal }
      ),
      suite.id
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
  PlatformEvalCaseWithSuite
> = {
  name: "create_eval_case",
  title: "Create MCPJam eval case",
  description:
    "Add one test case to an eval suite. Provide ordered `steps`: a `prompt` step is a model turn, a `toolCall` step is a deterministic tool call, and `assert` steps hold the expectations (e.g. a `toolCalledWith` or `widgetRendered` predicate). Positive cases must include at least one `assert` step.",
  readOnly: false,
  permalink: derivePermalinks((result) => evalCaseRef(result, result.suiteId)),
  inputSchema: createEvalCaseInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    return stampSuiteId(
      await client.createEvalCase(
        {
          projectId: project.id,
          suiteId: suite.id,
          body: buildCreateCaseBody(input),
        },
        { signal }
      ),
      suite.id
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
      })
    )
    .min(1)
    .max(MAX_BATCH_CREATE_CASES)
    .describe(
      `The cases to author, up to ${MAX_BATCH_CREATE_CASES} per call. Split a larger set into several calls.`
    ),
  duplicatePolicy: z
    .enum(["block", "warn", "create_anyway"])
    .optional()
    .describe(
      "What to do with a case whose definition already exists in the suite. Defaults to `block`. `warn` and `create_anyway` require `overrideReason`."
    ),
  overrideReason: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Why authoring a duplicate is intended. Recorded on the case's revision."
    ),
});
export type CreateEvalCasesInput = z.infer<typeof createEvalCasesInput>;

export const createEvalCasesOperation: PlatformOperation<
  CreateEvalCasesInput,
  CreateEvalCasesResult
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
  permalink: derivePermalinks((result) =>
    result.created.flatMap((entry) => evalCaseRef(entry, entry.suiteId))
  ),
  inputSchema: createEvalCasesInput,
  async execute(input, { client, signal, onScopeResolved }) {
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
        { status: 0 }
      );
    }
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const batch = await client.createEvalCases(
      {
        projectId: project.id,
        suiteId: suite.id,
        body: {
          cases: input.cases.map((testCase) =>
            buildCreateCaseBody(testCase as Record<string, unknown>)
          ),
          ...(input.duplicatePolicy
            ? { duplicatePolicy: input.duplicatePolicy }
            : {}),
          ...(input.overrideReason
            ? { overrideReason: input.overrideReason }
            : {}),
        },
      },
      { signal }
    );
    return {
      ...batch,
      created: batch.created.map((entry) => stampSuiteId(entry, suite.id)),
    };
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
  // UPDATE-only nullability, matching the route: PATCH accepts `null` to clear
  // the claim, create does not. `buildCaseBody` keeps `null` and drops
  // `undefined`, so clearing and leaving-alone stay distinguishable.
  import: caseFieldsShape.import
    .unwrap()
    .nullable()
    .optional()
    .describe(
      "Import provenance for a converted case: {status, sourceCaseKey?, note?}. `exact` is a CONVERTER CLAIM, not a verification, and requires a note citing the mapping rule. Pass null to clear the stored claim; omit to leave it untouched."
    ),
  // UPDATE-only nullability: absent preserves the existing label, `null`
  // clears it, and a string replaces it. This mirrors the file reconciliation
  // boundary so neither can silently conflate unlabelled with untouched.
  intent: caseIntentUpdateSchema
    .optional()
    .describe(
      "Analytics grouping label. Omit to preserve it; pass null to clear it. It never changes scoring or verdicts."
    ),
});
export type UpdateEvalCaseInput = z.infer<typeof updateEvalCaseInput>;

export const updateEvalCaseOperation: PlatformOperation<
  UpdateEvalCaseInput,
  PlatformEvalCaseWithSuite
> = {
  name: "update_eval_case",
  title: "Update MCPJam eval case",
  description:
    "Edit an eval test case. Only the fields you pass change (steps, expected output, iterations, models, match options, checks). Passing `steps` replaces the case's test-step sequence wholesale.",
  readOnly: false,
  permalink: derivePermalinks((result) => evalCaseRef(result, result.suiteId)),
  inputSchema: updateEvalCaseInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const suite = await resolveSuite(client, project, input.suite, signal);
    const testCase = await resolveCase(
      client,
      project,
      suite,
      input.case,
      signal
    );
    return stampSuiteId(
      await client.updateEvalCase(
        {
          projectId: project.id,
          suiteId: suite.id,
          caseId: testCase.id,
          body: buildCaseBody(input),
        },
        { signal }
      ),
      suite.id
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
  permalink: noPermalink("mutation-only"),
  inputSchema: deleteEvalCaseInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Retry-safety key: pass one, because generating spends model credits and a retry must not pay for a second generation. Repeating a call with the same key replays the first attempt's drafts and returns the cases it already created."
    ),
});
export type GenerateEvalCasesInput = z.infer<typeof generateEvalCasesInput>;

export const generateEvalCasesOperation: PlatformOperation<
  GenerateEvalCasesInput,
  GenerateEvalCasesResult
> = {
  name: "generate_eval_cases",
  risk: "spend",
  title: "Generate MCPJam eval cases",
  description:
    "AI-generate test cases from the suite's server tools and persist them into the suite. Connects the servers to discover tools and spends the organization's credits. For a suite with attached project environments, tools are discovered from the environment's closed server set — pass environment to choose which one. The authoring model is platform-controlled; set caseModels to choose the generated cases' execution models. IDEMPOTENT on idempotencyKey: pass one, because generating spends model credits and a retry must not pay for a second generation.",
  readOnly: false,
  permalink: derivePermalinks((result) =>
    result.created.flatMap((testCase) =>
      evalCaseRef(testCase, testCase.suiteId)
    )
  ),
  inputSchema: generateEvalCasesInput,
  async execute(input, { client, signal, onScopeResolved }) {
    assertNoServerOverrideWithEnvironment(input);
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
    const generated = await client.generateEvalCases(
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
      }
    );
    return {
      ...generated,
      created: generated.created.map((testCase) =>
        stampSuiteId(testCase, suite.id)
      ),
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

/**
 * Statuses at which a run has stopped changing.
 *
 * Mirrors the CLI's `TERMINAL_RUN_STATUSES`. A decision summary is fetched only
 * for a terminal run: while a run is still going its verdict does not exist
 * yet, so the extra request would buy a `notEstablished` a poller already knows
 * from `status`.
 */
const TERMINAL_EVAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * The diagnostics page size this operation asks for.
 *
 * Small on purpose. Each diagnostic carries a six-row chain plus evidence, and
 * a model that spent its window on page one of a 200-trial run has no room left
 * to act on it. A caller that wants more pages the cursor.
 */
const DEFAULT_MCP_DIAGNOSTICS_LIMIT = 20;

const getEvalRunInput = evalRunScopedInput.extend({
  diagnosticsCursor: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Opaque cursor from a previous response's decisionSummary.diagnostics.nextCursor, to read the next page of failure diagnostics."
    ),
  diagnosticsLimit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      `Failure diagnostics per page (default ${DEFAULT_MCP_DIAGNOSTICS_LIMIT}).`
    ),
});

export type GetEvalRunInput = z.infer<typeof getEvalRunInput>;

export type GetEvalRunResult = {
  project: SelectedProjectInfo;
  run: PlatformEvalRun;
  /**
   * The canonical decision summary, for a terminal run.
   *
   * ABSENT while the run is still going. Older API deployments are supported
   * through the shared iteration fallback; it is absent only when both the
   * canonical endpoint and the older iteration resource are unavailable.
   * Fallback assembly uses the same contract assembler as the API, so it does
   * not create a second verdict implementation.
   */
  decisionSummary?: PlatformEvalRunDecisionSummary;
};

export const getEvalRunOperation: PlatformOperation<
  GetEvalRunInput,
  GetEvalRunResult
> = {
  name: "get_eval_run",
  title: "Get MCPJam eval run",
  description:
    "Get the status, verdict, and — once the run is terminal — its `decisionSummary`: START THERE when a run did not pass. It carries the verdict and where it came from (`verdictSource`), the counts with the population they count (`measurementUnit`: caseVariant under verdict policy v2, trial on legacy runs — never assume one), the authoritative `decision` with the exact reasons a v2 run passed, failed, or was withheld as inconclusive, and per-trial `diagnostics` giving the user-value chain, the first failed stage, the failure category, the evidence for THAT stage, and one next action. `verdict: \"notEstablished\"` means no verdict exists (still running, stopped early, or undecidable) — it is not a failure. THE CHAIN, IN ORDER: connection → discovery → selection → call → response → userValue; a stage is only ever about the link it names, and the order is what makes `notReached` mean anything. Each diagnostic's `chain.status` is a THREE-WAY discriminant and only one of them carries rows: `verified` — the stored derivation validated, so `stages`, `firstFailedStage` and `failureCategory` are present and may be read; `unverified` — a derivation was stored and did not validate, so the rows and both claims derived from them are withheld deliberately (substituting your own reading of the trace for the withheld claim is the one thing this state exists to stop); `absent` — no derivation was ever stored, which is a DIFFERENT fact from one that was rejected. A row's `state` is one of five, and the three non-verdicts are three different facts that must never be collapsed: `passed` — measured, and it passed; `failed` — measured, and it failed; `notReached` — it never ran, because an earlier stage failed; `notMeasured` — this run captured nothing that could decide it; `notApplicable` — the stage does not apply to this case at all. Reporting a `notMeasured` or `notReached` stage as healthy is the misreading the five-state vocabulary exists to prevent. `firstFailedStage` IS A LOCATION, NOT A CAUSE: it names where the chain stopped, and the nearest thing to a cause is `reason` on that same stage's row. `failureCategory` is a coarse bucket, and it can be present with NO `firstFailedStage` at all — a setup abort and an evaluator error are real answers about a trial that never reached a stage. Neither the location nor the bucket on its own authorizes proposing a change to the server under test. Read authored step results (get_eval_run_steps) second and a full trace (get_eval_iteration_trace) last; you should not need to infer the chain from raw tool calls. Diagnostics are paginated: pass diagnosticsCursor to continue, and treat `diagnostics.complete: false` as a partial list, never as the full set of failures. The detail also carries an `insights` envelope with findings AGGREGATED across iterations (exemplar evidence attached); only a finding with actionTarget mcp_server AND actionability ready authorizes proposing a server change — other action targets name agent/test/environment work and must not be 'fixed' in server code.",
  readOnly: true,
  permalink: derivePermalinks((result) => [
    evalRunRef(result.run.id, result.run.suiteId, result.project?.id),
  ]),
  inputSchema: getEvalRunInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const run = await client.getEvalRun(
      { projectId: project.id, runId: input.runId },
      { signal }
    );
    if (!TERMINAL_EVAL_RUN_STATUSES.has(run.status)) {
      return { project: toSelectedProjectInfo(project), run };
    }
    // Endpoint first, then the same shared assembler over the older iteration
    // resource. MCP and CLI must not disagree merely because a deployment has
    // not rolled out the additive endpoint yet.
    const decisionSummary = await readEvalRunDecisionSummary(
      client,
      signal,
      project.id,
      run,
      {
        cursor: input.diagnosticsCursor,
        limit: input.diagnosticsLimit ?? DEFAULT_MCP_DIAGNOSTICS_LIMIT,
      }
    );
    return {
      project: toSelectedProjectInfo(project),
      run,
      ...(decisionSummary ? { decisionSummary } : {}),
    };
  },
};

const compareEvalRunInput = evalRunScopedInput.extend({
  baseRunId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Run ID to compare against. Omit to use the nearest earlier COMPLETED run in the same suite. Mutually exclusive with baseCommitSha."
    ),
  baseCommitSha: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Source commit SHA to compare against, resolved to the completed run in this suite recorded against it. Mutually exclusive with baseRunId; sending both is a 400. A SHA matching no completed run is the ordinary BASELINE_NOT_FOUND 404 — an incomplete comparison, not a regression. When the SHA matched more than one eligible run, or the bounded lookup saturated, the response reports matchCount and matchCountTruncated; an absent matchCount means the match was unambiguous."
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
    "Compare an eval run against a baseline run: per-case status (one of regressed, fixed, new_case, removed_case, changed, unchanged_passed, unchanged_failed), per-scorer pass-rate and mean deltas from the evaluation contract, and whether the evaluation config changed between them. Omit baseRunId to compare against the nearest earlier completed run in the same suite, or pass baseCommitSha to pin the baseline by source SHA instead (the two are mutually exclusive). A case whose scoreDeltas show definitionChanged was graded by a DIFFERENT scorer definition on each side — its delta is not a regression. Returns HTTP 404 NOT_FOUND with details.reason = BASELINE_NOT_FOUND when the run has no comparable predecessor; that means the comparison is incomplete, not that anything regressed.",
  readOnly: true,
  permalink: noPermalink(
    "no-addressable-resource",
    "A cross-run diff. It belongs to no single run, and the app has no compare route to address it by."
  ),
  inputSchema: compareEvalRunInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const compare = await client.compareEvalRun(
      {
        projectId: project.id,
        runId: input.runId,
        baseRunId: input.baseRunId,
        baseCommitSha: input.baseCommitSha,
      },
      { signal }
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
  permalink: noPermalink(
    "no-addressable-resource",
    "The page names its run but not the run's suite, and `/evals/suite/:suiteId/runs/:runId` needs both. Reach the run through get_eval_run."
  ),
  inputSchema: evalRunIterationsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A trace payload for one iteration; iterations have no route of their own, and the response names no suite to reach the run through."
  ),
  inputSchema: evalIterationTraceInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: evalRunScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const run = await client.cancelEvalRun(
      { projectId: project.id, runId: input.runId },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), run };
  },
};

// ── Gate waivers ─────────────────────────────────────────────────────────
//
// The agent-facing half of the gate-waiver workflow. Every description below
// states the two things an agent must not have to infer: that the reason is
// stored unredacted and durable, and that a waiver never makes a failing run
// pass — it records an override of the gate, and the run keeps its verdict.

const waiveEvalGateInput = evalRunScopedInput.extend({
  // NOT length- or emptiness-checked here, on purpose. Both refusals carry
  // copy the platform wrote for the caller (`gate_waiver_reason_empty`,
  // `gate_waiver_reason_too_long`), and a zod check firing first would replace
  // that copy with a generic validation error on exactly the boundary cases
  // where the specific message is the useful part.
  reason: z
    .string()
    .describe(
      `Why this gate is being overridden. Required, non-blank, at most ${GATE_WAIVER_MAX_REASON_LENGTH} characters, and THE RECORD of the decision. ${GATE_WAIVER_REASON_NOTICE}`
    ),
  // A number, but the range is the platform's to refuse — see `reason`.
  expiresAt: z
    .number()
    .describe(
      "When the waiver lapses, as epoch milliseconds. Must be in the future and no more than 30 days out — there is no permanent waiver. When it lapses the gate and the GitHub Check Run go back to failing."
    ),
});

export type WaiveEvalGateInput = z.infer<typeof waiveEvalGateInput>;

export type WaiveEvalGateResult = {
  project: SelectedProjectInfo;
  status: PlatformGateWaiverWriteResult["status"];
  republishedChecks: number;
  waiver: PlatformGateWaiver;
};

export const waiveEvalGateOperation: PlatformOperation<
  WaiveEvalGateInput,
  WaiveEvalGateResult
> = {
  name: "waive_eval_gate",
  title: "Waive an MCPJam eval run's gate",
  description:
    "Override a FAILING eval run's release gate, on the record, until an expiry you name. This does NOT make the run pass: the run keeps its failed result, and every surface that honors the waiver — the GitHub Check Run and the CLI's `eval gate` — says the gate was waived, by whom, why, and until when. Requires the manage tier; whoever launched the run gets no exception for having launched it. `reason` is stored UNREDACTED and readable by anyone who can see the suite, for as long as the suite exists — never put secrets, tokens, or customer data in it. `status: \"conflict\"` means a waiver was already in force and returns that EXISTING one rather than granting a second; it is a normal result, not a failure.",
  readOnly: false,
  // EXPOSURE, not `none`, even though a waiver can be revoked.
  //
  // Two things a revoke does not undo. The gate stops blocking a release the
  // moment this lands, so anything that ships in the meantime has shipped. And
  // `reason` is published UNREDACTED to everyone who can see the suite, for as
  // long as the suite exists — revoking ends the override, it does not
  // unpublish the text. Both halves are about what becomes reachable, which is
  // what this class names, and `none`'s promise of "reversible and costs
  // nothing" is false for each of them.
  risk: "exposure",
  permalink: noPermalink(
    "mutation-only",
    "Records an override of a gate. The run it covers is addressable, but this result names no suite, and `/evals/suite/:suiteId/runs/:runId` needs both."
  ),
  inputSchema: waiveEvalGateInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const result = await client.createGateWaiver(
      {
        projectId: project.id,
        runId: input.runId,
        reason: input.reason,
        expiresAt: input.expiresAt,
      },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), ...result };
  },
};

export type GetEvalGateWaiverResult = {
  project: SelectedProjectInfo;
  runId: string;
  waiver: PlatformGateWaiver | null;
};

export const getEvalGateWaiverOperation: PlatformOperation<
  EvalRunScopedInput,
  GetEvalGateWaiverResult
> = {
  name: "get_eval_gate_waiver",
  title: "Get an MCPJam eval run's gate waiver",
  description:
    "Read the waiver currently in force over an eval run's gate, or null when there is none. Available to anyone who can view the run, not only to those who can grant a waiver — a waiver its readers cannot see is not a visible one. `active: false` on a returned waiver means it has lapsed or been revoked and is no longer overriding anything.",
  readOnly: true,
  permalink: noPermalink(
    "no-addressable-resource",
    "A waiver has no page of its own, and the response names its run but not the run's suite — the same gap `list_eval_run_iterations` has. Reach the run through get_eval_run."
  ),
  inputSchema: evalRunScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const { waiver } = await client.getGateWaiver(
      { projectId: project.id, runId: input.runId },
      { signal }
    );
    return {
      project: toSelectedProjectInfo(project),
      runId: input.runId,
      waiver,
    };
  },
};

const revokeEvalGateWaiverInput = evalRunScopedInput.extend({
  waiverId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Waiver ID, as returned by waive_eval_gate or get_eval_gate_waiver."
    ),
});

export type RevokeEvalGateWaiverInput = z.infer<
  typeof revokeEvalGateWaiverInput
>;

export const revokeEvalGateWaiverOperation: PlatformOperation<
  RevokeEvalGateWaiverInput,
  WaiveEvalGateResult
> = {
  name: "revoke_eval_gate_waiver",
  title: "Revoke an MCPJam eval gate waiver",
  description:
    "End a gate waiver early, putting the gate and the GitHub Check Run back where they were. Requires the manage tier. IDEMPOTENT: `status: \"already_revoked\"` means it had already been revoked and reports the ORIGINAL revocation rather than restamping it — that is a success, not an error, and preserves the record of who actually ended the waiver. An already-expired waiver may still be revoked; the audit trail distinguishes 'this was wrong' from 'this ran out'.",
  readOnly: false,
  // `none`: it destroys no record — the row and its audit event survive, and
  // the revocation is additive — it spends nothing, and a mistaken revoke is
  // recovered by waiving again. The gate closing is the SAFE direction.
  //
  // The registry still places it at `gated` rather than the `direct` this
  // derives, and TIER_EXCEPTIONS carries the reason: re-blocking somebody
  // else's release is a decision a person should make.
  risk: "none",
  permalink: noPermalink("mutation-only"),
  inputSchema: revokeEvalGateWaiverInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const result = await client.revokeGateWaiver(
      {
        projectId: project.id,
        runId: input.runId,
        waiverId: input.waiverId,
      },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), ...result };
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
      "Grade this run even though the judge was off when it ran. A per-RUN answer, not a suite edit: grading reads the config pinned when the run was created, so turning the judge on for the suite does not reach an already-recorded run."
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
  permalink: noPermalink("mutation-only"),
  inputSchema: requestEvalRunJudgeInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
      { signal }
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
      `Project "${project.name}" does not belong to an organization, and GitHub Checks is configured per organization. Move the suite to a project in an organization, or connect the repository from the app.`
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
      "Project name or ID. Only used to select the ORGANIZATION whose connected repositories are listed."
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
  permalink: noPermalink(
    "external-resource",
    "GitHub repositories and their check configuration; the rows are GitHub's, not MCPJam app pages."
  ),
  inputSchema: listEvalCheckReposInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const checks = await client.listEvalCheckRepos(
      { organizationId: checkRepoOrganizationOrThrow(project) },
      { signal }
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
      "Repository as owner/repo. Must be one list_eval_check_repos reports as connectable — the MCPJam GitHub App has to be installed on it."
    ),
  outagePolicy: z
    .enum(["fail_open", "fail_closed"])
    .describe(
      "What the pull-request check reports when MCPJam cannot conclude: fail_open passes it, fail_closed fails it. Required — ask the user which they want rather than choosing for them; fail_closed blocks merges during an MCPJam outage, fail_open lets an unverified change through."
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
  permalink: noPermalink(
    "external-resource",
    "Binds a GitHub repository to the project's checks; the resource named is GitHub's."
  ),
  inputSchema: connectEvalCheckRepoInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
      { signal }
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A step-level projection of one iteration; the response names no suite to reach the run through."
  ),
  inputSchema: evalRunStepsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  signal: AbortSignal | undefined
): Promise<PlatformEvalCase[]> {
  const page = await client.listEvalCases(
    { projectId: project.id, suiteId: suite.id },
    { signal }
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
      `suite "${suite.name ?? suite.id}"`
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
  signal: AbortSignal | undefined
): Promise<PlatformEvalCase> {
  const [testCase] = await resolveCases(
    client,
    project,
    suite,
    [selector],
    signal
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A tunnel grant is a short-lived credential for a local process, not a durable resource with an app page."
  ),
  inputSchema: createTunnelInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: closeTunnelInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) =>
    result.items.map((scenario) => ({
      type: "user_testing_scenario" as const,
      id: scenario.id,
      projectId: result.project?.id,
      label: `Open ${scenario.name}`,
    }))
  ),
  inputSchema: projectScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const page = await client.listScenarios(
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
  permalink: derivePermalinks((result) => [
    {
      type: "user_testing_scenario",
      id: result.scenario.id,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: scenarioScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const page = await client.listScenarios(
      { projectId: project.id },
      { signal }
    );
    const match = resolveByIdOrName(
      page.items,
      input.scenario,
      "Scenario",
      `project "${project.name}"`
    );
    const scenario = await client.getScenario(
      { projectId: project.id, scenarioId: match.id },
      { signal }
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
  permalink: derivePermalinks((result) =>
    result.items.map((session) => ({
      type: "chat_session" as const,
      id: session.id,
      ...projectIdOf(session),
      ...(session.title ? { label: `Open ${session.title}` } : {}),
    }))
  ),
  inputSchema: listChatSessionsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    // Unlike the project-scoped reads, no default project is applied: the
    // unfiltered listing (personal + project-shared sessions) is the API's
    // own default and the more useful answer for "what was I working on?".
    // Trim again for raw execute() callers who bypass the schema — a blank
    // selector must mean "unfiltered", never silently the default project.
    const projectSelector = input.project?.trim();
    const project = projectSelector
      ? (
          await resolveProjectOrThrow(
            { client, signal, onScopeResolved },
            projectSelector
          )
        ).project
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

// ── Agent Playground ────────────────────────────────────────────────────────
//
// The one place a machine caller can DRIVE a conversation against a project's
// MCP servers rather than launching a run and reading the result afterwards.
// `send_chat_message` is the turn; the two reads resolve what it produced.
//
// The reads are DIRECT-tier while `list_chat_sessions` / `search_sessions`
// stay excluded from the agent surface, and that is not an inconsistency.
// Those two ENUMERATE other people's conversations. These take an id the
// caller either produced themselves or was handed by a human, which is a
// different claim: "show me the session I just created" is not "show me what
// everyone in this org has been talking about".

const sendChatMessageInput = z.object({
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "REQUIRED, and must be STABLE for the intent behind this turn — not a fresh id per attempt. This call spends model credits; with a stable key a timed-out retry replays the completed turn instead of running and billing it again."
    ),
  message: z
    .string()
    .min(1)
    .max(8000)
    .describe("The message to send, as the user."),
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Project name or ID. Required to START a session; ignored when continuing one, which takes its project from the session."
    ),
  sessionId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Continue this session. Omit to start a new one. Use the sessionId a previous turn returned."
    ),
  modelId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Provider-prefixed model id, e.g. "anthropic/claude-sonnet-5". Required on a first turn. A bare id is REJECTED rather than guessed, because an unprefixed id is indistinguishable from a local Ollama model.'
    ),
  environmentId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Run against this project environment's servers. Mutually exclusive with serverIds. First turn only."
    ),
  serverIds: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Run against these project servers. Mutually exclusive with environmentId. First turn only."
    ),
  systemPrompt: z.string().max(8000).optional().describe("First turn only."),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("First turn only — pinned to the session and reused thereafter."),
  maxSteps: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .describe("Maximum engine steps for this turn."),
  toolMode: z
    .enum(["read_only", "auto"])
    .optional()
    .describe(
      'Default "read_only": only tools the server annotated readOnlyHint:true are advertised. "auto" advertises everything and MAY CAUSE REAL SIDE EFFECTS through arbitrary third-party tools. The hint is server-asserted, so read_only is a policy, not a guarantee. First turn only.'
    ),
  allowedServerIds: z
    .array(z.string().trim().min(1))
    .max(20)
    .optional()
    .describe(
      "Narrow THIS TURN to a subset of the target's servers. An EMPTY array narrows to none and is rejected — omit the field to use the whole target. Per-turn, not pinned: re-send it on every turn you want narrowed. The response reports advertisedToolCount/excludedToolCount so the effective surface is never a guess."
    ),
  allowedTools: z
    .array(z.string().trim().min(1))
    .max(100)
    .optional()
    .describe(
      "Advertise only these tool names, for THIS TURN. An EMPTY array advertises no tools at all — the same request as maxToolCalls:0. Per-turn, not pinned: re-send it on every turn you want narrowed."
    ),
  maxToolCalls: z
    .number()
    .int()
    .min(0)
    .max(16)
    .optional()
    .describe(
      "Cap the tool calls this turn may make, enforced at DISPATCH rather than by bounding steps (one step can emit several parallel calls). 0 advertises no tools at all. Per-turn."
    ),
});

export type SendChatMessageInput = z.infer<typeof sendChatMessageInput>;

export const sendChatMessageOperation: PlatformOperation<
  SendChatMessageInput,
  PlatformChatTurn
> = {
  name: "send_chat_message",
  title: "Send one agent Playground message",
  description:
    "Send one message to a project's MCP servers and get the model's reply PLUS the telemetry a participant could not see: which tools ran, with what arguments, what each returned, per-call latency, and token usage. Pass the returned sessionId back to continue the conversation. SPENDS model credits per call. Configuration (model, target, system prompt, tool mode) pins on the first turn; a continuation that resends it is refused. Tools default to read_only; toolMode:'auto' may cause real external side effects.",
  readOnly: false,
  // Unknowable upstream of the call in the SAME sense `call_server_tool` is:
  // under `auto` this executes arbitrary third-party tools, and softening the
  // destructive default would claim a safety the host cannot verify.
  mayBeDestructive: true,
  risk: "spend",
  // `projectId` off the RESULT, not the resolved scope: a continuation skips
  // `resolveProjectOrThrow` on purpose (see `execute`), so there is no scope
  // receipt to fall back on and the link would be dropped after every
  // successful continuation — silently, since a permalink that cannot be
  // built is reported and skipped rather than thrown.
  permalink: derivePermalinks((result) =>
    result.sessionId
      ? [
          {
            type: "chat_session",
            id: result.sessionId,
            projectId: result.projectId,
          },
        ]
      : []
  ),
  inputSchema: sendChatMessageInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const projectSelector = input.project?.trim();
    // A continuation takes its project from the session — resolving one here
    // would make an unnecessary call and let a caller name a project the
    // session is not in.
    const projectId =
      !input.sessionId && projectSelector
        ? (
            await resolveProjectOrThrow(
              { client, signal, onScopeResolved },
              projectSelector
            )
          ).project.id
        : undefined;
    return client.sendChatMessage(
      {
        idempotencyKey: input.idempotencyKey,
        message: input.message,
        ...(projectId ? { projectId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        ...(input.serverIds ? { serverIds: input.serverIds } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
        ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        ...(input.toolMode ? { toolMode: input.toolMode } : {}),
        ...(input.allowedServerIds
          ? { allowedServerIds: input.allowedServerIds }
          : {}),
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.maxToolCalls !== undefined
          ? { maxToolCalls: input.maxToolCalls }
          : {}),
      },
      { signal }
    );
  },
};

const getChatSessionInput = z.object({
  sessionId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The session id returned by send_chat_message or list_chat_sessions."
    ),
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional project scope. When given, a session in another project answers as not found."
    ),
  afterMessageIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Start the window at this ABSOLUTE transcript index — the same index trace spans reference."
    ),
  limit: z.number().int().min(1).max(200).optional(),
});

export type GetChatSessionInput = z.infer<typeof getChatSessionInput>;

export const getChatSessionOperation: PlatformOperation<
  GetChatSessionInput,
  PlatformChatSessionDetail
> = {
  name: "get_chat_session",
  title: "Read a chat session's messages",
  description:
    "Return a session's metadata plus a bounded window of its raw messages, indexed by ABSOLUTE transcript position. The companion to get_chat_session_trace: spans reference messages by index, so resolving a span to the payload that produced it needs both. A transcript that could not be read reports transcriptUnavailable and a null messageCount rather than an empty conversation.",
  readOnly: true,
  permalink: derivePermalinks((result) => [
    { type: "chat_session", id: result.sessionId, ...projectIdOf(result) },
  ]),
  inputSchema: getChatSessionInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const projectSelector = input.project?.trim();
    const projectId = projectSelector
      ? (
          await resolveProjectOrThrow(
            { client, signal, onScopeResolved },
            projectSelector
          )
        ).project.id
      : undefined;
    return client.getChatSession(
      {
        sessionId: input.sessionId,
        ...(projectId ? { projectId } : {}),
        ...(input.afterMessageIndex !== undefined
          ? { afterMessageIndex: input.afterMessageIndex }
          : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      { signal }
    );
  },
};

const getChatSessionTraceInput = z.object({
  sessionId: z.string().trim().min(1).describe("The session id to trace."),
  project: z.string().trim().min(1).optional(),
  turnId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Return exactly this turn. Mutually exclusive with afterPromptIndex."
    ),
  afterPromptIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Page forward from this turn index. Mutually exclusive with turnId."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("How many turns to return. Defaults to 1 — the latest."),
  includeSpans: z
    .boolean()
    .optional()
    .describe(
      "Set false for cheap per-turn summaries (no span payloads) when deciding which turn to pull."
    ),
});

export type GetChatSessionTraceInput = z.infer<typeof getChatSessionTraceInput>;

export const getChatSessionTraceOperation: PlatformOperation<
  GetChatSessionTraceInput,
  PlatformChatSessionTrace
> = {
  name: "get_chat_session_trace",
  title: "Read a chat session's execution trace",
  description:
    "Return per-turn execution spans for a session: per-tool-call latency, token usage, and indices into the transcript. INCREMENTAL — returns the LATEST turn by default, not the whole session; use turnId or afterPromptIndex for older turns and includeSpans:false for summaries. A turn whose spans could not be read reports spansUnavailable rather than an empty span list, because 'made no calls' and 'could not fetch' are opposite conclusions.",
  readOnly: true,
  permalink: noPermalink(
    "no-addressable-resource",
    "A span-level trace projection; the response names turns, not the session id the Sessions feed opens on."
  ),
  inputSchema: getChatSessionTraceInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const projectSelector = input.project?.trim();
    const projectId = projectSelector
      ? (
          await resolveProjectOrThrow(
            { client, signal, onScopeResolved },
            projectSelector
          )
        ).project.id
      : undefined;
    return client.getChatSessionTrace(
      {
        sessionId: input.sessionId,
        ...(projectId ? { projectId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.afterPromptIndex !== undefined
          ? { afterPromptIndex: input.afterPromptIndex }
          : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.includeSpans !== undefined
          ? { includeSpans: input.includeSpans }
          : {}),
      },
      { signal }
    );
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
      "What to search. 'titles' (default) matches session titles and first messages across the whole corpus; 'transcripts' matches what was actually said inside conversations."
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
      "Restrict to these session surfaces. Omit to search all available surfaces."
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
      "Opaque pagination cursor from a previous response. Page with the same query and scope you opened with."
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
  permalink: responsePermalinks((result) =>
    // BACKEND-minted. The server owns the fallback rules for a session whose
    // surface-native page does not exist (an eval Quick Run, a session whose
    // parent run was deleted); re-deriving them here would be a second copy
    // that drifts the first time one of those rules changes.
    result.items.map((session) => ({
      path: session.link.path,
      url: session.link.url,
      label: "Open session",
      resource: { type: "chat_session" as const, id: session.chatSessionId },
      ...projectIdOf(session),
    }))
  ),
  inputSchema: searchSessionsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    // Re-checked here, not just in the schema: `execute()` is called directly
    // by surfaces that never parse the schema (the CLI binding, raw callers).
    // The endpoint treats a blank `q` as an EMPTY SEARCH — so a blank query
    // reaching it would return the project's recency feed, which this
    // operation promises never to do.
    const query = input.query?.trim() ?? "";
    if (query.length === 0) {
      throw operationInputError(
        "query is required — search_sessions searches, it does not list."
      );
    }

    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
      { signal }
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
        { status: 0 }
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

// ── Clients ─────────────────────────────────────────────────────────────────
//
// A **Client** is the product noun: a named, reusable configuration that
// defines how MCPJam connects to and talks to your MCP servers.
//
// Every config-affecting write here is COMPARE-AND-SET. `expectedConfigId` is
// the `configId` the caller last read; because the config is content-addressed,
// the same id means byte-identical settings, so this is a precise "I composed
// my edit against exactly this" claim rather than a revision counter's "nothing
// happened since". A rename takes a SEPARATE `expectedName` token, because a
// rename does not rotate the config and config identity is therefore blind to
// a concurrent one.
//
// The deprecated `*_host` operations at the end of this section keep their old
// names, inputs and DTOs for existing embedders. They are NOT in
// `ALL_OPERATIONS`, so no registered surface can mint a proposal or a tool
// under an old name.

const CLIENT_SELECTOR_DESCRIPTION = "Client name or ID.";

const EXPECTED_CONFIG_ID_DESCRIPTION =
  "The `configId` you last read for this client (from get_client). Required for any config edit: if the client changed since, the write is rejected with a conflict instead of overwriting the other edit — re-read and retry.";

const EXPECTED_NAME_DESCRIPTION =
  "The `name` you last read for this client (from get_client). Required whenever you send `name`: a rename does not change the config, so `expectedConfigId` cannot detect a concurrent rename.";

const EXPECTED_IMPACT_DESCRIPTION =
  "The `impact` you last read for this client. Optional, and checked transactionally when sent: if a consumer was added or removed since, the write conflicts rather than affecting more than you were told it would.";

const clientImpactSchema = z.object({
  liveEnvironmentCount: z.number().int().min(0),
  scenarioAttachmentCount: z.number().int().min(0),
  activeLegacyJourneyCount: z.number().int().min(0),
});

/**
 * Resolve a client selector to its detail.
 *
 * Delegates the name/ID question to `getClient`, which the canonical route
 * answers server-side. The old `resolveHost` listed the project's clients and
 * scanned them here, which meant this file owned a second opinion about
 * ambiguity and about which rows are eligible — and no opinion at all about the
 * private User Testing backing rows the server hides.
 */
async function resolveClient(
  client: PlatformApiClient,
  project: PlatformProject,
  selector: string,
  signal: AbortSignal | undefined
): Promise<PlatformClientDetail> {
  return client.getClient(
    { projectId: project.id, client: selector },
    { signal }
  );
}

export type ListClientsResult = {
  project: SelectedProjectInfo;
  items: PlatformClient[];
  otherProjects: ProjectInfo[];
};

export const listClientsOperation: PlatformOperation<
  ProjectScopedInput,
  ListClientsResult
> = {
  name: "list_clients",
  title: "List MCPJam clients",
  description:
    "List the clients saved in an MCPJam project — the named, reusable configurations that define how MCPJam connects to and talks to your MCP servers. Returns each client's `configId`, which every write takes as a concurrency token. If no project is specified, uses the most recently updated accessible project and returns other project names for switching.",
  readOnly: true,
  permalink: derivePermalinks((result) =>
    result.items.map((host) => ({
      type: "host" as const,
      id: host.id,
      projectId: result.project?.id,
      label: `Open ${host.name}`,
    }))
  ),
  inputSchema: projectScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const page = await client.listClients(
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

const getClientInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  client: z.string().trim().min(1).describe(CLIENT_SELECTOR_DESCRIPTION),
});
export type GetClientInput = z.infer<typeof getClientInput>;

export const getClientOperation: PlatformOperation<
  GetClientInput,
  PlatformClientDetail
> = {
  name: "get_client",
  title: "Show an MCPJam client",
  description:
    "Show one client's full settings: its resolved config (model, capabilities, host context), its `configId` — the token every edit must echo back as `expectedConfigId` — and `impact`, the live environments, scenario attachments and active legacy journeys a config edit would follow. Call this before any edit.",
  readOnly: true,
  permalink: derivePermalinks((result) => [{ type: "host", id: result.id }]),
  inputSchema: getClientInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    return resolveClient(client, project, input.client, signal);
  },
};

const createClientInput = z
  .object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    name: z.string().trim().min(1).describe("Display name for the new client."),
    template: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Built-in template to seed the client config from (e.g. claude, chatgpt, cursor)."
      ),
    theme: z
      .enum(["light", "dark"])
      .optional()
      .describe("Theme stamped into the seeded config (template only)."),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Full client config v2 to use verbatim (alternative to template). Must pin a non-empty `modelId`."
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
export type CreateClientInput = z.infer<typeof createClientInput>;

export const createClientOperation: PlatformOperation<
  CreateClientInput,
  PlatformClientDetail
> = {
  name: "create_client",
  title: "Create an MCPJam client",
  description:
    "Create a client in a project, either from a built-in template (`template`, optional `theme`) or from a full config (`config`, which must pin a non-empty `modelId`). Returns the created client. Purely additive — nothing that exists is changed.",
  readOnly: false,
  // ADDITIVE. Nothing that exists is overwritten or removed, so the honest
  // annotation is the non-destructive one — and it is what separates this from
  // update_client, which replaces settings that are currently in force.
  risk: "none",
  permalink: derivePermalinks((result) => [{ type: "host", id: result.id }]),
  inputSchema: createClientInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const body: Record<string, unknown> = { name: input.name };
    if (input.template) {
      body.template = input.template;
      if (input.theme) body.theme = input.theme;
    }
    if (input.config) body.config = input.config;
    return client.createClient({ projectId: project.id, body }, { signal });
  },
};

/**
 * The PARTIAL edit block, mirroring the route's `set` schema field for field.
 *
 * Absent means keep. `null` means "make it go away" — a required field resets
 * to its canonical default, an optional one clears to absent — and `modelId`
 * accepts neither `null` nor a blank string, because a client that pins a model
 * must not be editable into one that doesn't.
 *
 * Object-valued fields are WHOLE-OBJECT replacements. To change a deep knob
 * (say `mcpProfile.apps.sandbox.csp.mode`), read the client, overlay that
 * sub-object on what `get_client` returned, and send the whole object back.
 */
const clientFieldSet = z
  .object({
    modelId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Model the client pins. Value only — there is no null, and a blank string is refused."
      ),
    systemPrompt: z
      .string()
      .nullable()
      .optional()
      .describe('null resets to the default: "".'),
    temperature: z
      .number()
      .finite()
      .nullable()
      .optional()
      .describe("null resets to the default: 0.7."),
    requireToolApproval: z
      .boolean()
      .nullable()
      .optional()
      .describe("null resets to the default: false."),
    connectionDefaults: z
      .object({
        headers: z.record(z.string(), z.string()),
        requestTimeout: z.number().finite(),
      })
      .nullable()
      .optional()
      .describe(
        "Whole-object replacement. null resets to the platform defaults."
      ),
    respectToolVisibility: z
      .boolean()
      .nullable()
      .optional()
      .describe("null clears the host-level opt-in."),
    progressiveToolDiscovery: z
      .boolean()
      .nullable()
      .optional()
      .describe("null clears the host-level opt-in."),
    harness: z
      .enum(["claude-code", "codex"])
      .nullable()
      .optional()
      .describe(
        "Execution runtime. null clears it (back to emulated). Setting one needs the matching feature flag; clearing never does."
      ),
    computer: z
      .object({
        kind: z.literal("personal"),
        toolset: z.literal("bash").optional(),
        workdir: z.string().optional(),
      })
      .nullable()
      .optional()
      .describe("null detaches the computer."),
    builtInToolIds: z
      .array(z.string().trim().min(1))
      .nullable()
      .optional()
      .describe("Whole-list replacement. null clears it."),
    skillSelection: z
      .union([
        z.object({ mode: z.literal("all-visible") }),
        z.object({
          mode: z.literal("explicit"),
          skillIds: z.array(z.string().trim().min(1)),
        }),
      ])
      .nullable()
      .optional()
      .describe("null clears the selection policy."),
    modelVisibleMcpToolResults: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe("Whole-object replacement. null clears it."),
    mcpToolResultImageRendering: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe("Whole-object replacement. null clears it."),
    mcpProfile: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe("Whole-object replacement. null clears it."),
    hostCapabilitiesOverride: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe("Whole-object replacement. null clears it."),
    chatUiOverride: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe("Whole-object replacement. null clears it."),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "`set` must name at least one field to change.",
  });

const updateClientInput = z
  .object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    client: z.string().trim().min(1).describe(CLIENT_SELECTOR_DESCRIPTION),
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("New display name for the client."),
    expectedName: z
      .string()
      .min(1)
      .optional()
      .describe(EXPECTED_NAME_DESCRIPTION),
    expectedConfigId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(EXPECTED_CONFIG_ID_DESCRIPTION),
    expectedImpact: clientImpactSchema
      .optional()
      .describe(EXPECTED_IMPACT_DESCRIPTION),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Whole-config replacement. Prefer `set` — a full round-trip composed from a stale read reverts whatever landed in between."
      ),
    set: clientFieldSet
      .optional()
      .describe(
        "Named fields to change, applied over the client's current config inside the write transaction."
      ),
  })
  // Mirrors the route's 400s exactly, so an agent is refused by the schema with
  // the same sentence the route would have used rather than discovering the
  // rule from a failed call.
  .superRefine((value, ctx) => {
    if (value.config !== undefined && value.set !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide either `config` (whole-config replacement) or `set` (named fields), not both.",
      });
      return;
    }
    if (
      value.config === undefined &&
      value.set === undefined &&
      value.name === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Provide at least one of `name`, `config`, or `set` to edit.",
      });
      return;
    }
    if (
      (value.config !== undefined || value.set !== undefined) &&
      value.expectedConfigId === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedConfigId"],
        message:
          "`expectedConfigId` is required for a config edit: call get_client and send back the `configId` it returned.",
      });
    }
    if (value.name !== undefined && value.expectedName === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedName"],
        message:
          "`expectedName` is required for a rename: call get_client and send back the `name` it returned.",
      });
    }
  });
export type UpdateClientInput = z.infer<typeof updateClientInput>;

export const updateClientOperation: PlatformOperation<
  UpdateClientInput,
  PlatformClientDetail
> = {
  name: "update_client",
  title: "Update an MCPJam client",
  description:
    "Edit a client's display name and/or its config. Use `set` to change named fields (absent keeps, null resets or clears); `config` replaces the whole config. Requires `expectedConfigId` for a config edit and `expectedName` for a rename — call get_client first, echo those values back, and on a conflict re-read and retry. An edit that resolves to byte-identical settings writes nothing.",
  readOnly: false,
  // OVERWRITE, so `destructive` — the taxonomy is "removes or invalidates
  // something that existed", and replacing a live setting does exactly that.
  // Not because it is unrecoverable in the way a delete is: the previous config
  // row survives in the version trail. But there is no public restore
  // operation today, so calling this reversible on an agent surface would be a
  // promise nothing here can keep.
  risk: "destructive",
  permalink: derivePermalinks((result) => [{ type: "host", id: result.id }]),
  inputSchema: updateClientInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.expectedName !== undefined)
      body.expectedName = input.expectedName;
    if (input.expectedConfigId !== undefined) {
      body.expectedConfigId = input.expectedConfigId;
    }
    if (input.expectedImpact !== undefined) {
      body.expectedImpact = input.expectedImpact;
    }
    if (input.config !== undefined) body.config = input.config;
    if (input.set !== undefined) body.set = input.set;
    return client.updateClient(
      { projectId: project.id, client: input.client, body },
      { signal }
    );
  },
};

const deleteClientInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  client: z.string().trim().min(1).describe(CLIENT_SELECTOR_DESCRIPTION),
});
export type DeleteClientInput = z.infer<typeof deleteClientInput>;

export const deleteClientOperation: PlatformOperation<
  DeleteClientInput,
  PlatformClientDeleted
> = {
  name: "delete_client",
  title: "Delete an MCPJam client",
  description:
    "Permanently delete a client from a project. This cannot be undone.",
  readOnly: false,
  risk: "destructive",
  permalink: noPermalink("mutation-only"),
  inputSchema: deleteClientInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    return client.deleteClient(
      {
        projectId: project.id,
        client: input.client,
        // The v1 delete contract is bodyless — the route rejects any field.
        body: {},
      },
      { signal }
    );
  },
};

const setClientServersInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  client: z.string().trim().min(1).describe(CLIENT_SELECTOR_DESCRIPTION),
  serverIds: z.array(z.string().trim().min(1)).describe("Required server IDs."),
  optionalServerIds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("Optional server IDs enabled for this client."),
  expectedConfigId: z
    .string()
    .trim()
    .min(1)
    .describe(EXPECTED_CONFIG_ID_DESCRIPTION),
  expectedImpact: clientImpactSchema
    .optional()
    .describe(EXPECTED_IMPACT_DESCRIPTION),
});
export type SetClientServersInput = z.infer<typeof setClientServersInput>;

export const setClientServersOperation: PlatformOperation<
  SetClientServersInput,
  PlatformClientDetail
> = {
  name: "set_client_servers",
  title: "Set an MCPJam client's servers",
  description:
    "Replace the required and optional saved-server attachments for a client. This is a REPLACEMENT, not an addition — servers you omit are detached. Requires `expectedConfigId` from get_client, so two concurrent server changes cannot silently lose one.",
  readOnly: false,
  // Same reasoning as update_client, and more plainly: a replacement list
  // DETACHES every server it omits.
  risk: "destructive",
  permalink: derivePermalinks((result) => [{ type: "host", id: result.id }]),
  inputSchema: setClientServersInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    return client.setClientServers(
      {
        projectId: project.id,
        client: input.client,
        serverIds: input.serverIds,
        optionalServerIds: input.optionalServerIds,
        expectedConfigId: input.expectedConfigId,
        ...(input.expectedImpact
          ? { expectedImpact: input.expectedImpact }
          : {}),
      },
      { signal }
    );
  },
};

const duplicateClientInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  client: z.string().trim().min(1).describe(CLIENT_SELECTOR_DESCRIPTION),
  name: z.string().trim().min(1).optional().describe("Name for the copy."),
});
export type DuplicateClientInput = z.infer<typeof duplicateClientInput>;

export const duplicateClientOperation: PlatformOperation<
  DuplicateClientInput,
  PlatformClientDetail
> = {
  name: "duplicate_client",
  title: "Duplicate an MCPJam client",
  description:
    "Create a new client carrying the selected client's current config. The source is untouched.",
  readOnly: false,
  // ADDITIVE, like create_client: it mints a row and changes nothing existing.
  risk: "none",
  permalink: derivePermalinks((result) => [{ type: "host", id: result.id }]),
  inputSchema: duplicateClientInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    return client.duplicateClient(
      { projectId: project.id, client: input.client, name: input.name },
      { signal }
    );
  },
};

// ── Hosts (deprecated compatibility operations) ──────────────────────────────
//
// Kept executable, with their old names, inputs and `PlatformHost*` DTOs, for
// embedders holding a reference to one. They are deliberately ABSENT from
// `ALL_OPERATIONS`, which is what every registered surface partitions: the MCP
// catalog, the agent registry, the in-app toolset and the CLI bindings can
// therefore never advertise an old name, and no proposal row can ever persist
// under one.
//
// Each still calls the deprecated `/hosts` route rather than delegating to its
// client sibling, because the two routes return different shapes and a delegate
// would change what an existing caller receives.

/** @deprecated Use {@link listClientsOperation}. */
export type ListHostsResult = {
  project: SelectedProjectInfo;
  items: PlatformHost[];
  otherProjects: ProjectInfo[];
};

/** @deprecated Use {@link listClientsOperation}. */
export const listHostsOperation: PlatformOperation<
  ProjectScopedInput,
  ListHostsResult
> = {
  name: "list_hosts",
  title: "List MCPJam hosts",
  description:
    "Deprecated: use list_clients. Lists the clients saved in an MCPJam project under their old name and DTO.",
  readOnly: true,
  permalink: derivePermalinks((result) =>
    result.items.map((host) => ({
      type: "host" as const,
      id: host.id,
      projectId: result.project?.id,
      label: `Open ${host.name}`,
    }))
  ),
  inputSchema: projectScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const page = await client.listHosts({ projectId: project.id }, { signal });
    return {
      project: toSelectedProjectInfo(project),
      items: page.items,
      otherProjects: toOtherProjects(sortedProjects, project.id),
    };
  },
};

/**
 * Resolve a host selector the OLD way — list and scan.
 *
 * Retained only for the deprecated operations below, which must keep behaving
 * exactly as they did. The canonical operations resolve server-side; see
 * `resolveClient`.
 */
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

const HOST_SELECTOR_DESCRIPTION = "Host name or ID.";

const getHostInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  host: z.string().trim().min(1).describe(HOST_SELECTOR_DESCRIPTION),
});
/** @deprecated Use {@link GetClientInput}. */
export type GetHostInput = z.infer<typeof getHostInput>;

/** @deprecated Use {@link getClientOperation}. */
export const getHostOperation: PlatformOperation<
  GetHostInput,
  PlatformHostDetail
> = {
  name: "get_host",
  title: "Show an MCPJam host",
  description:
    "Deprecated: use get_client, which also returns the `configId` every edit takes and the impact a config edit would follow.",
  readOnly: true,
  permalink: derivePermalinks((result) => [{ type: "host", id: result.id }]),
  inputSchema: getHostInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const host = await resolveHost(client, project, input.host, signal);
    return client.getHost(
      { projectId: project.id, hostId: host.id },
      { signal }
    );
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
/** @deprecated Use {@link UpdateClientInput}. */
export type UpdateHostInput = z.infer<typeof updateHostInput>;

/** @deprecated Use {@link updateClientOperation}, which is compare-and-set. */
export const updateHostOperation: PlatformOperation<
  UpdateHostInput,
  PlatformHostDetail
> = {
  name: "update_host",
  title: "Update an MCPJam host",
  description:
    "Deprecated: use update_client, which supports partial `set` edits and requires a concurrency token. This one replaces the whole config with no token, so it can silently revert a concurrent edit.",
  readOnly: false,
  risk: "destructive",
  permalink: derivePermalinks((result) => [{ type: "host", id: result.id }]),
  inputSchema: updateHostInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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

const createHostInput = z
  .object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    name: z.string().trim().min(1).describe("Display name for the new host."),
    template: z.string().trim().min(1).optional(),
    theme: z.enum(["light", "dark"]).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
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
/** @deprecated Use {@link CreateClientInput}. */
export type CreateHostInput = z.infer<typeof createHostInput>;

/** @deprecated Use {@link createClientOperation}. */
export const createHostOperation: PlatformOperation<
  CreateHostInput,
  PlatformHostDetail
> = {
  name: "create_host",
  title: "Create an MCPJam host",
  description: "Deprecated: use create_client.",
  readOnly: false,
  risk: "none",
  permalink: derivePermalinks((result) => [{ type: "host", id: result.id }]),
  inputSchema: createHostInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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

const deleteHostInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  host: z.string().trim().min(1).describe(HOST_SELECTOR_DESCRIPTION),
});
/** @deprecated Use {@link DeleteClientInput}. */
export type DeleteHostInput = z.infer<typeof deleteHostInput>;

/** @deprecated Use {@link deleteClientOperation}. */
export const deleteHostOperation: PlatformOperation<
  DeleteHostInput,
  PlatformHostDeleted
> = {
  name: "delete_host",
  title: "Delete an MCPJam host",
  description: "Deprecated: use delete_client. This cannot be undone.",
  readOnly: false,
  risk: "destructive",
  permalink: noPermalink("mutation-only"),
  inputSchema: deleteHostInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
/** @deprecated Use {@link SetClientServersInput}. */
export type SetHostServersInput = z.infer<typeof setHostServersInput>;

/** @deprecated Use {@link setClientServersOperation}. */
export const setHostServersOperation: PlatformOperation<
  SetHostServersInput,
  PlatformHostDetail
> = {
  name: "set_host_servers",
  title: "Set an MCPJam host's servers",
  description:
    "Deprecated: use set_client_servers, which requires a concurrency token.",
  readOnly: false,
  risk: "destructive",
  permalink: derivePermalinks((result) => [{ type: "host", id: result.id }]),
  inputSchema: setHostServersInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
/** @deprecated Use {@link DuplicateClientInput}. */
export type DuplicateHostInput = z.infer<typeof duplicateHostInput>;

/** @deprecated Use {@link duplicateClientOperation}. */
export const duplicateHostOperation: PlatformOperation<
  DuplicateHostInput,
  PlatformHostDetail
> = {
  name: "duplicate_host",
  title: "Duplicate an MCPJam host",
  description: "Deprecated: use duplicate_client.",
  readOnly: false,
  risk: "none",
  permalink: derivePermalinks((result) => [{ type: "host", id: result.id }]),
  inputSchema: duplicateHostInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  const trimmedSelector = selector.trim();
  // Ad-hoc rows are list-hidden. GET /environments/:id serves them, so an
  // id-shaped selector tries that first — otherwise `eval run --environment`,
  // `environments get`, and schedule pins cannot name a minted cell.
  if (looksLikeEnvironmentId(trimmedSelector)) {
    try {
      const byId = await client.getEnvironment(
        { projectId: project.id, environmentId: trimmedSelector },
        { signal }
      );
      return {
        ...byId,
        name:
          typeof byId.name === "string" && byId.name.trim().length > 0
            ? byId.name
            : byId.id,
      };
    } catch (error) {
      // The fast path is an OPTIMIZATION, so its failure must never be worse
      // than not having taken it: fall through to the list, which resolves
      // names, still finds live ids, and produces the enumerated not-found
      // message. Only a caller-requested abort propagates — retrying that as
      // a second request would ignore the cancellation.
      if (signal?.aborted || isAbortError(error)) {
        throw error;
      }
    }
  }
  const page = await client.listEnvironments(
    { projectId: project.id, includeArchived: true },
    { signal }
  );
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
  permalink: derivePermalinks((result) =>
    result.items.map((environment) => ({
      type: "project_environment" as const,
      id: environment.id,
      projectId: environment.projectId,
      label: `Open ${environment.name}`,
    }))
  ),
  inputSchema: listEnvironmentsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A deployment-compatibility probe, not a resource."
  ),
  inputSchema: environmentCapabilitiesInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [environmentRef(result)]),
  inputSchema: environmentSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A resolution preview — what an environment WOULD resolve to for a run. The environment itself is addressable through get_project_environment."
  ),
  inputSchema: environmentSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [environmentRef(result)]),
  inputSchema: createEnvironmentInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
      "Host (name or ID) the composed stack runs as — the client whose configuration the run is stamped with."
    ),
  serverGroup: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Standalone server group to pin (by ID). Omit to use the host's own servers."
    ),
  server: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Singular alias for `servers`."),
  servers: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe(SERVERS_SELECTOR_DESCRIPTION),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Model to run instead of the host's pinned one. Stored verbatim — pass exactly the id the provider request should carry."
    ),
  computer: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Sandbox image (name or ID) to pin, so runs boot a fresh computer from it. Must be project-shared; promote a personal draft first."
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
}).superRefine(refineComposeServerSelectors);
export type EnsureAdhocEnvironmentInput = z.infer<
  typeof ensureAdhocEnvironmentInput
>;

export type EnsureAdhocEnvironmentResult = {
  project: SelectedProjectInfo;
  environment: PlatformAdhocEnvironment;
  /** False when this stack had already been composed — see the op description. */
  created: boolean;
};

/** How many `name (n)` variants to try before giving up on a colliding name. */
const SERVER_GROUP_NAME_ATTEMPTS = 5;

/**
 * `server`/`servers` are two spellings of one axis, and `serverGroup` is the
 * already-resolved form of the same thing — so at most one may be set. Shared
 * by both compose schemas (a function declaration, so it is in scope for the
 * run-target schema declared far above `composeStackFields`).
 */
function refineComposeServerSelectors(
  value: { server?: string; servers?: string[]; serverGroup?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.server !== undefined && value.servers !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["servers"],
      message: "Provide either `server` or `servers`, not both.",
    });
  }
  if (
    value.serverGroup !== undefined &&
    (value.server !== undefined || value.servers !== undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["serverGroup"],
      message:
        "Provide either `serverGroup` (an existing group ID) or `server`/`servers` (which resolve to one), not both.",
    });
  }
}

/** Order-independent set equality over two id lists. */
function sameServerSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((id) => left.has(id));
}

/**
 * A stable, human-readable name for a group minted from server selectors.
 *
 * Sorted so the name does not depend on the order the selectors were typed —
 * `--compose-server A B` and `--compose-server B A` describe one group and
 * should not mint two.
 */
function composeServerGroupName(servers: PlatformProjectServer[]): string {
  return [...servers]
    .map((server) => server.name)
    .sort((a, b) => a.localeCompare(b))
    .join(" + ");
}

/**
 * Resolve server selectors to a pinned server group, creating one if no
 * existing group already holds exactly that set.
 *
 * Reuse is matched on CONTENT, not name, because the environment fingerprint
 * keys on the group's ID: two same-content groups mint two ad-hoc
 * environments, and a group a live environment pins cannot be deleted. So
 * minting one per run would accumulate undeletable near-duplicates and defeat
 * the content-addressing that makes re-composing a stack free.
 *
 * A name collision means someone already has a DIFFERENT group under the name
 * we derived. We re-list before suffixing because the likeliest cause is a
 * concurrent identical compose that won the race — reusing its group is the
 * whole point. Only when the name is genuinely taken by other content do we
 * suffix.
 */
async function resolveComposeServerGroup(
  client: PlatformApiClient,
  project: PlatformProject,
  selectors: string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  // Reuses the run-server resolver: same name-or-id rules, same up-front
  // refusal of stdio/URL-less servers the hosted runner could never connect.
  const servers = await resolveRunServers(client, project, selectors, signal);
  const wanted = servers.map((server) => server.id);

  const findMatch = async () => {
    let page;
    try {
      page = await client.listServerGroups(
        { projectId: project.id },
        { signal }
      );
    } catch (error) {
      // A deployment that predates the server-group routes answers 404 for the
      // ROUTE, which would otherwise surface as a bare "not found" naming
      // nothing the caller can act on. `--compose-server-group` still works
      // there, so say so rather than leaving them to guess.
      if (error instanceof PlatformApiError && error.status === 404) {
        throw resolutionError(
          "This deployment does not support --compose-server yet. Create a server group in the app and pass it with --compose-server-group <id>.",
        );
      }
      throw error;
    }
    return page.items.find((group) => sameServerSet(group.serverIds, wanted));
  };

  const existing = await findMatch();
  if (existing) return existing.id;

  const baseName = composeServerGroupName(servers);
  for (let attempt = 1; attempt <= SERVER_GROUP_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? baseName : `${baseName} (${attempt})`;
    try {
      const created = await client.createServerGroup(
        {
          projectId: project.id,
          body: { name, serverIds: wanted },
        },
        { signal },
      );
      return created.id;
    } catch (error) {
      if (!(error instanceof PlatformApiError) || error.status !== 409) {
        throw error;
      }
      const raced = await findMatch();
      if (raced) return raced.id;
    }
  }

  throw resolutionError(
    `Could not create a server group named "${baseName}": that name and ${
      SERVER_GROUP_NAME_ATTEMPTS - 1
    } numbered variants are already taken by groups holding different servers. Rename one, or pass an existing group with --compose-server-group.`,
  );
}

/**
 * Rewrite a stack's `server`/`servers` selectors into the `serverGroup` the
 * rest of the pipeline already understands.
 *
 * Deliberately separate from `resolveComposeStack`, which run composition
 * calls once PER MODEL CELL: doing the list-and-maybe-create in there would
 * repeat it per cell and let a fan-out race itself into a name conflict.
 * Callers run this once, up front.
 */
async function materializeComposeServers<
  T extends { serverGroup?: string; server?: string; servers?: string[] },
>(
  client: PlatformApiClient,
  project: PlatformProject,
  stack: T,
  signal: AbortSignal | undefined,
): Promise<T> {
  // Both refinement rules are repeated below, not just the group one: the
  // schemas only run for callers that PARSE their input, and a direct
  // `execute()` caller passing both would otherwise have one selector
  // silently dropped and spend a run against the wrong servers.
  if (stack.server !== undefined && stack.servers !== undefined) {
    throw operationInputError(
      "Provide either `server` or `servers`, not both."
    );
  }
  const selectors = stack.servers ?? (stack.server ? [stack.server] : []);
  if (selectors.length === 0) return stack;
  if (stack.serverGroup !== undefined) {
    throw operationInputError(
      "Provide either `serverGroup` (an existing group ID) or `server`/`servers` (which resolve to one), not both.",
    );
  }
  const serverGroup = await resolveComposeServerGroup(
    client,
    project,
    selectors,
    signal
  );
  const { server: _server, servers: _servers, ...rest } = stack;
  return { ...rest, serverGroup } as T;
}

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
    skills?: PlatformEnvironmentSkillSelection;
    pluginVersionIds?: string[];
  },
  signal: AbortSignal | undefined
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
  permalink: noPermalink(
    "no-addressable-resource",
    "An ad-hoc cell is a throwaway that never enters the project's environment list, so `/environments/:environmentId` would not find it. Promote it with name_environment first."
  ),
  inputSchema: ensureAdhocEnvironmentInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const stack = await materializeComposeServers(
      client,
      project,
      input,
      signal
    );
    const body = await resolveComposeStack(client, project, stack, signal);
    const ensured = await client.ensureAdhocEnvironment(
      { projectId: project.id, body },
      { signal }
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
      "The ad-hoc environment to promote, by ID (an unnamed environment has no name to select it by)."
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
      "Display name for the promoted environment. Must be unique among the project's live environments."
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
  permalink: derivePermalinks((result) => [environmentRef(result)]),
  inputSchema: nameEnvironmentInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [environmentRef(result)]),
  inputSchema: updateEnvironmentInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [environmentRef(result)]),
  inputSchema: environmentRevisionInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [environmentRef(result)]),
  inputSchema: environmentRevisionInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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

// ── Cloud Skills ─────────────────────────────────────────────────────────────
//
// Read-only, for the same reason as plugins: authoring is a project-admin app
// flow. These exist because skill IDs are load-bearing on this very surface —
// `set_eval_suite_environments`, an environment's `skillSelection`, and the
// CLI's `--compose-skill` all demand one — and before this there was no
// programmatic way to obtain one. The answer was "open the web app", which is
// not an answer an unattended caller can act on.

const listProjectSkillsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
});
export type ListProjectSkillsInput = z.infer<typeof listProjectSkillsInput>;

export type ListProjectSkillsResult = {
  project: SelectedProjectInfo;
  items: PlatformProjectSkill[];
  otherProjects: ProjectInfo[];
};

export const listProjectSkillsOperation: PlatformOperation<
  ListProjectSkillsInput,
  ListProjectSkillsResult
> = {
  name: "list_project_skills",
  title: "List MCPJam project skills",
  description:
    'List the Cloud Skills visible to you in an MCPJam project — the project-shared ones plus your own personal drafts. Use this to obtain the skill IDs that environments pin via skillSelection and that eval runs pin via --compose-skill. Only `sharing: "project"` skills can be pinned; each row\'s `pinnability` says whether that skill is eligible and, if not, why.',
  readOnly: true,
  permalink: noPermalink(
    "route-not-addressable",
    "The app's /skills surface selects a skill as component state, so there is no skills/:skillId route to open one of these rows at."
  ),
  inputSchema: listProjectSkillsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const page = await client.listProjectSkills(
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

const getProjectSkillInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  skillId: z
    .string()
    .trim()
    .min(1)
    .describe("Skill ID, from list_project_skills."),
});
export type GetProjectSkillInput = z.infer<typeof getProjectSkillInput>;

export type GetProjectSkillResult = {
  project: SelectedProjectInfo;
  skill: PlatformProjectSkillDetail;
};

export const getProjectSkillOperation: PlatformOperation<
  GetProjectSkillInput,
  GetProjectSkillResult
> = {
  name: "get_project_skill",
  title: "Get an MCPJam project skill",
  description:
    "Read one Cloud Skill, including its SKILL.md body. Useful for confirming which body a skill currently holds before pinning it into a run — the body is mutable and an edit overwrites the previous one in place, so `aggregateHash` is the only handle on which version you are looking at.",
  readOnly: true,
  permalink: noPermalink(
    "route-not-addressable",
    "The app's /skills surface selects a skill as component state, so there is no skills/:skillId route to open this row at."
  ),
  inputSchema: getProjectSkillInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const skill = await client.getProjectSkill(
      { projectId: project.id, skillId: input.skillId },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), skill };
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
  permalink: derivePermalinks((result) =>
    result.items.map((plugin) => ({
      type: "project_plugin" as const,
      id: plugin.id,
      projectId: plugin.projectId,
      label: `Open ${plugin.displayName ?? plugin.name}`,
    }))
  ),
  inputSchema: listProjectPluginsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A version read that resolves no project — it takes a global pluginVersionId — so there is no `?project=` to scope a link with. Reach the plugin through list_project_plugins."
  ),
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `computer/images/:imageId` route: sandbox images are selected inside /computer as component state."
  ),
  inputSchema: projectScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `computer/images/:imageId` route: sandbox images are selected inside /computer as component state."
  ),
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `computer/images/:imageId` route: sandbox images are selected inside /computer as component state."
  ),
  inputSchema: createImageInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `computer/images/:imageId` route: sandbox images are selected inside /computer as component state."
  ),
  inputSchema: updateImageInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A blueprint lint result; nothing was created to open."
  ),
  inputSchema: validateImageBlueprintInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `computer/images/:imageId` route: sandbox images are selected inside /computer as component state."
  ),
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A build log listing; builds have no route of their own."
  ),
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `computer/images/:imageId` route: sandbox images are selected inside /computer as component state."
  ),
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: projectScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: imageSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [
    { type: "project_server", id: result.id, ...projectIdOf(result) },
  ]),
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
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [
    { type: "project_server", id: result.id, ...projectIdOf(result) },
  ]),
  inputSchema: projectServerSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [
    { type: "project_server", id: result.id, ...projectIdOf(result) },
  ]),
  inputSchema: projectServerSelectorInput.extend({ body: serverWriteBody }),
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: projectServerSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/journeys/:journeyId` route: journeys are edited inside the Swarms surface as component state."
  ),
  inputSchema: listJourneysInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project, sortedProjects } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) =>
    result.items.map((run) => ({
      type: "journey_run" as const,
      id: run.id,
      projectId: run.projectId,
    }))
  ),
  inputSchema: journeyRunsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
    "One journey run in full: status, per-target rollups, and the per-session attempt records. This is what to poll after launching a run — status leaves 'running' once every attempt has settled. The detail carries an `insights` envelope: findings AGGREGATED over the run's wave with exemplar sessions, plus runHealth for launch outcomes (which are never findings — a rate-limited target is not a broken server). Only actionTarget mcp_server with actionability ready authorizes proposing a server change.",
  readOnly: true,
  permalink: derivePermalinks((result) => [
    {
      type: "journey_run",
      id: result.run.id,
      projectId: result.run.projectId,
    },
  ]),
  inputSchema: journeyRunSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) =>
    result.items.map((session) => ({
      type: "chat_session" as const,
      id: session.chatSessionId,
      projectId: session.projectId,
    }))
  ),
  inputSchema: journeyRunSessionsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [
    {
      type: "journey_run",
      id: result.run.id,
      projectId: result.run.projectId,
    },
  ]),
  inputSchema: launchJourneyRunInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: journeyRunSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
      "Project environment id to publish (or unpublish). One scenario per environment."
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
      "Scenario name. CREATE-TIME ONLY — ignored on a republish of an already-published environment (rename with update_user_testing_scenario)."
    ),
  description: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "Scenario description. CREATE-TIME ONLY — ignored on a republish."
    ),
  mode: z
    .enum(["project_members", "invited_only", "anyone_with_link"])
    .optional()
    .describe(
      "Who may open the share link: project_members (signed-in project members only), invited_only (named members, invited individually), anyone_with_link (anyone holding the URL). CREATE-TIME ONLY — ignored on a republish; change an existing scenario's mode with update_user_testing_scenario."
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
  permalink: derivePermalinks((result) => [
    // The scenario's own page. `result.scenario.link` is the token-bearing
    // GUEST share link — a backend-minted product capability, not a permalink,
    // and untouched by this policy.
    {
      type: "user_testing_scenario",
      id: result.scenario.id,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: publishScenarioInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
      { signal }
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
  permalink: noPermalink("mutation-only"),
  inputSchema: scenarioSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/personas/:personaId` route: personas are edited inside the Swarms surface as component state."
  ),
  inputSchema: listPersonasInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/personas/:personaId` route: personas are edited inside the Swarms surface as component state."
  ),
  inputSchema: personaSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/personas/:personaId` route: personas are edited inside the Swarms surface as component state."
  ),
  inputSchema: createPersonaInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/personas/:personaId` route: personas are edited inside the Swarms surface as component state."
  ),
  inputSchema: updatePersonaInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: personaSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const persona = await client.deletePersona(
      { projectId: project.id, personaId: input.persona },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), persona };
  },
};

// ── Project secrets ─────────────────────────────────────────────────────────
//
// WRITE-ONLY. No operation here returns a value, and none can: the DTO has no
// such field and the backend has no code path that produces one.
//
// `create_secret` and `update_secret` are excluded from the MCP catalog and the
// agent registry (see `platformTools.ts` and `agent-op-registry.ts`), because
// their input CARRIES the value — it would transit model context and be written
// into chat transcripts before any approval could run. They stay reachable over
// HTTP, the SDK and the CLI, where the caller controls where the value comes
// from.

const secretSelectorInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  secret: z.string().trim().min(1).describe("Secret id."),
});

const SECRET_NAME_DESCRIPTION =
  "Environment-variable name — uppercase letters, digits and underscores, not starting with a digit (STRIPE_API_KEY). This IS the secret's identity: it is what a materialized delivery exports and what a workflow references, and it is immutable (renaming means delete and recreate).";

const SECRET_DELIVERY_DESCRIPTION =
  "How the value reaches a run. 'brokered' (prefer this): the sandbox's egress proxy injects it as a request header OUTSIDE the VM, so the box never holds it and a prompt-injected agent has nothing to exfiltrate — but it prevents EXTRACTION, not USE (any process in the box can call the bound host while the policy is live), and it works for HTTPS APIs only. 'materialized': a real environment variable inside the box, which is the only thing a CLI can read — EXTRACTABLE BY DESIGN, `env` prints it.";

const SECRET_SHARING_DESCRIPTION =
  "'project' (default) — admin-managed, delivered to every member's sessions. 'user' — personal, delivered ONLY in sessions its owner starts and silently absent from anyone else's run of the same environment. Immutable.";

const secretBrokerFields = {
  brokerHosts: z
    .array(z.string().trim().min(1).max(253))
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Brokered only, and required for it: the exact hostnames the header is injected on (api.stripe.com). No scheme, no port, no wildcard — the proxy matches a host, and a URL would install a rule that silently never fires."
    ),
  brokerHeader: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Brokered only, and required for it: the header name, e.g. Authorization."
    ),
  brokerTemplate: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Brokered only, and required for it: the header value, with {} where the secret goes — 'Bearer {}'. A template without {} is rejected: it would install a constant header that never carries the credential."
    ),
} as const;

export type ListSecretsInput = z.infer<typeof listSecretsInput>;
const listSecretsInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
});

export type ListSecretsResult = {
  project: SelectedProjectInfo;
  items: PlatformSecret[];
};

export const listSecretsOperation: PlatformOperation<
  ListSecretsInput,
  ListSecretsResult
> = {
  name: "list_secrets",
  title: "List MCPJam project secrets",
  description:
    "The project's credentials, as METADATA ONLY — name, delivery mode, host binding, sharing, when each was last delivered. No value is ever returned by this or any other operation. Shows the project-shared secrets plus your own personal ones; another member's personal secret does not appear at all. Read this to find out what an environment can grant before selecting one.",
  readOnly: true,
  permalink: noPermalink(
    "route-not-addressable",
    "Secrets are managed inside the project settings surface as component state; there is no `secrets/:secretId` route."
  ),
  inputSchema: listSecretsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const page = await client.listSecrets(
      { projectId: project.id },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), items: page.items };
  },
};

export type GetSecretInput = z.infer<typeof secretSelectorInput>;
export type GetSecretResult = {
  project: SelectedProjectInfo;
  secret: PlatformSecret;
};

export const getSecretOperation: PlatformOperation<
  GetSecretInput,
  GetSecretResult
> = {
  name: "get_secret",
  title: "Get one MCPJam project secret",
  description:
    "One secret's metadata: delivery mode, host binding, sharing, and when it was last handed to a run. NEVER its value. Note that lastDeliveredAt means delivered, not used — brokered use is unobservable to us by construction, since the proxy injects the header and we never see the request.",
  readOnly: true,
  permalink: noPermalink(
    "route-not-addressable",
    "Secrets are managed inside the project settings surface as component state; there is no `secrets/:secretId` route."
  ),
  inputSchema: secretSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const secret = await client.getSecret(
      { projectId: project.id, secretId: input.secret },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), secret };
  },
};

const createSecretInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  name: z.string().trim().min(1).max(64).describe(SECRET_NAME_DESCRIPTION),
  value: z
    .string()
    .min(1)
    .max(64 * 1024)
    .describe(
      "The credential itself. IT BECOMES VISIBLE TO WHATEVER SURFACE CARRIES THIS CALL — it travels in the request body, so it passes through that surface's process, logs, shell history and any transcript it keeps. Read it from a file, an environment variable or stdin rather than typing it into an argument. It is stored encrypted and no operation ever returns it."
    ),
  description: z
    .string()
    .max(500)
    .optional()
    .describe(
      "What this credential is for, so a teammate does not have to guess."
    ),
  delivery: z
    .enum(["brokered", "materialized"])
    .describe(SECRET_DELIVERY_DESCRIPTION),
  ...secretBrokerFields,
  sharing: z
    .enum(["user", "project"])
    .optional()
    .describe(SECRET_SHARING_DESCRIPTION),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Retry key. Pass one: a retried create without it fails as a name conflict with the row the first attempt already made, which is indistinguishable from a real collision."
    ),
});

export type CreateSecretInput = z.infer<typeof createSecretInput>;
export type CreateSecretResult = {
  project: SelectedProjectInfo;
  secret: PlatformSecret;
};

export const createSecretOperation: PlatformOperation<
  CreateSecretInput,
  CreateSecretResult
> = {
  name: "create_secret",
  title: "Create an MCPJam project secret",
  description:
    "Store a credential a workflow needs (a stripe CLI run, gh, psql) so environments can grant it to runs. THE VALUE TRAVELS IN THIS CALL and becomes visible to whatever surface makes it — its process, its logs, its transcript — so supply it from a file or an environment variable, not from something a human typed into a chat. Choose delivery deliberately: 'brokered' keeps the value outside the sandbox, 'materialized' puts it inside as an environment variable where a CLI can read it and anything in the box can print it. The response is metadata only.",
  readOnly: false,
  risk: "exposure",
  permalink: noPermalink("mutation-only"),
  inputSchema: createSecretInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const secret = await client.createSecret(
      {
        projectId: project.id,
        name: input.name,
        value: input.value,
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        delivery: input.delivery,
        ...(input.brokerHosts !== undefined
          ? { brokerHosts: input.brokerHosts }
          : {}),
        ...(input.brokerHeader !== undefined
          ? { brokerHeader: input.brokerHeader }
          : {}),
        ...(input.brokerTemplate !== undefined
          ? { brokerTemplate: input.brokerTemplate }
          : {}),
        ...(input.sharing !== undefined ? { sharing: input.sharing } : {}),
      },
      {
        signal,
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      }
    );
    return { project: toSelectedProjectInfo(project), secret };
  },
};

const updateSecretInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(PROJECT_SELECTOR_DESCRIPTION),
  secret: z.string().trim().min(1).describe("Secret id."),
  value: z
    .string()
    .min(1)
    .max(64 * 1024)
    .optional()
    .describe(
      "The new credential — a ROTATION. Same exposure as on create: it travels in this call and becomes visible to whatever surface makes it. Reaches NEW RUNS ONLY; a session already running holds the old value and cannot be reached mid-run."
    ),
  description: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe(
      "Replacement description. `null` CLEARS it; omit to leave it unchanged. The tri-state matches the REST route and the SDK client, which have accepted `null` since this resource shipped — without it here, an operation caller could set a description and then never remove it."
    ),
  delivery: z
    .enum(["brokered", "materialized"])
    .optional()
    .describe(
      `${SECRET_DELIVERY_DESCRIPTION} Switching to 'brokered' requires supplying the host binding in the same call; switching to 'materialized' clears it.`
    ),
  ...secretBrokerFields,
});

export type UpdateSecretInput = z.infer<typeof updateSecretInput>;
export type UpdateSecretResult = {
  project: SelectedProjectInfo;
  secret: PlatformSecret;
};

export const updateSecretOperation: PlatformOperation<
  UpdateSecretInput,
  UpdateSecretResult
> = {
  name: "update_secret",
  title: "Rotate or re-bind an MCPJam project secret",
  description:
    "Rotate a secret's value and/or change how it is delivered. THE NEW VALUE TRAVELS IN THIS CALL, with the same exposure as create. A rotation reaches NEW RUNS ONLY — a session already running holds the old value, in its box's environment or inside an egress policy that cannot be read back, and there is no safe way to replace it mid-run. `name` and `sharing` cannot be changed: renaming would break the workflows referencing the environment variable, and re-sharing would change who has already been handed the value. Delete and recreate for either.",
  readOnly: false,
  risk: "exposure",
  permalink: noPermalink("mutation-only"),
  inputSchema: updateSecretInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const secret = await client.updateSecret(
      {
        projectId: project.id,
        secretId: input.secret,
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
        ...(input.brokerHosts !== undefined
          ? { brokerHosts: input.brokerHosts }
          : {}),
        ...(input.brokerHeader !== undefined
          ? { brokerHeader: input.brokerHeader }
          : {}),
        ...(input.brokerTemplate !== undefined
          ? { brokerTemplate: input.brokerTemplate }
          : {}),
      },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), secret };
  },
};

export type DeleteSecretInput = z.infer<typeof secretSelectorInput>;
export type DeleteSecretResult = {
  project: SelectedProjectInfo;
  secret: PlatformSecretDeleted;
};

export const deleteSecretOperation: PlatformOperation<
  DeleteSecretInput,
  DeleteSecretResult
> = {
  name: "delete_secret",
  title: "Delete an MCPJam project secret",
  description:
    "Delete a stored credential. HARD — the row and the encrypted value both go, and MCPJam stops resolving and delivering it. Deliberately NOT blocked when an environment still selects it: refusing would leave a leaked credential undeletable until someone edited every environment naming it, and deletion must never wait on cleanup. TWO LIMITS, both important when responding to a leak: runs already in flight keep the value they were handed, and this does NOT revoke the credential at the provider that issued it — the key stays valid until it is rotated or revoked there.",
  readOnly: false,
  risk: "destructive",
  permalink: noPermalink("mutation-only"),
  inputSchema: secretSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const secret = await client.deleteSecret(
      { projectId: project.id, secretId: input.secret },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), secret };
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/journeys/:journeyId` route: journeys are edited inside the Swarms surface as component state."
  ),
  inputSchema: journeySelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/journeys/:journeyId` route: journeys are edited inside the Swarms surface as component state."
  ),
  inputSchema: createJourneyInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/journeys/:journeyId` route: journeys are edited inside the Swarms surface as component state."
  ),
  inputSchema: updateJourneyInput,
  async execute(input, { client, signal, onScopeResolved }) {
    requireConfigPair(input);
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: journeySelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/definitions/:swarmId` route. `/swarms/:swarmId` reads as a launched WAVE — SwarmRunDetail resolves it against the project's runs — so a saved swarm's id there renders an empty run detail rather than the definition."
  ),
  inputSchema: listPersonasInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/definitions/:swarmId` route. `/swarms/:swarmId` reads as a launched WAVE — SwarmRunDetail resolves it against the project's runs — so a saved swarm's id there renders an empty run detail rather than the definition."
  ),
  inputSchema: swarmSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/definitions/:swarmId` route. `/swarms/:swarmId` reads as a launched WAVE — SwarmRunDetail resolves it against the project's runs — so a saved swarm's id there renders an empty run detail rather than the definition."
  ),
  inputSchema: createSwarmInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/definitions/:swarmId` route. `/swarms/:swarmId` reads as a launched WAVE — SwarmRunDetail resolves it against the project's runs — so a saved swarm's id there renders an empty run detail rather than the definition."
  ),
  inputSchema: updateSwarmInput,
  async execute(input, { client, signal, onScopeResolved }) {
    requireConfigPair(input);
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: swarmSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/personas/:personaId` route: personas are edited inside the Swarms surface as component state."
  ),
  inputSchema: generatePersonasInput,
  async execute(input, { client, signal, onScopeResolved }) {
    requireExactlyOneGrounding(input);
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "route-not-addressable",
    "No `swarms/journeys/:journeyId` route: journeys are edited inside the Swarms surface as component state."
  ),
  inputSchema: generateJourneysInput,
  async execute(input, { client, signal, onScopeResolved }) {
    requireExactlyOneGrounding(input);
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A cross-swarm aggregate; it belongs to no single swarm."
  ),
  inputSchema: listPersonasInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [
    {
      type: "journey_run",
      id: result.scorecard.runId,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: journeyRunSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "Findings are rows inside a run's insights panel with no addressable route of their own."
  ),
  inputSchema: listPersonasInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: findingSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: findingSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [
    // A wave IS a journey run on the Swarms surface: `/swarms/<waveId>`.
    {
      type: "journey_run",
      id: result.insights.waveId,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: waveSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: requestWaveInsightsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: waveSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "What this organization may do — a policy read, not a resource."
  ),
  inputSchema: listPersonasInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) => [
    {
      type: "user_testing_scenario",
      id: result.scenario.id,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: userTestingScenarioSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const scenario = await client.getUserTestingScenario(
      { projectId: project.id, scenarioId: input.scenario },
      { signal }
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
  permalink: derivePermalinks((result) => [
    {
      type: "user_testing_scenario",
      id: result.scenario.id,
      projectId: result.project?.id,
    },
  ]),
  inputSchema: updateUserTestingScenarioInput,
  async execute(input, { client, signal, onScopeResolved }) {
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
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) =>
    result.items.map((session) => ({
      type: "chat_session" as const,
      id: session.chatSessionId,
      projectId: result.project?.id,
    }))
  ),
  inputSchema: listUserTestingSessionsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) =>
    result.session.chatSessionId
      ? [
          {
            type: "chat_session" as const,
            id: result.session.chatSessionId,
            projectId: result.project?.id,
          },
        ]
      : []
  ),
  inputSchema: getUserTestingSessionInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "An aggregate over a scenario's sessions; the numbers are not a resource."
  ),
  inputSchema: userTestingMetricsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "An aggregate over a scenario's usage; the numbers are not a resource."
  ),
  inputSchema: userTestingScenarioSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "Findings are rows inside a scenario's insights panel with no addressable route of their own."
  ),
  inputSchema: userTestingScenarioSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A derived signal summary, not a resource."
  ),
  inputSchema: userTestingScenarioSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "no-addressable-resource",
    "A derived insights payload, not a resource."
  ),
  inputSchema: userTestingWindowInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: requestUserTestingInsightsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: userTestingWindowInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: userTestingFindingInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: userTestingFindingInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: setGuestExecutionInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "mutation-only",
    "Mints a NEW guest share link and invalidates the old one. That link is a backend-owned product capability with its own delivery, not a permalink."
  ),
  inputSchema: userTestingScenarioSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: upsertUserTestingMemberInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink("mutation-only"),
  inputSchema: removeUserTestingMemberInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: noPermalink(
    "mutation-only",
    "Repoints a scenario at another environment and returns an opaque receipt that names no id to address."
  ),
  inputSchema: rebindUserTestingScenarioInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
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
  permalink: derivePermalinks((result) =>
    // The saved server, once one exists. The connection's own `handoffUrl` is
    // a private, single-use authorization continuation — not a permalink, and
    // deliberately outside this selector: its existing delivery is unchanged.
    result.server
      ? [
          {
            type: "project_server" as const,
            id: result.server.id,
            ...(result.projectId ? { projectId: result.projectId } : {}),
            label: `Open ${result.server.name}`,
          },
        ]
      : []
  ),
  inputSchema: connectProjectServerInput,
  async execute(input, { client, signal, onScopeResolved }) {
    // Resolve a NAMED project to an id, but only when one was supplied.
    // `resolveProject`'s no-selector arm falls back to the most recently
    // updated project, and silently adopting that here would connect a server
    // to whichever project the caller happened to touch last. Absent means
    // absent: the request becomes `awaiting_project` and a human chooses.
    let projectId: string | undefined;
    if (input.project) {
      const { project } = await resolveProjectOrThrow(
        { client, signal, onScopeResolved },
        input.project
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
  permalink: derivePermalinks((result) =>
    result.server
      ? [
          {
            type: "project_server" as const,
            id: result.server.id,
            ...(result.projectId ? { projectId: result.projectId } : {}),
            label: `Open ${result.server.name}`,
          },
        ]
      : []
  ),
  inputSchema: getProjectServerConnectionStatusInput,
  async execute(input, { client, signal }) {
    return await client.getServerConnection(
      { connectionRequestId: input.connectionRequestId },
      { signal }
    );
  },
};

/**
 * Stop one connection request.
 *
 * The counterpart the flow was missing. A request holds one of the owner's
 * concurrent-connection slots for its full hour, so an attempt the user has
 * abandoned — a link opened in the wrong browser, a consent screen they closed
 * — is not merely untidy: enough of them and the owner cannot start the next
 * one. Cancelling is idempotent, so a caller that is unsure may simply call it.
 */
export const cancelProjectServerConnectionOperation: PlatformOperation<
  GetProjectServerConnectionStatusInput,
  PlatformServerConnection
> = {
  name: "cancel_project_server_connection",
  title: "Cancel a server connection",
  description:
    "Cancel a pending server connection request started by connect_project_server, releasing the concurrent-connection slot it holds. Already-finished requests are left as they are. Use this when an authorization was abandoned and the user wants to start over.",
  // Same reading as `cancel_readiness_run`: a write, so it declares its risk,
  // but one that STOPS work. It spends nothing and destroys no record — the
  // request it ends is an authorization nobody completed.
  readOnly: false,
  risk: "none",
  permalink: derivePermalinks((result) =>
    result.server
      ? [
          {
            type: "project_server" as const,
            id: result.server.id,
            ...(result.projectId ? { projectId: result.projectId } : {}),
            label: `Open ${result.server.name}`,
          },
        ]
      : []
  ),
  inputSchema: getProjectServerConnectionStatusInput,
  async execute(input, { client, signal }) {
    return await client.cancelServerConnection(
      { connectionRequestId: input.connectionRequestId },
      { signal }
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
  permalink: noPermalink(
    "no-addressable-resource",
    "Share configuration for a run, not a resource with a page."
  ),
  inputSchema: shareResourceSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const settings = await client.getShareSettings(
      {
        projectId: project.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      },
      { signal }
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
  permalink: noPermalink("mutation-only"),
  inputSchema: setShareModeInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const settings = await client.setShareMode(
      {
        projectId: project.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        mode: input.mode,
        allowGuestAccess: input.allowGuestAccess,
      },
      { signal }
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
  permalink: noPermalink(
    "mutation-only",
    "Mints a NEW token-bearing share link and invalidates the old one. That link is a backend-owned product capability with its own delivery, not a permalink."
  ),
  inputSchema: shareResourceSelectorInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const settings = await client.rotateShareLink(
      {
        projectId: project.id,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      },
      { signal }
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
  signal: AbortSignal | undefined
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
      { signal }
    );
    if (!server.useOAuth || !server.url) return nextSteps;
    const connection = await client.createServerConnection(
      { body: { url: server.url, projectId, serverId } },
      { signal }
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
  permalink: noPermalink(
    "external-resource",
    "Third-party directory rows. Nothing is in the caller's project until it is installed."
  ),
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
      { signal }
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
  permalink: noPermalink(
    "external-resource",
    "A third-party directory entry. Nothing is in the caller's project until it is installed."
  ),
  inputSchema: getRegistryDirectoryServerInput,
  async execute(input, { client, signal }) {
    if (input.catalogServerId) {
      return client.getRegistryDirectoryServer(
        { catalogServerId: input.catalogServerId },
        { signal }
      );
    }
    return client.getRegistryDirectoryServer(
      { name: input.name!, source: input.source },
      { signal }
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
  permalink: noPermalink(
    "external-resource",
    "Upstream directory sources and their sync status."
  ),
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
  permalink: noPermalink(
    "external-resource",
    "Global/organization registry rows. A row becomes a project resource only once installed — see list_registry_connections."
  ),
  inputSchema: z.object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    scope: z.enum(["global", "organization", "all"]).optional(),
  }),
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const page = await client.listRegistryServers(
      { projectId: project.id, scope: input.scope ?? "all" },
      { signal }
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
  permalink: derivePermalinks((result) =>
    result.items.map((connection) => ({
      type: "project_server" as const,
      id: connection.serverId,
      ...projectIdOf(connection),
      ...(connection.serverName
        ? { label: `Open ${connection.serverName}` }
        : {}),
    }))
  ),
  inputSchema: projectScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const page = await client.listRegistryConnections(
      { projectId: project.id },
      { signal }
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
  permalink: derivePermalinks((result) => [
    // No project id in the install receipt — this one rides the operation's
    // resolved-scope receipt, which is exactly the case it exists for.
    {
      type: "project_server",
      id: result.serverId,
      label: `Open ${result.serverName}`,
    },
  ]),
  inputSchema: z.object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    catalogServerId: z.string().trim().min(1),
    endpointUrl: z
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
      .optional(),
    expectedContentHash: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Freshness pin from get_registry_directory_server."),
  }),
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const installed = await client.installRegistryDirectoryServer(
      {
        projectId: project.id,
        catalogServerId: input.catalogServerId,
        endpointUrl: input.endpointUrl,
        expectedContentHash: input.expectedContentHash,
      },
      { signal }
    );
    return {
      ...installed,
      nextSteps: await nextStepsForInstall(
        client,
        project.id,
        installed.serverId,
        installed.outcome,
        signal
      ),
    };
  },
};

export const installRegistryServerOperation: PlatformOperation<
  {
    project?: string;
    registryServerId: string;
    endpointUrl?: string;
    expectedUpdatedAt?: number;
  },
  PlatformRegistryInstallResult
> = {
  name: "install_registry_server",
  title: "Install a registry card",
  description: INSTALL_NOT_CONNECT_DESCRIPTION,
  readOnly: false,
  risk: "exposure",
  permalink: derivePermalinks((result) => [
    {
      type: "project_server",
      id: result.serverId,
      label: `Open ${result.serverName}`,
    },
  ]),
  inputSchema: z.object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    registryServerId: z.string().trim().min(1),
    endpointUrl: z
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
      .optional()
      .describe(
        "Display-only: the card's endpoint, resolved at proposal time so the " +
          "approver can see it. The install always uses the card's own " +
          "transport; this field never chooses the endpoint."
      ),
    expectedUpdatedAt: z
      .number()
      .finite()
      .optional()
      .describe("Freshness pin from list_registry_servers.updatedAt."),
  }),
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const installed = await client.installRegistryServer(
      {
        projectId: project.id,
        registryServerId: input.registryServerId,
        expectedUpdatedAt: input.expectedUpdatedAt,
      },
      { signal }
    );
    return {
      ...installed,
      nextSteps: await nextStepsForInstall(
        client,
        project.id,
        installed.serverId,
        installed.outcome,
        signal
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
  permalink: noPermalink("mutation-only"),
  inputSchema: z.object({
    project: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(PROJECT_SELECTOR_DESCRIPTION),
    registryServerId: z.string().trim().min(1),
  }),
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    return client.uninstallRegistryServer(
      { projectId: project.id, registryServerId: input.registryServerId },
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
  cancelProjectServerConnectionOperation,
  diagnoseServerOperation,
  validateServerOperation,
  exportServerOperation,
  listServerToolsOperation,
  listServerPromptsOperation,
  listServerResourcesOperation,
  callServerToolOperation,
  renderServerWidgetOperation,
  getServerPromptOperation,
  readServerResourceOperation,
  listServerSkillsOperation,
  getServerSkillOperation,
  readServerSkillFileOperation,
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
  getEvalRunDisclosureOperation,
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
  waiveEvalGateOperation,
  getEvalGateWaiverOperation,
  revokeEvalGateWaiverOperation,
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
  sendChatMessageOperation,
  getChatSessionOperation,
  getChatSessionTraceOperation,
  listJourneysOperation,
  listJourneyRunsOperation,
  getJourneyRunOperation,
  listJourneyRunSessionsOperation,
  launchJourneyRunOperation,
  cancelJourneyRunOperation,
  publishScenarioOperation,
  unpublishScenarioOperation,
  // Clients. The deprecated `*_host` operations are deliberately NOT here —
  // see the note above them: every registered surface partitions this list, so
  // leaving them out is what guarantees no old name can be advertised or
  // persisted.
  listClientsOperation,
  getClientOperation,
  createClientOperation,
  updateClientOperation,
  deleteClientOperation,
  setClientServersOperation,
  duplicateClientOperation,
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
  listProjectSkillsOperation,
  getProjectSkillOperation,
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
  // PROJECT SECRETS. Write-only end to end — no operation here returns a value.
  // The two write ops carry one in their INPUT, which is why they are excluded
  // from the MCP catalog and the agent registry (see `platformTools.ts` and
  // `agent-op-registry.ts`) while staying reachable over HTTP, the SDK and the
  // CLI.
  listSecretsOperation,
  getSecretOperation,
  createSecretOperation,
  updateSecretOperation,
  deleteSecretOperation,
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
