import { PlatformApiError } from "./errors.js";
import type {
  PlatformChatbox,
  PlatformChatboxDetail,
  PlatformChatSession,
  PlatformDoctorReport,
  PlatformEvalIteration,
  PlatformEvalRun,
  PlatformEvalRunCreated,
  PlatformEvalCase,
  PlatformEvalCaseDeleted,
  PlatformEvalCasesGenerated,
  PlatformEvalSuite,
  PlatformEvalSuiteCreated,
  PlatformEvalSuiteDeleted,
  PlatformEvalSuiteDetail,
  PlatformEvalStepResult,
  PlatformComputerAttached,
  PlatformComputerReset,
  PlatformEnvironment,
  PlatformJourney,
  PlatformJourneyRun,
  PlatformJourneyRunSession,
  PlatformJourneyRunCanceled,
  PlatformJourneyRunLaunched,
  PlatformCapabilities,
  PlatformFindingDismissed,
  PlatformGenerationDrafts,
  PlatformJourneyArchived,
  PlatformPersona,
  PlatformPersonaDeleted,
  PlatformRunScorecard,
  PlatformGuestExecution,
  PlatformScenario,
  PlatformUserTestingInsightsRequested,
  PlatformUserTestingScenario,
  PlatformUserTestingSession,
  PlatformUserTestingSessionDetail,
  PlatformSwarm,
  PlatformSwarmArchived,
  PlatformSwarmFinding,
  PlatformSwarmOverview,
  PlatformWaveInsights,
  PlatformWaveInsightsCanceled,
  PlatformWaveInsightsRequested,
  PlatformScenarioDeleted,
  PlatformEnvironmentCreateBody,
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
  PlatformMe,
  PlatformModel,
  PlatformPage,
  PlatformPlugin,
  PlatformPluginVersion,
  PlatformProject,
  PlatformProjectServer,
  PlatformTunnelClosed,
  PlatformTunnelGrant,
} from "./types.js";

export const DEFAULT_PLATFORM_API_BASE_URL = "https://app.mcpjam.com/api/v1";

export interface PlatformApiClientOptions {
  /** API origin + version prefix. Defaults to the hosted production API. */
  baseUrl?: string;
  /**
   * Returns the bearer credential for each request: an `sk_` API key or a
   * WorkOS user JWT. Called per request so rotating/refreshing credentials
   * stay current.
   */
  getAuth: () => string | Promise<string>;
  /** Injectable fetch for tests and exotic runtimes. */
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Optional User-Agent; ignored by browsers (forbidden header). */
  userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

type QueryParams = Record<string, string | number | undefined>;

/**
 * The cursor-pagination query the v1 read routes take. `undefined` entries are
 * dropped by `request`, so a first page sends neither param.
 */
function pageQuery(params: { cursor?: string; limit?: number }): QueryParams {
  return { cursor: params.cursor, limit: params.limit };
}

type RequestOptions = {
  signal?: AbortSignal;
  /** Stable retry key forwarded to write routes. */
  idempotencyKey?: string;
};

type ServerScope = {
  projectId: string;
  serverId: string;
};

/**
 * Minimal fetch-based client for the MCPJam Platform API. Runtime-agnostic
 * by construction (Workers/browser/Node): native fetch only, no Node
 * built-ins, no ambient environment reads — credentials and base URL are
 * injected. Tolerant reader: unknown response fields pass through untouched,
 * and empty success bodies (204) resolve to `undefined`.
 */
export class PlatformApiClient {
  private readonly baseUrl: string;
  private readonly getAuth: () => string | Promise<string>;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent?: string;

  constructor(options: PlatformApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_PLATFORM_API_BASE_URL).replace(
      /\/+$/,
      ""
    );
    this.getAuth = options.getAuth;
    // Native fetch must run with `this` bound to the global scope. Storing the
    // bare reference and calling it as `this.fetchFn(...)` rebinds `this` to the
    // client instance, which throws "Illegal invocation" in Workers/browsers.
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent;
  }

  getMe(options?: RequestOptions): Promise<PlatformMe> {
    return this.request("GET", "/me", {}, options);
  }

  listModels(options?: RequestOptions): Promise<PlatformPage<PlatformModel>> {
    return this.request("GET", "/models", {}, options);
  }

  listProjects(
    params: { organizationId?: string } = {},
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformProject>> {
    return this.request(
      "GET",
      "/projects",
      { query: { organizationId: params.organizationId } },
      options
    );
  }

  createProject(
    params: { body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformProject> {
    return this.request("POST", "/projects", { body: params.body }, options);
  }

  updateProject(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformProject> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(params.projectId)}`,
      { body: params.body },
      options
    );
  }

  deleteProject(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<{ id: string; deleted: boolean }> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(params.projectId)}`,
      {},
      options
    );
  }

  listProjectServers(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformProjectServer>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/servers`,
      {},
      options
    );
  }

  createProjectServer(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformProjectServer> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/servers`,
      { body: params.body },
      options
    );
  }

