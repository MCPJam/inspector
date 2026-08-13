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
  PlatformScenario,
  PlatformScenarioDeleted,
  PlatformEnvironmentCreateBody,
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
  PlatformServerConnection,
  PlatformServerConnectionCreateBody,
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

  // ── Server connections ───────────────────────────────────────────────────
  //
  // The handoff-first flow: creating a request may answer with a `handoffUrl`
  // the user must open, rather than with a finished connection. Callers poll
  // `getServerConnection` until the status is terminal.

  /**
   * Start connecting an MCP server URL to a project.
   *
   * The response is the ONLY place a `handoffUrl` ever appears — the raw token
   * behind it is minted once and never stored, so it cannot be re-fetched.
   * Treat it as a private, single-person capability.
   */
  createServerConnection(
    params: { body: PlatformServerConnectionCreateBody },
    options?: RequestOptions
  ): Promise<PlatformServerConnection> {
    return this.request(
      "POST",
      "/server-connections",
      { body: params.body },
      options
    );
  }

  /** Poll one request. Safe to call on a short interval: this path is metered
   * on its own poll budget rather than the shared per-caller one, so polling
   * responsively does not spend the budget your other calls need. A 429 here
   * means the interval itself is too fast — honour `Retry-After`. */
  getServerConnection(
    params: { connectionRequestId: string },
    options?: RequestOptions
  ): Promise<PlatformServerConnection> {
    return this.request(
      "GET",
      `/server-connections/${encodeURIComponent(params.connectionRequestId)}`,
      {},
      options
    );
  }

  cancelServerConnection(
    params: { connectionRequestId: string },
    options?: RequestOptions
  ): Promise<PlatformServerConnection> {
    return this.request(
      "POST",
      `/server-connections/${encodeURIComponent(params.connectionRequestId)}/cancel`,
      {},
      options
    );
  }

  /**
   * Ask for another validation attempt now instead of waiting out the backoff.
   *
   * Does not revive a terminal request: after `failed`, `expired`, or
   * `cancelled`, the way forward is a new request.
   */
  retryServerConnectionValidation(
    params: { connectionRequestId: string },
    options?: RequestOptions
  ): Promise<PlatformServerConnection> {
    return this.request(
      "POST",
      `/server-connections/${encodeURIComponent(params.connectionRequestId)}/retry-validation`,
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
   * `skillSelection`, or `pluginVersionIds` to CLEAR them; omitting a field
   * leaves it alone.
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

    // BOTH THE FETCH AND THE BODY READ ARE INSIDE THIS `try`, and that is the
    // point. Headers arriving is not the end of the request: a server can send
    // them and then stall the body indefinitely. Releasing the deadline and the
    // caller's signal at the end of the fetch — as this did — left
    // `response.text()` bounded by NOTHING. Not `timeoutMs`, which had just been
    // cleared; not the caller's abort, whose listener had just been removed. A
    // stalling server held the caller forever, and a Ctrl-C could not take it
    // back.
    let response: Response;
    let raw: string;
    try {
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
      }

      try {
        raw = await response.text();
      } catch (error) {
        // Same taxonomy as the fetch arm above, for the same reasons: a caller's
        // abort is theirs to see, and our own deadline is a TIMEOUT rather than
        // an unexplained read failure. Reporting a stalled body as
        // INTERNAL_ERROR sends someone looking for a bug on our side.
        if (externalSignal?.aborted) throw error;
        if (controller.signal.aborted) {
          throw new PlatformApiError(
            `Request to ${path} timed out after ${this.timeoutMs}ms`,
            "TIMEOUT",
            { status: 0, endpoint: path, cause: error }
          );
        }
        throw new PlatformApiError(
          `Failed to read the MCPJam API response (${response.status}) for ${path}`,
          "INTERNAL_ERROR",
          { status: response.status, endpoint: path, cause: error }
        );
      }
    } finally {
      clearTimeout(timeoutHandle);
      externalSignal?.removeEventListener("abort", onExternalAbort);
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
