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
  PlatformEnvironmentBuild,
  PlatformEnvironmentBuildStarted,
  PlatformEnvironmentDeleted,
  PlatformHost,
  PlatformHostDeleted,
  PlatformHostDetail,
  PlatformMe,
  PlatformPage,
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

type RequestOptions = {
  signal?: AbortSignal;
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
    params: { projectId: string; hostId: string; body: Record<string, unknown> },
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

  // ── Computer environments ────────────────────────────────────────────

  listEnvironments(
    params: { projectId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEnvironment>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(params.projectId)}/computer-environments`,
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
      )}/computer-environments/${encodeURIComponent(params.environmentId)}`,
      {},
      options
    );
  }

  createEnvironment(
    params: { projectId: string; body: { name: string; dockerfile: string } },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(params.projectId)}/computer-environments`,
      { body: params.body },
      options
    );
  }

  updateEnvironment(
    params: {
      projectId: string;
      environmentId: string;
      body: { name?: string; dockerfile?: string };
    },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "PATCH",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/computer-environments/${encodeURIComponent(params.environmentId)}`,
      { body: params.body },
      options
    );
  }

  deleteEnvironment(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformEnvironmentDeleted> {
    return this.request(
      "DELETE",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/computer-environments/${encodeURIComponent(params.environmentId)}`,
      {},
      options
    );
  }

  listEnvironmentBuilds(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformPage<PlatformEnvironmentBuild>> {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/computer-environments/${encodeURIComponent(
        params.environmentId
      )}/builds`,
      {},
      options
    );
  }

  /** `POST …/build` — async (202); poll `listEnvironmentBuilds` for status. */
  buildEnvironment(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformEnvironmentBuildStarted> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/computer-environments/${encodeURIComponent(
        params.environmentId
      )}/build`,
      {},
      options
    );
  }

  promoteEnvironment(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformEnvironment> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/computer-environments/${encodeURIComponent(
        params.environmentId
      )}/promote`,
      {},
      options
    );
  }

  /** Attach the environment to the caller's computer (re-provisions from the
   * pinned image). */
  useEnvironment(
    params: { projectId: string; environmentId: string },
    options?: RequestOptions
  ): Promise<PlatformComputerAttached> {
    return this.request(
      "POST",
      `/projects/${encodeURIComponent(
        params.projectId
      )}/computer-environments/${encodeURIComponent(params.environmentId)}/use`,
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
    method: "GET" | "POST" | "PATCH" | "DELETE",
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