  getProjectServer(
    params: { projectId: string; serverId: string },
    options?: RequestOptions
  ): Promise<PlatformProjectServer> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/servers/${encodeURIComponent(params.serverId)}`,
      {},
      options
    );
  }

  updateProjectServer(
    params: {
      projectId: string;
      serverId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformProjectServer> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/servers/${encodeURIComponent(params.serverId)}`,
      { body: params.body },
      options
    );
  }

  deleteProjectServer(
    params: { projectId: string; serverId: string },
    options?: RequestOptions
  ): Promise<{ id: string; deleted: boolean }> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/servers/${encodeURIComponent(params.serverId)}`,
      { body: {} },
      options
    );
  }

  listEvalSuites(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalSuite>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/eval-suites`,
      {},
      options
    );
  }

  listChatSessions(
    params: {
      projectId?: string;
      status?: string;
      limit?: number;
      before?: string;
    } = {},
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformChatSession>> {
    return this.request(
      "GET",
      "/chat-sessions",
      {
        query: {
          projectId: params.projectId,
          status: params.status,
          limit: params.limit,
          before: params.before,
        },
      },
      options
    );
  }

  listChatboxes(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformChatbox>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/chatboxes`,
      {},
      options
    );
  }

  getChatbox(
    params: { projectId: string; chatboxId: string },
    options?: RequestOptions
  ): Promise<PlatformChatboxDetail> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/chatboxes/${encodeURIComponent(params.chatboxId)}`,
      {},
      options
    );
  }

  // ── Hosts ────────────────────────────────────────────────────────────

  listHosts(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformHost>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/hosts`,
      {},
      options
    );
  }

  getHost(
    params: { projectId: string; hostId: string },
    options?: RequestOptions
  ): Promise<PlatformHostDetail> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/hosts/${encodeURIComponent(params.hostId)}`,
      {},
      options
    );
  }

  /**
   * `POST /projects/{p}/hosts` — create a host either from a built-in template
   * (`{ name, template, theme? }`) or from a full host config
   * (`{ name, config }`). Returns the created host detail.
   */
  createHost(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformHostDetail> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/hosts`,
      { body: params.body },
      options
    );
  }

  updateHost(
    params: {
      projectId: string;
      hostId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformHostDetail> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/hosts/${encodeURIComponent(params.hostId)}`,
      { body: params.body },
      options
    );
  }

  setHostServers(
    params: {
      projectId: string;
      hostId: string;
      serverIds: string[];
      optionalServerIds?: string[];
    },
    options?: RequestOptions
  ): Promise<{ hostId: string; hostConfigId: string }> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/hosts/${encodeURIComponent(params.hostId)}/servers`,
      {
        body: {
          serverIds: params.serverIds,
          ...(params.optionalServerIds
            ? { optionalServerIds: params.optionalServerIds }
            : {}),
        },
      },
      options
    );
  }

  duplicateHost(
    params: { projectId: string; hostId: string; name?: string },
    options?: RequestOptions
  ): Promise<PlatformHostDetail> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/hosts/${encodeURIComponent(params.hostId)}/duplicate`,
      { body: params.name === undefined ? {} : { name: params.name } },
      options
    );
  }

  deleteHost(
    params: {
      projectId: string;
      hostId: string;
      body?: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformHostDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/hosts/${encodeURIComponent(params.hostId)}`,
      { body: params.body ?? {} },
      options
    );
  }

  // ── Project Environments ─────────────────────────────────────────────
  //
  // Named execution bundles (host + optional server group + optional pinned
  // skills/plugins) that eval suites and journeys run against. Distinct from
  // the sandbox images below.
  //
  // Reads need project membership; every write needs project ADMIN. All
  // mutations take the `expectedRevision` you last read — a stale value is a
  // 409 CONFLICT, never a silent overwrite.

  listEnvironments(
    params: { projectId: string; includeArchived?: boolean },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEnvironment>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/environments`,
      {
        query: params.includeArchived ? { includeArchived: "true" } : undefined,
      },
      options
    );
  }

  /**
   * What this deployment's environment surface supports.
   *
   * CALL THIS BEFORE SENDING `modelId`. The SDK ships independently of the
   * backend, and a field an older deployment does not know is a hard validator
   * error there rather than a silently ignored one. A deployment too old to
   * answer reports `false` for everything, which is the correct assumption.
   */
  getEnvironmentCapabilities(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformEnvironmentCapabilities> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/capabilities`,
      {},
      options
    );
  }

  getEnvironment(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}`,
      {},
      options
    );
  }

  /**
   * The launch preview: the host config, closed server set, and pinned plugin
   * versions this environment resolves to right now. A resolvable-today
   * failure (a disabled pinned plugin, an empty server set) is a 409 whose
   * `details.code` carries the specific `ENV_*` reason.
   */
  resolveEnvironment(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformEnvironmentResolved> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}/resolve`,
      {},
      options
    );
  }

  createEnvironment(
    params: { projectId: string; body: PlatformEnvironmentCreateBody },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/environments`,
      { body: params.body },
      options
    );
  }

  /**
   * Only the fields you pass change. Pass `null` for `serverAttachmentId`,
   * `modelId`, `skillSelection`, or `pluginVersionIds` to CLEAR them; omitting
   * a field leaves it alone.
   */
  updateEnvironment(
    params: {
      projectId: string;
      environmentId: string;
      body: PlatformEnvironmentUpdateBody;
    },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}`,
      { body: params.body },
      options
    );
  }

  /**
   * Archive (not delete): the row is kept and can be restored. Archiving frees
   * the name for a new live environment.
   */
  archiveEnvironment(
    params: {
      projectId: string;
      environmentId: string;
      expectedRevision: number;
    },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}/archive`,
      { body: { expectedRevision: params.expectedRevision } },
      options
    );
  }

  /**
   * Restore an archived environment. Fails with 409 if the name was taken
   * while it was archived. Plugin pins whose version rows no longer exist at
   * all are dropped — compare the returned `pluginVersionIds` against what you
   * archived to detect that.
   */
  restoreEnvironment(
    params: {
      projectId: string;
      environmentId: string;
      expectedRevision: number;
    },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}/restore`,
      { body: { expectedRevision: params.expectedRevision } },
      options
    );
  }

  // ── Agent Plugins ────────────────────────────────────────────────────
  //
  // Read-only: the live plugins installed in a project, and one imported
  // version's detail. Import/enable/disable/uninstall stay in the app.

  listProjectPlugins(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformPlugin>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/plugins`,
      {},
      options
    );
  }

  /**
   * One imported plugin version with its component projections. Addressed by
   * the version id alone — access is the version's own project membership,
   * and historical versions of uninstalled plugins stay readable (eval
   * snapshots and stale environment pins reference them).
   */
  getPluginVersion(
    params: { pluginVersionId: string },
    options?: RequestOptions
  ): Promise<PlatformPluginVersion> {
    return this.request(
      "GET",
      `/plugin-versions/${encodeURIComponent(params.pluginVersionId)}`,
      {},
      options
    );
  }

  // ── Sandbox images ───────────────────────────────────────────────────
  //
  // A project's custom Computer base images. "Image", not "environment": a
  // Project Environment is an unrelated concept and owns that word.

  listImages(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformImage>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/images`,
      {},
      options
    );
  }

  getImage(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformImage> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}`,
      {},
      options
    );
  }

  createImage(
    params: { projectId: string; body: { name: string; blueprint: string } },
    options?: RequestOptions
  ): Promise<PlatformImage> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/images`,
      { body: params.body },
      options
    );
  }

  updateImage(
    params: {
      projectId: string;
      imageId: string;
      body: { name?: string; blueprint?: string };
    },
    options?: RequestOptions
  ): Promise<PlatformImage> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}`,
      { body: params.body },
      options
    );
  }

  /** Lint blueprint YAML without saving it. Always resolves (200); an
   * invalid blueprint is a successful lint with structured errors. */
  validateImageBlueprint(
    params: { projectId: string; body: { blueprint: string } },
    options?: RequestOptions
  ): Promise<PlatformImageBlueprintValidation> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/images/validate`,
      { body: params.body },
      options
    );
  }

  deleteImage(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformImageDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}`,
      {},
      options
    );
  }

  listImageBuilds(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformImageBuild>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}/builds`,
      {},
      options
    );
  }

  /** `POST …/build` — async (202); poll `listImageBuilds` for status. */
  buildImage(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformImageBuildStarted> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}/build`,
      {},
      options
    );
  }

  promoteImage(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformImage> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}/promote`,
      {},
      options
    );
  }

  /** Attach the sandbox image to the caller's computer (re-provisions from the
   * pinned image). */
  useImage(
    params: { projectId: string; imageId: string },
    options?: RequestOptions
  ): Promise<PlatformComputerAttached> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/images/${encodeURIComponent(params.imageId)}/use`,
      {},
      options
    );
  }

  /** Reset the caller's computer to its image (wipes mutable state). */
  resetComputer(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformComputerReset> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/computer/reset`,
      {},
      options
    );
  }

  /**
   * `POST /projects/{p}/eval-runs` — validates and creates the run, then
   * detaches execution and responds 202. Poll `getEvalRun` until terminal.
   */
  createEvalRun(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformEvalRunCreated> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/eval-runs`,
      { body: params.body },
      options
    );
  }

  /**
   * `POST /projects/{p}/eval-suites` — author a runnable suite from test-case
   * definitions and return the new suite id. Synchronous (does NOT run the
   * suite; execute it with `createEvalRun`). The same path serves `GET` for
   * `listEvalSuites`.
   */
  createEvalSuite(
    params: { projectId: string; body: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteCreated> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/eval-suites`,
      { body: params.body },
      options
    );
  }

  getEvalRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalRun> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}`,
      {},
      options
    );
  }

  listEvalRunIterations(
    params: {
      projectId: string;
      runId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalIteration>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/iterations`,
      { query: { cursor: params.cursor, limit: params.limit } },
      options
    );
  }

  /** Full trace envelope (messages + analysis) for one iteration. */
  getEvalIterationTrace(
    params: { projectId: string; runId: string; iterationId: string },
    options?: RequestOptions
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(
        params.runId
      )}/iterations/${encodeURIComponent(params.iterationId)}/trace`,
      {},
      options
    );
  }

  /** Cancel an in-flight run; returns the run in its (now cancelled) state. */
  cancelEvalRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalRun> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(params.runId)}/cancel`,
      {},
      options
    );
  }

  /** One row per authored step (status + reason + evidence) for one iteration. */
  getEvalRunSteps(
    params: { projectId: string; runId: string; iterationId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalStepResult>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-runs/${encodeURIComponent(
        params.runId
      )}/iterations/${encodeURIComponent(params.iterationId)}/steps`,
      {},
      options
    );
  }

  listEvalSuiteRuns(
    params: { projectId: string; suiteId: string; limit?: number },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalRun>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/runs`,
      { query: { limit: params.limit } },
      options
    );
  }

  // ── Eval suite/case editing ──────────────────────────────────────────

  getEvalSuite(
    params: { projectId: string; suiteId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteDetail> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}`,
      {},
      options
    );
  }

  updateEvalSuite(
    params: {
      projectId: string;
      suiteId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteDetail> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}`,
      { body: params.body },
      options
    );
  }

  deleteEvalSuite(
    params: { projectId: string; suiteId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}`,
      {},
      options
    );
  }

  setEvalSuiteSchedule(
    params: {
      projectId: string;
      suiteId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalSuiteDetail> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/schedule`,
      { body: params.body },
      options
    );
  }

  listEvalCases(
    params: { projectId: string; suiteId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEvalCase>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/cases`,
      {},
      options
    );
  }

  getEvalCase(
    params: { projectId: string; suiteId: string; caseId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalCase> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(
        params.suiteId
      )}/cases/${encodeURIComponent(params.caseId)}`,
      {},
      options
    );
  }

  createEvalCase(
    params: {
      projectId: string;
      suiteId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalCase> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/cases`,
      { body: params.body },
      options
    );
  }

  updateEvalCase(
    params: {
      projectId: string;
      suiteId: string;
      caseId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalCase> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(
        params.suiteId
      )}/cases/${encodeURIComponent(params.caseId)}`,
      { body: params.body },
      options
    );
  }

  deleteEvalCase(
    params: { projectId: string; suiteId: string; caseId: string },
    options?: RequestOptions
  ): Promise<PlatformEvalCaseDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(
        params.suiteId
      )}/cases/${encodeURIComponent(params.caseId)}`,
      {},
      options
    );
  }

  generateEvalCases(
    params: {
      projectId: string;
      suiteId: string;
      body: Record<string, unknown>;
    },
    options?: RequestOptions
  ): Promise<PlatformEvalCasesGenerated> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/eval-suites/${encodeURIComponent(params.suiteId)}/cases/generate`,
      { body: params.body },
      options
    );
  }

  validateServer(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "validate", options);
  }

  doctorServer(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformDoctorReport> {
    return this.serverOp(params, "doctor", options);
  }

  exportServer(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "export", options);
  }

  listServerTools(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.serverOp(params, "tools", options);
  }

  listServerResources(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.serverOp(params, "resources", options);
  }

  listServerPrompts(
    params: ServerScope & { body?: Record<string, unknown> },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.serverOp(params, "prompts", options);
  }

  /**
   * `POST /projects/{p}/servers/{s}/tools/call` — execute one tool and return
   * the MCP CallToolResult. Tool-level failures (`isError: true`) are
   * successful calls; only transport/auth errors throw.
   */
  callServerTool(
    params: ServerScope & {
      body: { toolName: string; parameters?: Record<string, unknown> };
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "tools/call", options);
  }

  /** `POST /projects/{p}/servers/{s}/prompts/get` — render one prompt. */
  getServerPrompt(
    params: ServerScope & {
      body: {
        promptName: string;
        arguments?: Record<string, string | number | boolean>;
      };
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "prompts/get", options);
  }

  /** `POST /projects/{p}/servers/{s}/resources/read` — read one resource. */
  readServerResource(
    params: ServerScope & { body: { uri: string } },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.serverOp(params, "resources/read", options);
  }

  /**
   * `POST /projects/{p}/tunnels` — register (or revive) a relay tunnel for a
   * named project server and return the grant the caller hosts the tunnel
   * WebSocket with. Each call rotates the tunnel secret and revokes any
   * previous grant, so this is also the rotation path.
   */
  createTunnel(
    params: { projectId: string; name: string },
    options?: RequestOptions
  ): Promise<PlatformTunnelGrant> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/tunnels`,
      { body: { name: params.name } },
      options
    );
  }

  /**
   * `POST /projects/{p}/tunnels/{s}/close` — revoke the live tunnel grant.
   * The server record (and its slug) is kept so the tunnel revives on the
   * next `createTunnel`.
   */
  closeTunnel(
    params: { projectId: string; serverId: string },
    options?: RequestOptions
  ): Promise<PlatformTunnelClosed> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/tunnels/${encodeURIComponent(params.serverId)}/close`,
      {},
      options
    );
  }

  // ── Journeys (the Swarms product's API surface) ─────────────────────────
  //
  // Reads need project membership. LAUNCH and AUTHORING writes are behind the
  // `sandboxes-enabled` beta flag, enforced server-side per organization — an
  // unflagged caller gets FEATURE_UNAVAILABLE from those.
  //
  // `cancelJourneyRun` is NOT gated, deliberately: cancelling reduces exposure
  // and spend, so it has to keep working for an organization that has just lost
  // the flag with a run already in flight. Do not have callers pre-suppress it
  // on a flag check — losing access to the feature is exactly when stopping it
  // matters most.
  //
  // Every route is project-scoped in the PATH and re-checked server-side, so a
  // journey or run id belonging to another of your projects reads as 404
  // rather than crossing over.

  listJourneys(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformJourney>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/journeys`,
      {},
      options
    );
  }

  listJourneyRuns(
    params: {
      projectId: string;
      journeyId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformJourneyRun>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journeys/${encodeURIComponent(params.journeyId)}/runs`,
      { query: pageQuery(params) },
      options
    );
  }

  getJourneyRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformJourneyRun> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-runs/${encodeURIComponent(params.runId)}`,
      {},
      options
    );
  }

  listJourneyRunSessions(
    params: {
      projectId: string;
      runId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformJourneyRunSession>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-runs/${encodeURIComponent(params.runId)}/sessions`,
      { query: pageQuery(params) },
      options
    );
  }

  /**
   * Launch a journey. Returns as soon as the run exists — **202**, not a
   * finished run: a fan-out can take hours, so poll `getJourneyRun` or watch
   * `listJourneyRunSessions`.
   *
   * IDEMPOTENT ON `options.idempotencyKey`, and you want to pass one. A launch
   * spends model credits, so a retry after a dropped response must not run the
   * journey twice; replaying a key returns the ORIGINAL run with
   * `deduped: true`. Omit it and every call starts a new run — the server has
   * nothing to match a retry against, so it treats each as a new launch.
   *
   * Behind the `sandboxes-enabled` beta flag — launching creates exposure and
   * spend, so an unflagged organization gets a 403 here.
   */
  launchJourneyRun(
    params: {
      projectId: string;
      journeyId: string;
      waveId?: string;
      environmentIds?: string[];
    },
    options?: RequestOptions
  ): Promise<PlatformJourneyRunLaunched> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journeys/${encodeURIComponent(params.journeyId)}/runs`,
      {
        body: {
          ...(params.waveId ? { waveId: params.waveId } : {}),
          ...(params.environmentIds?.length
            ? { environmentIds: params.environmentIds }
            : {}),
        },
      },
      options
    );
  }

  /**
   * Stop a running journey run.
   *
   * Idempotent: cancelling an already-cancelled run succeeds with
   * `alreadyCanceled: true` rather than conflicting. A run that finished on
   * its own is a 409 — reporting success there would tell you that you stopped
   * something that had already completed.
   *
   * NOT behind the beta flag, unlike launching: stopping a run must keep
   * working for an organization that has lost it.
   */
  cancelJourneyRun(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformJourneyRunCanceled> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-runs/${encodeURIComponent(params.runId)}/cancel`,
      {},
      options
    );
  }

  // ── Personas, swarms, generation (Swarms authoring) ─────────────────────
  //
  // The half of the loop that was missing: `/api/v1` could launch a journey
  // and read its results but could not create one, because a journey needs a
  // persona and there was no way to make a persona outside the app.
  //
  // Creates and updates are behind the `sandboxes-enabled` beta flag. Reads
  // and the soft deletes are not — an org that has just lost the flag must
  // still be able to see and clean up what it authored.

  listPersonas(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformPersona>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/personas`,
      {},
      options
    );
  }

  getPersona(
    params: { projectId: string; personaId: string },
    options?: RequestOptions
  ): Promise<PlatformPersona> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/personas/${encodeURIComponent(params.personaId)}`,
      {},
      options
    );
  }

  /**
   * IDEMPOTENT ON `options.idempotencyKey`, and worth passing even though
   * creating a persona spends nothing: the server replays the key BEFORE it
   * uniquifies the slug, so a retry without one leaves you with a second,
   * near-identical persona named `…-2` rather than the row you already made.
   */
  createPersona(
    params: {
      projectId: string;
      name: string;
      role: string;
      notes?: string;
      avatarShape?: number;
      avatarPalette?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPersona> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/personas`,
      { body },
      options
    );
  }

  updatePersona(
    params: {
      projectId: string;
      personaId: string;
      name?: string;
      role?: string;
      notes?: string;
      avatarShape?: number;
      avatarPalette?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPersona> {
    const { projectId, personaId, ...body } = params;
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(projectId)}/personas/${encodeURIComponent(
        personaId
      )}`,
      { body },
      options
    );
  }

  /**
   * SOFT delete. The persona leaves the roster and cannot be used for new
   * journeys, but historical runs and sessions keep resolving it — a finished
   * run does not lose the character it ran as. A second call answers 404,
   * which cleanup should read as success.
   */
  deletePersona(
    params: { projectId: string; personaId: string },
    options?: RequestOptions
  ): Promise<PlatformPersonaDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/personas/${encodeURIComponent(params.personaId)}`,
      {},
      options
    );
  }

  getJourney(
    params: { projectId: string; journeyId: string },
    options?: RequestOptions
  ): Promise<PlatformJourney> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journeys/${encodeURIComponent(params.journeyId)}`,
      {},
      options
    );
  }

  /** IDEMPOTENT ON `options.idempotencyKey`. */
  createJourney(
    params: {
      projectId: string;
      goal: string;
      personaId: string;
      sessionsPerTarget: number;
      maxTurns: number;
      name?: string;
      swarmId?: string;
      environmentIds?: string[];
      serverAttachmentId?: string;
      hostIds?: string[];
    },
    options?: RequestOptions
  ): Promise<PlatformJourney> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/journeys`,
      { body },
      options
    );
  }

  /**
   * `null` CLEARS a field; omitting it leaves it alone. That tri-state is the
   * only way to say "stop fanning this journey out across environments".
   *
   * `sessionsPerTarget` and `maxTurns` must move together — they are one
   * config object upstream, so a partial update would need a read-modify-write
   * that could silently clobber a concurrent edit.
   */
  updateJourney(
    params: {
      projectId: string;
      journeyId: string;
      name?: string;
      goal?: string;
      environmentIds?: string[] | null;
      serverAttachmentId?: string | null;
      hostIds?: string[];
      sessionsPerTarget?: number;
      maxTurns?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformJourney> {
    const { projectId, journeyId, ...body } = params;
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(projectId)}/journeys/${encodeURIComponent(
        journeyId
      )}`,
      { body },
      options
    );
  }

  /**
   * ARCHIVES the journey. Its runs, sessions and scorecards stay readable —
   * deleting the results of work that already happened is not what anyone
   * means by removing a journey from their list.
   */
  archiveJourney(
    params: { projectId: string; journeyId: string },
    options?: RequestOptions
  ): Promise<PlatformJourneyArchived> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journeys/${encodeURIComponent(params.journeyId)}`,
      {},
      options
    );
  }

  listSwarms(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformSwarm>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/swarms`,
      {},
      options
    );
  }

  getSwarm(
    params: { projectId: string; swarmId: string },
    options?: RequestOptions
  ): Promise<PlatformSwarm> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/swarms/${encodeURIComponent(params.swarmId)}`,
      {},
      options
    );
  }

  /** IDEMPOTENT ON `options.idempotencyKey`. */
  createSwarm(
    params: {
      projectId: string;
      name: string;
      sessionsPerTarget: number;
      maxTurns: number;
      description?: string;
      environmentIds?: string[];
    },
    options?: RequestOptions
  ): Promise<PlatformSwarm> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/swarms`,
      { body },
      options
    );
  }

  updateSwarm(
    params: {
      projectId: string;
      swarmId: string;
      name?: string;
      description?: string | null;
      environmentIds?: string[] | null;
      sessionsPerTarget?: number;
      maxTurns?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformSwarm> {
    const { projectId, swarmId, ...body } = params;
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(projectId)}/swarms/${encodeURIComponent(
        swarmId
      )}`,
      { body },
      options
    );
  }

  /**
   * ARCHIVES the container. Journeys authored under it keep working and keep
   * their `swarmId` — the reference is authoring provenance, not ownership.
   */
  archiveSwarm(
    params: { projectId: string; swarmId: string },
    options?: RequestOptions
  ): Promise<PlatformSwarmArchived> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/swarms/${encodeURIComponent(params.swarmId)}`,
      {},
      options
    );
  }

  /**
   * Draft personas with an LLM. NOTHING IS SAVED — feed what you want to keep
   * to `createPersona`. That is also why there is no idempotency key: a call
   * with no effect has no duplicate to prevent, and offering one would imply
   * the drafts are stable across retries, which they are not.
   *
   * Exactly one grounding source: `serverAttachmentId` or `environmentId`.
   */
  generatePersonas(
    params: {
      projectId: string;
      serverAttachmentId?: string;
      environmentId?: string;
      journeyCount?: number;
      personaCount?: number;
      description?: string;
      existingPersonas?: Array<{ name: string; role: string }>;
    },
    options?: RequestOptions
  ): Promise<PlatformGenerationDrafts> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/personas/generate`,
      { body },
      options
    );
  }

  /**
   * Draft journeys for a persona. The persona is passed BY VALUE, not by id:
   * the create flow drafts a persona and its journeys before either exists,
   * so requiring a saved persona would force you to keep a draft you may
   * discard. Nothing is saved here either.
   */
  generateJourneys(
    params: {
      projectId: string;
      persona: { name: string; role: string; notes?: string };
      serverAttachmentId?: string;
      environmentId?: string;
      journeyCount?: number;
      description?: string;
    },
    options?: RequestOptions
  ): Promise<PlatformGenerationDrafts> {
    const { projectId, ...body } = params;
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/journeys/generate`,
      { body },
      options
    );
  }

  // ── Swarm insights ──────────────────────────────────────────────────────
  //
  // Three different kinds of evidence, deliberately not merged into one run
  // payload. The scorecard is deterministic and free; findings aggregate it
  // across waves; wave insights are LLM prose that SPENDS against the org's
  // shared daily ledger. Reach for the scorecard first — it is usually the
  // whole answer.

  getSwarmOverview(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformSwarmOverview> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/journeys-overview`,
      {},
      options
    );
  }

  getJourneyRunScorecard(
    params: { projectId: string; runId: string },
    options?: RequestOptions
  ): Promise<PlatformRunScorecard> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-runs/${encodeURIComponent(params.runId)}/scorecard`,
      {},
      options
    );
  }

  listSwarmFindings(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformSwarmFinding>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/journey-findings`,
      {},
      options
    );
  }

  dismissSwarmFinding(
    params: { projectId: string; findingId: string },
    options?: RequestOptions
  ): Promise<PlatformFindingDismissed> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-findings/${encodeURIComponent(params.findingId)}/dismiss`,
      {},
      options
    );
  }

  undismissSwarmFinding(
    params: { projectId: string; findingId: string },
    options?: RequestOptions
  ): Promise<PlatformFindingDismissed> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/journey-findings/${encodeURIComponent(params.findingId)}/undismiss`,
      {},
      options
    );
  }

  getWaveInsights(
    params: { projectId: string; waveId: string },
    options?: RequestOptions
  ): Promise<PlatformWaveInsights> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/waves/${encodeURIComponent(params.waveId)}/insights`,
      {},
      options
    );
  }

  /**
   * Request an LLM pass over a wave. Answers **202** — generation is
   * scheduled, not done; poll `getWaveInsights`.
   *
   * SPENDS against the org's `insightsPerDay` ledger, which is SHARED with
   * user-testing window insights. `force` regenerates over a wave that already
   * has insights and spends again; the usual reason to reach for it is a
   * caller that did not poll.
   */
  requestWaveInsights(
    params: { projectId: string; waveId: string; force?: boolean },
    options?: RequestOptions
  ): Promise<PlatformWaveInsightsRequested> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/waves/${encodeURIComponent(params.waveId)}/insights`,
      { body: params.force ? { force: true } : {} },
      options
    );
  }

  /**
   * Cancel an in-flight generation. The recovery path when a request was made
   * by mistake or its runner went silent — without it a wave stuck `pending`
   * can only be re-requested with `force`, which spends again.
   */
  cancelWaveInsights(
    params: { projectId: string; waveId: string },
    options?: RequestOptions
  ): Promise<PlatformWaveInsightsCanceled> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/waves/${encodeURIComponent(params.waveId)}/insights`,
      {},
      options
    );
  }

  /**
   * What this caller may do in the project — role, beta-gate state, plan
   * limits, and the derived booleans to branch on.
   *
   * Ask this BEFORE planning work on a static surface (MCP catalog, CLI, agent
   * registry), none of which can advertise a per-organization beta. It is
   * descriptive: the write paths enforce independently, so a stale answer
   * costs a clean 403 rather than an incorrect success.
   */
  getCapabilities(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformCapabilities> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/capabilities`,
      {},
      options
    );
  }

  // ── Scenarios (user testing) ────────────────────────────────────────────
  //
  // Both require project ADMIN. Publishing is additionally behind the
  // `sandboxes-enabled` beta flag; UNPUBLISHING deliberately is not, so an org
  // that loses the flag can still take a live scenario down.

  publishScenario(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformScenario> {
    return this.request(
      "PUT",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}/scenario`,
      {},
      options
    );
  }

  unpublishScenario(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformScenarioDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/environments/${encodeURIComponent(params.environmentId)}/scenario`,
      {},
      options
    );
  }

  // ── User testing ────────────────────────────────────────────────────────
  //
  // What a published scenario produced, and who may reach it. `publishScenario`
  // above creates one (keyed by environment, because the scenario does not
  // exist yet); everything here is keyed by the scenario.
  //
  // AUTHORIZATION DIFFERS from the rest of this client: these gate on the
  // WORKSPACE role rather than the project role, and the exposure controls
  // (guest execution, link rotation, rebinding) need project ADMIN. A legacy
  // workspace with no organization hard-denies delegated (`sk_`) callers
  // entirely — a documented limitation, not a bug you can grant your way out
  // of.

  /**
   * Publish an environment as a scenario.
   *
   * `name`, `description` and `mode` are CREATE-TIME overrides applied in the
   * same call, so the scenario is never briefly live in a wider mode than you
   * asked for. They are ignored on a republish (the response says
   * `overridesIgnored: true`), because re-applying `mode` would let a routine
   * idempotent publish widen a scenario someone had narrowed by hand.
   */
  publishUserTestingScenario(
    params: {
      projectId: string;
      environmentId: string;
      name?: string;
      description?: string;
      mode?: "project_members" | "invited_only" | "anyone_with_link";
    },
    options?: RequestOptions
  ): Promise<PlatformScenario & { overridesIgnored?: boolean }> {
    const { projectId, environmentId, ...body } = params;
    return this.request(
      "PUT",
      `/projects/${encodeURIComponent(
        projectId
      )}/environments/${encodeURIComponent(environmentId)}/scenario`,
      { body },
      options
    );
  }

  /**
   * Edit a scenario. SINGLE-CONCERN: send `mode` on its own, or `name` and
   * `description` together — never both. Identity and exposure are separate
   * mutations upstream, so a mixed request would have to apply them in
   * sequence, and a failure between the two leaves the scenario half-updated
   * on the half that decides who can reach it.
   */
  updateUserTestingScenario(
    params: {
      projectId: string;
      scenarioId: string;
      name?: string;
      description?: string;
      mode?: "project_members" | "invited_only" | "anyone_with_link";
    },
    options?: RequestOptions
  ): Promise<PlatformUserTestingScenario> {
    const { projectId, scenarioId, ...body } = params;
    return this.request(
      "PATCH",
      this.userTestingPath(projectId, scenarioId),
      { body },
      options
    );
  }

  /** Session SUMMARIES. Transcripts are a separate, explicit read. */
  listUserTestingSessions(
    params: {
      projectId: string;
      scenarioId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformUserTestingSession>> {
    return this.request(
      "GET",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/sessions`,
      { query: pageQuery(params) },
      options
    );
  }

  /**
   * One session's transcript, PAGED and projected to role + text + timing.
   *
   * These are real people's conversations with your product. The API never
   * hands back the stored blob URL, so a caller cannot pass "read this
   * transcript" onward as an unrevocable capability.
   */
  getUserTestingSession(
    params: {
      projectId: string;
      scenarioId: string;
      sessionId: string;
      cursor?: string;
      limit?: number;
    },
    options?: RequestOptions
  ): Promise<PlatformUserTestingSessionDetail> {
    return this.request(
      "GET",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/sessions/${encodeURIComponent(params.sessionId)}`,
      { query: pageQuery(params) },
      options
    );
  }

  getUserTestingMetrics(
    params: { projectId: string; scenarioId: string; population?: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/metrics`,
      {
        query: params.population ? { population: params.population } : {},
      },
      options
    );
  }

  /**
   * Usage breakdown. Read `scan.truncated` before quoting any rate from this:
   * true means the rates were computed over the most recent N sessions rather
   * than all of them, and dropping the flag turns a conditional statistic into
   * an unconditional claim.
   */
  getUserTestingUsage(
    params: { projectId: string; scenarioId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/usage`,
      {},
      options
    );
  }

  listUserTestingFindings(
    params: { projectId: string; scenarioId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<Record<string, unknown>>> {
    return this.request(
      "GET",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/findings`,
      {},
      options
    );
  }

  /** Also how you learn the CURRENT window id, which the insights read takes. */
  getUserTestingSignals(
    params: { projectId: string; scenarioId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/signals`,
      {},
      options
    );
  }

  getUserTestingInsights(
    params: { projectId: string; scenarioId: string; windowId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/windows/${encodeURIComponent(params.windowId)}/insights`,
      {},
      options
    );
  }

  /**
   * Ask a model to analyze the scenario's current window. **202** — scheduled,
   * not done. SPENDS against the organization's daily insights budget, which
   * is SHARED with swarm wave insights.
   */
  requestUserTestingInsights(
    params: { projectId: string; scenarioId: string; force?: boolean },
    options?: RequestOptions
  ): Promise<PlatformUserTestingInsightsRequested> {
    return this.request(
      "POST",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/insights`,
      { body: params.force ? { force: true } : {} },
      options
    );
  }

  cancelUserTestingInsights(
    params: { projectId: string; scenarioId: string; windowId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/insights`,
      { body: { windowId: params.windowId } },
      options
    );
  }

  dismissUserTestingFinding(
    params: { projectId: string; scenarioId: string; findingId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.userTestingFindingAction(params, "dismiss", options);
  }

  undismissUserTestingFinding(
    params: { projectId: string; scenarioId: string; findingId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.userTestingFindingAction(params, "undismiss", options);
  }

  /**
   * Replace the guest-execution caps.
   *
   * A full replacement, not a patch: these only mean something as a SET, and
   * raising one while leaving a stale sibling behind produces a combination
   * nobody chose. Project ADMIN.
   */
  setUserTestingGuestExecution(
    params: {
      projectId: string;
      scenarioId: string;
      guestExecution: PlatformGuestExecution;
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "PUT",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/guest-execution`,
      { body: params.guestExecution },
      options
    );
  }

  /**
   * Rotate the share link. DESTRUCTIVE and immediate: the old link stops
   * working and every session on it dies. There is no rotating back.
   */
  rotateUserTestingLink(
    params: { projectId: string; scenarioId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/rotate-link`,
      {},
      options
    );
  }

  /** Upsert by email, so re-inviting someone is not an error. */
  upsertUserTestingMember(
    params: {
      projectId: string;
      scenarioId: string;
      email: string;
      sendInviteEmail?: boolean;
    },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    const { projectId, scenarioId, ...body } = params;
    return this.request(
      "PUT",
      `${this.userTestingPath(projectId, scenarioId)}/members`,
      { body },
      options
    );
  }

  removeUserTestingMember(
    params: { projectId: string; scenarioId: string; member: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "DELETE",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/members/${encodeURIComponent(params.member)}`,
      {},
      options
    );
  }

  /**
   * Point a scenario at a DIFFERENT environment, keeping its link, members and
   * session history. The alternative — unpublish and republish — mints a new
   * link, which means re-sharing it with everyone who had the old one.
   */
  rebindUserTestingScenario(
    params: { projectId: string; scenarioId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `${this.userTestingPath(params.projectId, params.scenarioId)}/rebind`,
      { body: { environmentId: params.environmentId } },
      options
    );
  }

  private userTestingPath(projectId: string, scenarioId: string): string {
    return `/projects/${encodeURIComponent(
      projectId
    )}/user-testing/scenarios/${encodeURIComponent(scenarioId)}`;
  }

  private userTestingFindingAction(
    params: { projectId: string; scenarioId: string; findingId: string },
    action: "dismiss" | "undismiss",
    options?: RequestOptions
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `${this.userTestingPath(
        params.projectId,
        params.scenarioId
      )}/findings/${encodeURIComponent(params.findingId)}/${action}`,
      {},
      options
    );
  }

  private serverOp<T>(
    params: ServerScope & { body?: Record<string, unknown> },
    op: string,
    options?: RequestOptions
  ): Promise<T> {
    const path = `/projects/${encodeURIComponent(
      params.projectId
    )}/servers/${encodeURIComponent(params.serverId)}/${op}`;
    return this.request("POST", path, { body: params.body ?? {} }, options);
  }

  private async request<T>(
    // PUT is here for idempotent creates — `publishScenario` is the first:
    // publishing an environment that is already published returns the existing
    // scenario rather than minting a second, which is PUT's semantics and not
    // POST's.
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    init: { query?: QueryParams; body?: unknown },
    options?: RequestOptions
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.getAuth()}`,
    };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.userAgent) {
      headers["user-agent"] = this.userAgent;
    }
    if (options?.idempotencyKey) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    const controller = new AbortController();
    const externalSignal = options?.signal;
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, {
          once: true,
        });
      }
    }
    const timeoutHandle = setTimeout(
      () =>
        controller.abort(
          new Error(`Request timed out after ${this.timeoutMs}ms`)
        ),
      this.timeoutMs
    );

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (externalSignal?.aborted) {
        // Caller-initiated abort: propagate, don't dress it up as an API error.
        throw error;
      }
      const aborted = controller.signal.aborted;
      throw new PlatformApiError(
        aborted
          ? `Request to ${path} timed out after ${this.timeoutMs}ms`
          : `Failed to reach the MCPJam API at ${url.origin}: ${errorMessage(
              error
            )}`,
        aborted ? "TIMEOUT" : "NETWORK_ERROR",
        { status: 0, endpoint: path, cause: error }
      );
    } finally {
      clearTimeout(timeoutHandle);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw new PlatformApiError(
        `Failed to read the MCPJam API response (${response.status}) for ${path}`,
        "INTERNAL_ERROR",
        { status: response.status, endpoint: path, cause: error }
      );
    }

    let parsed: unknown;
    let parseError: unknown;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        parseError = error;
      }
    }

    if (!response.ok) {
      // Empty and non-JSON error bodies (bare 429s, proxy HTML) still map to
      // a PlatformApiError keyed off the status, with Retry-After preserved.
      throw this.toApiError(response, parsed, path);
    }

    if (parseError !== undefined) {
      throw new PlatformApiError(
        `The MCPJam API returned a non-JSON response (${response.status}) for ${path}`,
        "INTERNAL_ERROR",
        { status: response.status, endpoint: path, cause: parseError }
      );
    }

    // Empty success bodies (204 / no content) resolve to undefined.
    return parsed as T;
  }

  private toApiError(
    response: Response,
    body: unknown,
    path: string
  ): PlatformApiError {
    const envelope =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { code?: unknown; message?: unknown; details?: unknown })
        : undefined;
    const code =
      typeof envelope?.code === "string" && envelope.code.length > 0
        ? envelope.code
        : fallbackCodeForStatus(response.status);
    const message =
      typeof envelope?.message === "string" && envelope.message.length > 0
        ? envelope.message
        : `Request to ${path} failed (${response.status})`;
    const details =
      envelope?.details &&
      typeof envelope.details === "object" &&
      !Array.isArray(envelope.details)
        ? (envelope.details as Record<string, unknown>)
        : undefined;

    return new PlatformApiError(message, code, {
      status: response.status,
      details,
      retryAfter: parseRetryAfter(response.headers.get("retry-after")),
      endpoint: path,
    });
  }
}

// Wire codes assumed when an error response carries no `{ code }` envelope
// (empty bodies, upstream proxy HTML). Statuses without an unambiguous v1
// code fall back to INTERNAL_ERROR.
const STATUS_FALLBACK_CODES: Record<number, string> = {
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  429: "RATE_LIMITED",
};

function fallbackCodeForStatus(status: number): string {
  return STATUS_FALLBACK_CODES[status] ?? "INTERNAL_ERROR";
}

function parseRetryAfter(
  header: string | null,
  now: number = Date.now()
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  // RFC 9110 also allows an HTTP-date form.
  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
